/**
 * LINE Webhook Service
 * 
 * 核心功能：
 * 1. 接收 LINE Webhook 事件
 * 2. 側錄所有對話到 MySQL
 * 3. 條件觸發自動回覆（關鍵字 + RAG）
 * 4. 學習 Owner 語氣
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const winston = require('winston');
const { mysql, pool, query, initTables } = require('./db');
const { searchSimilar, addDocument } = require('./rag');
const { generateReply, analyzeOwnerStyle } = require('./llm');
const {
    getRecentConversation,
    getUserMemory,
    formatUserMemoryForPrompt,
    scheduleMemoryUpdate,
    suggestLearning,
    getPendingLearning,
    reviewLearning,
    getApprovedKnowledge,
    MEMORY_CONFIG
} = require('./memory');

// ============================================
// Logger 設定
// ============================================
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: '/app/logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: '/app/logs/combined.log' })
    ]
});

// ============================================
// Express App 設定
// ============================================
const app = express();
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString('utf8');
    }
}));

// 設定
const CONFIG = {
    PORT: process.env.PORT || 3000,
    CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET,
    // 支援多個 Owner，逗號分隔
    OWNER_USER_IDS: (process.env.OWNER_USER_IDS || process.env.OWNER_USER_ID || '').split(',').map(id => id.trim()).filter(id => id),
    AUTO_REPLY_KEYWORDS: (process.env.AUTO_REPLY_KEYWORDS || '問,查詢,help').split(','),
    OWNER_RESPONSE_TIMEOUT: parseInt(process.env.OWNER_RESPONSE_TIMEOUT || '5') * 60 * 1000, // 轉毫秒
};

// 檢查是否為 Owner 的輔助函數
function isOwner(userId) {
    return CONFIG.OWNER_USER_IDS.includes(userId);
}

// ============================================
// LINE API 工具函數
// ============================================

/**
 * 驗證 LINE Webhook Signature
 * @param {string} body - 原始請求 body
 * @param {string} signature - X-Line-Signature header
 */
function validateSignature(body, signature) {
    const hash = crypto
        .createHmac('sha256', CONFIG.CHANNEL_SECRET)
        .update(body)
        .digest('base64');
    return signature === hash;
}

/**
 * 發送 LINE 訊息
 * @param {string} userId - 目標用戶 ID
 * @param {string|object} message - 訊息內容
 */
async function replyMessage(replyToken, message) {
    try {
        const messages = typeof message === 'string' 
            ? [{ type: 'text', text: message }]
            : Array.isArray(message) ? message : [message];

        await axios.post('https://api.line.me/v2/bot/message/reply', {
            replyToken,
            messages
        }, {
            headers: {
                'Authorization': `Bearer ${CONFIG.CHANNEL_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        logger.info('Message replied successfully');
    } catch (error) {
        logger.error('Failed to reply message:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * 取得用戶資料
 */
async function getUserProfile(userId) {
    try {
        const response = await axios.get(`https://api.line.me/v2/bot/profile/${userId}`, {
            headers: { 'Authorization': `Bearer ${CONFIG.CHANNEL_ACCESS_TOKEN}` }
        });
        return response.data;
    } catch (error) {
        logger.error('Failed to get user profile:', error.message);
        return null;
    }
}

// ============================================
// 資料庫操作
// ============================================

/**
 * 儲存或更新用戶資料
 */
async function saveUser(userId, profile, isOwner = false) {
    const sql = `
        INSERT INTO t_users (user_id, display_name, picture_url, status_message, is_owner)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            display_name = VALUES(display_name),
            picture_url = VALUES(picture_url),
            status_message = VALUES(status_message),
            is_owner = VALUES(is_owner),
            update_time = CURRENT_TIMESTAMP
    `;
    await mysql.query(sql, [
        userId,
        profile?.displayName || null,
        profile?.pictureUrl || null,
        profile?.statusMessage || null,
        isOwner
    ]);
}

/**
 * 儲存訊息
 */
async function saveMessage(event, isAutoReply = false) {
    const sql = `
        INSERT INTO t_messages (
            message_id, user_id, chat_type, chat_id, reply_to_message_id,
            message_type, content, is_owner, is_auto_reply
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const isOwnerUser = isOwner(event.source.userId);
    
    await mysql.query(sql, [
        event.message?.id || null,
        event.source.userId,
        event.source.type,
        event.source.groupId || event.source.roomId || event.source.userId,
        event.message?.quoteToken || null,
        event.message?.type || 'unknown',
        event.message?.text || null,
        isOwnerUser,
        isAutoReply
    ]);
    
    return isOwnerUser;
}

/**
 * 檢查 Owner 是否在時間內有回覆
 */
async function hasOwnerRepliedRecently(chatId, since) {
    const sql = `
        SELECT COUNT(*) as count FROM t_messages
        WHERE chat_id = ? AND is_owner = TRUE AND create_time > ?
    `;
    const result = await mysql.query(sql, [chatId, new Date(Date.now() - since)]);
    return result[0].count > 0;
}

/**
 * 取得 Owner 的語氣特徵
 * 支援多個 Owner，返回第一個有資料的（或合併分析）
 */
async function getOwnerStyle() {
    // 如果有多個 Owner，取第一個的風格資料
    // 或者可以改為合併分析所有 Owner 的風格
    const firstOwnerId = CONFIG.OWNER_USER_IDS[0];
    if (!firstOwnerId) return null;
    
    const sql = `SELECT * FROM t_owner_style WHERE user_id = ?`;
    const result = await mysql.query(sql, [firstOwnerId]);
    return result[0] || null;
}

/**
 * 儲存自動回覆記錄
 */
async function saveAutoReply(data) {
    const sql = `
        INSERT INTO t_auto_replies (
            user_id, trigger_keyword, trigger_reason, user_question,
            rag_context, generated_reply, final_reply, retrieval_time_ms, generation_time_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await mysql.query(sql, [
        data.userId,
        data.triggerKeyword,
        data.triggerReason,
        data.userQuestion,
        JSON.stringify(data.ragContext),
        data.generatedReply,
        data.finalReply,
        data.retrievalTimeMs,
        data.generationTimeMs
    ]);
}

// ============================================
// Chat 模式管理
// ============================================

/**
 * 取得 chat 的模式
 * @param {string} chatId - Chat ID
 * @returns {string} 'auto' | 'manual'
 */
async function getChatMode(chatId) {
    try {
        const result = await mysql.query(
            'SELECT mode FROM t_chat_modes WHERE chat_id = ?',
            [chatId]
        );
        return result[0]?.mode || 'auto'; // 預設 auto
    } catch (error) {
        logger.error('Failed to get chat mode:', error);
        return 'auto';
    }
}

/**
 * 設定 chat 的模式
 * @param {string} chatId - Chat ID
 * @param {string} mode - 'auto' | 'manual'
 * @param {string} userId - 操作者 ID
 */
async function setChatMode(chatId, mode, userId) {
    await mysql.query(`
        INSERT INTO t_chat_modes (chat_id, mode, updated_by)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE mode = VALUES(mode), updated_by = VALUES(updated_by)
    `, [chatId, mode, userId]);
    logger.info(`Chat mode changed: ${chatId} -> ${mode} by ${userId}`);
}

// ============================================
// 核心邏輯
// ============================================

/**
 * 取得機器人的 LINE User ID
 * 透過 LINE API 取得機器人自己的 Profile
 */
let BOT_USER_ID = null;

async function getBotUserId() {
    if (BOT_USER_ID) return BOT_USER_ID;
    
    try {
        const response = await axios.get('https://api.line.me/v2/bot/info', {
            headers: { 'Authorization': `Bearer ${CONFIG.CHANNEL_ACCESS_TOKEN}` }
        });
        BOT_USER_ID = response.data.userId;
        logger.info(`Bot User ID: ${BOT_USER_ID}`);
        return BOT_USER_ID;
    } catch (error) {
        logger.error('Failed to get bot user ID:', error.message);
        return null;
    }
}

/**
 * 檢查訊息是否 @提到了機器人
 * 
 * @param {object} event - LINE 事件物件
 * @param {string} userMessage - 用戶訊息文字
 * @returns {boolean} 是否有 @提及
 */
async function isBotMentioned(event, userMessage) {
    const botUserId = await getBotUserId();
    if (!botUserId) return false;
    
    // 1. 檢查 LINE mention 功能（精確的 @提及）
    const mentions = event.message?.mention?.mentionees || [];
    const isMentioned = mentions.some(m => m.userId === botUserId);
    if (isMentioned) return true;
    
    // 2. 檢查訊息文字中是否包含 @機器人名稱
    //    支援多種格式：@席爾克軟體、@席爾克、@bot
    const mentionPatterns = [
        /@席爾克軟體/i,
        /@席爾克/i,
        /@bot/i,
        /@客服/i
    ];
    
    return mentionPatterns.some(pattern => pattern.test(userMessage));
}

/**
 * 判斷是否應該觸發自動回覆
 * 
 * 規則：
 * - 群組/聊天室：只在 @提及 時回覆
 * - 1-on-1 對話：根據 /auto, /manual 模式決定
 */
async function shouldAutoReply(event, userMessage) {
    const chatType = event.source.type; // 'user', 'group', 'room'
    const chatId = event.source.groupId || event.source.roomId || event.source.userId;
    
    // 1. 如果是 Owner 發的訊息，不回覆（Owner 可以用指令控制）
    if (isOwner(event.source.userId)) {
        return { shouldReply: false, reason: 'owner_message' };
    }
    
    // 2. 群組/聊天室環境：只在被 @提及 時回覆
    if (chatType === 'group' || chatType === 'room') {
        const isMentioned = await isBotMentioned(event, userMessage);
        
        if (!isMentioned) {
            return { shouldReply: false, reason: 'not_mentioned_in_group' };
        }
        
        return { 
            shouldReply: true, 
            reason: 'mentioned_in_group' 
        };
    }
    
    // 3. 1-on-1 對話環境：根據 auto/manual 模式決定
    const chatMode = await getChatMode(chatId);
    
    if (chatMode === 'manual') {
        return { shouldReply: false, reason: 'manual_mode' };
    }
    
    // auto 模式下，回覆所有訊息
    return { 
        shouldReply: true, 
        reason: 'auto_mode'
    };
}

/**
 * 處理自動回覆（整合三層記憶系統）
 */
async function handleAutoReply(event, userMessage, replyToken, replyDecision) {
    const startTime = Date.now();
    const chatId = event.source.groupId || event.source.roomId || event.source.userId;
    const userId = event.source.userId;
    
    try {
        logger.info(`Auto-reply triggered for: ${userMessage.substring(0, 50)}...`);
        
        // 1. 第 1 層：取得短期對話上下文
        const conversationHistory = await getRecentConversation(chatId, userId);
        logger.info(`Context: ${conversationHistory.length} messages loaded`);
        
        // 2. 第 2 層：取得用戶記憶摘要
        const userMemory = await getUserMemory(userId);
        const userMemoryText = formatUserMemoryForPrompt(userMemory);
        if (userMemory) {
            logger.info(`User memory loaded for ${userId}: ${userMemory.status}`);
        }
        
        // 3. 第 3 層：RAG 檢索
        const retrievalStart = Date.now();
        const ragResults = await searchSimilar(userMessage, 5);
        const retrievalTime = Date.now() - retrievalStart;
        logger.info(`RAG retrieved ${ragResults.length} results in ${retrievalTime}ms`);
        
        // 4. 取得已審核通過的學習知識，補充 RAG
        const learnedKnowledge = await getApprovedKnowledge();
        
        // 5. 取得 Owner 語氣
        const ownerStyle = await getOwnerStyle();
        
        // 6. 生成回覆（帶入三層記憶）
        const generationStart = Date.now();
        const reply = await generateReply(
            userMessage,
            ragResults,
            ownerStyle,
            {
                conversationHistory,
                userMemoryText,
                learnedKnowledge
            }
        );
        const generationTime = Date.now() - generationStart;
        
        // 7. 發送回覆
        await replyMessage(replyToken, reply);
        
        // 8. 記錄到資料庫
        await saveAutoReply({
            userId: userId,
            triggerKeyword: event.triggerInfo?.keyword || null,
            triggerReason: replyDecision?.reason || 'auto_mode',
            userQuestion: userMessage,
            ragContext: ragResults,
            generatedReply: reply,
            finalReply: reply,
            retrievalTimeMs: retrievalTime,
            generationTimeMs: generationTime
        });
        
        // 9. 排程記憶更新（30 分鐘無互動後觸發）
        const profile = await getUserProfile(userId);
        scheduleMemoryUpdate(chatId, userId, profile?.displayName);
        
        logger.info(`Auto-reply completed in ${Date.now() - startTime}ms`);
        
    } catch (error) {
        logger.error('Auto-reply failed:', error);
        await replyMessage(replyToken, '抱歉，我暫時無法處理您的問題，請稍後再試或直接聯繫我們。');
    }
}

// ============================================
// Webhook 處理
// ============================================

/**
 * 處理 Message 事件
 */
async function handleMessageEvent(event) {
    const userMessage = event.message?.text || '';
    const senderId = event.source.userId;
    const isOwnerUser = isOwner(senderId);
    const chatId = event.source.groupId || event.source.roomId || event.source.userId;
    
    logger.info(`Message from ${isOwnerUser ? 'OWNER' : 'user'} (${senderId}): ${userMessage.substring(0, 100)}`);
    
    // 1. 儲存訊息到資料庫
    await saveMessage(event);
    
    // 2. 處理指令（所有用戶都可以使用 /help，其他指令僅限 Owner）
    if (event.replyToken) {
        const trimmedMsg = userMessage.trim().toLowerCase();
        
        // /help 指令 - 所有人都可以使用
        if (trimmedMsg === '/help') {
            const isGroup = event.source.type === 'group' || event.source.type === 'room';
            const helpMessage = isGroup 
                ? `🤖 席爾克軟體智能助理使用說明

📍 群組模式：
在群組中，請 @提到我 我才會回覆喔！

📌 可用的 @提及 格式：
• @席爾克軟體
• @席爾克
• @bot（簡短方便！）
• @客服

📝 其他指令：
/help - 顯示此說明

💡 小提示：
如果是私下 1-on-1 對話，我可以自動回覆您的問題！`
                : `🤖 席爾克軟體智能助理使用說明

📍 1-on-1 對話模式：
您可以直接發問，我會自動回覆！

📝 可用指令：
/auto - 開啟自動回覆（預設）
/manual - 關閉自動回覆（改由人工處理）
/status - 查詢目前模式
/help - 顯示此說明

💡 小提示：
如果需要轉接人工服務，請發送 /manual`;
            
            await replyMessage(event.replyToken, helpMessage);
            return;
        }
        
        // 以下指令僅限 Owner 使用
        if (isOwnerUser) {
            if (trimmedMsg === '/auto') {
                await setChatMode(chatId, 'auto', event.source.userId);
                await replyMessage(event.replyToken, '✅ 已切換為自動回覆模式\nBot 將自動回覆用戶訊息。');
                return;
            }
            
            if (trimmedMsg === '/manual') {
                await setChatMode(chatId, 'manual', event.source.userId);
                await replyMessage(event.replyToken, '✅ 已切換為手動模式\nBot 將不會自動回覆，由您親自處理。');
                return;
            }
            
            if (trimmedMsg === '/status') {
                const currentMode = await getChatMode(chatId);
                const pendingCount = await getPendingLearning(1);
                const pendingText = pendingCount.length > 0 ? `\n📚 有待審核的學習建議，請用 /review 查看` : '';
                await replyMessage(event.replyToken, `📊 目前模式：${currentMode === 'auto' ? '自動回覆 🤖' : '手動模式 👤'}${pendingText}\n\n可用指令：\n/auto - 自動回覆\n/manual - 手動模式\n/status - 查詢狀態\n/review - 審核學習建議\n/teach {內容} - 教 Bot 新知識\n/memory - 查看用戶記憶\n/forget {userId} - 清除用戶記憶\n/help - 使用說明`);
                return;
            }
            
            // /review - 審核 Bot 的學習建議
            if (trimmedMsg === '/review') {
                const pending = await getPendingLearning(3);
                if (pending.length === 0) {
                    await replyMessage(event.replyToken, '✅ 目前沒有待審核的學習建議。');
                    return;
                }
                
                let reviewText = `📚 待審核的學習建議（${pending.length} 筆）\n\n`;
                pending.forEach((item, i) => {
                    reviewText += `【#${item.id}】${item.title || '無標題'}\n`;
                    reviewText += `分類：${item.category || '未分類'}\n`;
                    reviewText += `內容：${item.content.substring(0, 100)}${item.content.length > 100 ? '...' : ''}\n`;
                    reviewText += `來源：${item.source_type}\n\n`;
                });
                reviewText += `回覆指令：\n✅ /approve {id} - 通過\n❌ /reject {id} {原因} - 拒絕`;
                
                await replyMessage(event.replyToken, reviewText);
                return;
            }
            
            // /approve {id} - 通過學習建議
            if (trimmedMsg.startsWith('/approve ')) {
                const id = parseInt(trimmedMsg.replace('/approve ', '').trim());
                if (isNaN(id)) {
                    await replyMessage(event.replyToken, '❌ 格式錯誤，請用 /approve {id}');
                    return;
                }
                const success = await reviewLearning(id, 'approved', senderId);
                await replyMessage(event.replyToken, success ? `✅ 學習建議 #${id} 已通過！` : `❌ 找不到 #${id} 或已審核過。`);
                return;
            }
            
            // /reject {id} {原因} - 拒絕學習建議
            if (trimmedMsg.startsWith('/reject ')) {
                const parts = userMessage.trim().substring(8).trim().split(/\s+/);
                const id = parseInt(parts[0]);
                const reason = parts.slice(1).join(' ') || null;
                if (isNaN(id)) {
                    await replyMessage(event.replyToken, '❌ 格式錯誤，請用 /reject {id} {原因}');
                    return;
                }
                const success = await reviewLearning(id, 'rejected', senderId, reason);
                await replyMessage(event.replyToken, success ? `❌ 學習建議 #${id} 已拒絕。` : `❌ 找不到 #${id} 或已審核過。`);
                return;
            }
            
            // /teach {內容} - 主動教 Bot 新知識
            if (userMessage.trim().startsWith('/teach ')) {
                const content = userMessage.trim().substring(7).trim();
                if (!content) {
                    await replyMessage(event.replyToken, '❌ 請提供要教的內容\n格式：/teach {內容}');
                    return;
                }
                await suggestLearning({
                    sourceType: 'owner_teach',
                    sourceChatId: chatId,
                    title: content.substring(0, 50),
                    content: content,
                    category: '其他'
                });
                // 直接自動通過（因為是 Owner 親自教的）
                const pending = await getPendingLearning(1);
                if (pending.length > 0) {
                    await reviewLearning(pending[0].id, 'approved', senderId);
                }
                await replyMessage(event.replyToken, `✅ 已學習！\n內容：${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
                return;
            }
            
            // /memory - 查看用戶記憶摘要
            if (trimmedMsg === '/memory') {
                const allMemories = await mysql.query(
                    'SELECT user_id, display_name, summary, status, visit_count, last_interaction FROM t_user_memory ORDER BY last_interaction DESC LIMIT 10'
                );
                if (allMemories.length === 0) {
                    await replyMessage(event.replyToken, '📝 目前沒有任何用戶記憶。');
                    return;
                }
                let memText = `📝 用戶記憶摘要（最近 ${allMemories.length} 位）\n\n`;
                allMemories.forEach(m => {
                    memText += `👤 ${m.display_name || m.user_id}\n`;
                    memText += `   狀態：${m.status} | 互動：${m.visit_count} 次\n`;
                    memText += `   摘要：${(m.summary || '無').substring(0, 60)}\n\n`;
                });
                await replyMessage(event.replyToken, memText);
                return;
            }
            
            // /forget {userId} - 清除特定用戶的記憶
            if (userMessage.trim().startsWith('/forget ')) {
                const targetUserId = userMessage.trim().substring(8).trim();
                if (!targetUserId) {
                    await replyMessage(event.replyToken, '❌ 請提供 User ID\n格式：/forget {userId}');
                    return;
                }
                await mysql.query('DELETE FROM t_user_memory WHERE user_id = ?', [targetUserId]);
                await replyMessage(event.replyToken, `✅ 已清除 ${targetUserId} 的記憶。`);
                return;
            }
            
            // Owner 的其他訊息，只記錄不回覆，但排程記憶更新
            scheduleMemoryUpdate(chatId, senderId);
            logger.info('Owner message recorded for style learning');
            return;
        }
    }
    
    // 3. 檢查是否應該自動回覆
    const replyDecision = await shouldAutoReply(event, userMessage);
    
    if (replyDecision.shouldReply && event.replyToken) {
        event.triggerInfo = replyDecision;
        await handleAutoReply(event, userMessage, event.replyToken, replyDecision);
        
        // 標記為自動回覆
        await saveMessage(event, true);
    } else {
        logger.info(`No auto-reply: ${replyDecision.reason}`);
        // 即使不回覆，也排程記憶更新（記錄用戶互動）
        const profile = await getUserProfile(senderId);
        scheduleMemoryUpdate(chatId, senderId, profile?.displayName);
    }
}

/**
 * 處理 Follow 事件
 */
async function handleFollowEvent(event) {
    logger.info(`New follower: ${event.source.userId}`);
    
    // 取得並儲存用戶資料
    const profile = await getUserProfile(event.source.userId);
    await saveUser(event.source.userId, profile);
    
    // 發送歡迎訊息
    if (event.replyToken) {
        const welcomeMessage = `歡迎加入！👋\n\n我是智能助理，有問題可以隨時問我。\n\n如需人工協助，我會幫您轉接。`;
        await replyMessage(event.replyToken, welcomeMessage);
    }
}

// ============================================
// Express Routes
// ============================================

/**
 * Webhook Endpoint - LINE 會發送事件到這裡
 */
app.post('/webhook', async (req, res) => {
    // 立即回應 200，避免 LINE 重試
    res.status(200).send('OK');
    
    // 驗證簽名
    const signature = req.headers['x-line-signature'];
    if (!signature || !validateSignature(req.rawBody, signature)) {
        logger.error('Invalid signature');
        return;
    }
    
    // 處理事件
    const events = req.body.events || [];
    
    for (const event of events) {
        try {
            switch (event.type) {
                case 'message':
                    await handleMessageEvent(event);
                    break;
                case 'follow':
                    await handleFollowEvent(event);
                    break;
                case 'unfollow':
                    logger.info(`Unfollow: ${event.source.userId}`);
                    break;
                case 'join':
                    logger.info(`Joined: ${event.source.groupId || event.source.roomId}`);
                    break;
                default:
                    logger.info(`Unhandled event type: ${event.type}`);
            }
        } catch (error) {
            logger.error(`Error handling event ${event.type}:`, error);
        }
    }
});

/**
 * 健康檢查
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * 統計資訊
 */
app.get('/stats', async (req, res) => {
    try {
        const messageCount = await mysql.query('SELECT COUNT(*) as count FROM t_messages');
        const userCount = await mysql.query('SELECT COUNT(*) as count FROM t_users');
        const autoReplyCount = await mysql.query('SELECT COUNT(*) as count FROM t_auto_replies');
        
        res.json({
            messages: messageCount[0].count,
            users: userCount[0].count,
            autoReplies: autoReplyCount[0].count,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * 手動觸發 Owner 語氣分析
 * 支援分析所有 Owner 的風格
 */
app.post('/admin/analyze-style', async (req, res) => {
    try {
        const results = [];
        // 分析所有 Owner 的語氣
        for (const ownerId of CONFIG.OWNER_USER_IDS) {
            if (ownerId) {
                const result = await analyzeOwnerStyle(ownerId);
                results.push({ ownerId, result });
            }
        }
        res.json({ success: true, ownerCount: CONFIG.OWNER_USER_IDS.length, results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 啟動服務
// ============================================
async function start() {
    try {
        // 初始化資料表
        await initTables();
        
        app.listen(CONFIG.PORT, () => {
            logger.info(`LINE Webhook server running on port ${CONFIG.PORT}`);
            logger.info(`Owner User IDs: ${CONFIG.OWNER_USER_IDS.join(', ') || 'NOT SET'}`);
            logger.info(`Mode (1-on-1): /auto | /manual | /status`);
            logger.info(`Mode (群組): 只在被 @提及 時回覆`);
            logger.info(`Memory: context=${MEMORY_CONFIG.CONTEXT_LIMIT} msgs, window=${MEMORY_CONFIG.CONTEXT_WINDOW_MIN} min`);
            logger.info(`Memory: auto_update=${MEMORY_CONFIG.AUTO_UPDATE}, learning=${MEMORY_CONFIG.LEARNING_ENABLED}`);
            logger.info(`Commands: /help /review /teach /memory /forget`);
        });
    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully');
    await pool.end();
    process.exit(0);
});
