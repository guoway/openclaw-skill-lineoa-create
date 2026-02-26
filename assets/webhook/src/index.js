/**
 * LINE Webhook 主程式
 * 
 * 功能：
 * 1. 接收 LINE Webhook 事件
 * 2. 自動回覆（RAG + LLM）
 * 3. 語氣模仿
 */

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const winston = require('winston');
const { mysql } = require('./db');
const { search } = require('./rag');
const { generateReply, analyzeOwnerStyle } = require('./llm');

// Logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console()
    ]
});

// 環境變數
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OWNER_USER_IDS = (process.env.OWNER_USER_IDS || '').split(',').map(id => id.trim()).filter(id => id);
const AUTO_REPLY_KEYWORDS = (process.env.AUTO_REPLY_KEYWORDS || '問,查詢,help').split(',').map(k => k.trim());

const app = express();
app.use(express.json());

// ==================== LINE Signature 驗證 ====================
function verifySignature(body, signature) {
    const hash = crypto
        .createHmac('sha256', CHANNEL_SECRET)
        .update(body)
        .digest('base64');
    return hash === signature;
}

// ==================== LINE API ====================
async function replyMessage(replyToken, message) {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
        replyToken: replyToken,
        messages: [{ type: 'text', text: message }]
    }, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
        }
    });
}

async function pushMessage(userId, message) {
    await axios.post('https://api.line.me/v2/bot/message/push', {
        to: userId,
        messages: [{ type: 'text', text: message }]
    }, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
        }
    });
}

// ==================== 訊息處理 ====================
async function handleMessageEvent(event) {
    const userId = event.source.userId;
    const userMessage = event.message.text;
    
    // 儲存用戶訊息
    await saveMessage(userId, 'user', userMessage);
    
    // 判斷是否為 Owner
    const isOwnerUser = OWNER_USER_IDS.includes(userId);
    logger.info(`Message from ${isOwnerUser ? 'OWNER' : 'user'} (${userId}): ${userMessage.substring(0, 100)}`);
    
    // 檢查是否觸發自動回覆
    const shouldAutoReply = checkAutoReplyTrigger(userMessage, isOwnerUser);
    
    if (shouldAutoReply) {
        await handleAutoReply(userId, userMessage, isOwnerUser);
    }
}

function checkAutoReplyTrigger(message, isOwnerUser) {
    // 非 Owner 的訊息，檢查關鍵字
    if (!isOwnerUser) {
        return AUTO_REPLY_KEYWORDS.some(keyword => message.includes(keyword));
    }
    
    // Owner 的訊息，檢查關鍵字
    return AUTO_REPLY_KEYWORDS.some(keyword => message.includes(keyword));
}

async function handleAutoReply(userId, userMessage, isOwnerUser) {
    logger.info(`Auto-reply triggered for: ${userMessage.substring(0, 50)}...`);
    
    try {
        // 1. RAG 檢索
        const ragResults = await search(userMessage, 5);
        logger.info(`RAG retrieved ${ragResults.length} results`);
        
        // 2. 取得 Owner 語氣特徵
        let ownerStyle = null;
        if (OWNER_USER_IDS.length > 0) {
            ownerStyle = await getOwnerStyle(OWNER_USER_IDS[0]);
        }
        
        // 3. 生成回覆
        const startTime = Date.now();
        const reply = await generateReply(userMessage, ragResults, ownerStyle);
        const generationTime = Date.now() - startTime;
        
        // 4. 儲存回覆
        await saveMessage(userId, 'bot', reply);
        
        // 5. 儲存 auto-reply 記錄
        await saveAutoReply(userId, userMessage, reply, ragResults, generationTime);
        
        // 6. 發送回覆
        await pushMessage(userId, reply);
        logger.info(`Message replied successfully`);
        
    } catch (error) {
        logger.error('Auto-reply failed:', error.message);
        // 發送預設回覆
        await pushMessage(userId, '抱歉，系統發生錯誤，請稍後再試。');
    }
}

// ==================== 資料庫操作 ====================
async function saveMessage(userId, messageType, content) {
    await mysql.query(`
        INSERT INTO t_messages (user_id, message_type, content)
        VALUES (?, ?, ?)
    `, [userId, messageType, content]);
}

async function saveAutoReply(userId, userMessage, reply, ragResults, generationTime) {
    await mysql.query(`
        INSERT INTO t_auto_replies (user_id, user_message, final_reply, rag_context, generation_time_ms)
        VALUES (?, ?, ?, ?, ?)
    `, [userId, userMessage, reply, JSON.stringify(ragResults), generationTime]);
}

async function getOwnerStyle(ownerUserId) {
    const rows = await mysql.query(`
        SELECT * FROM t_owner_styles WHERE owner_user_id = ?
    `, [ownerUserId]);
    
    return rows.length > 0 ? rows[0] : null;
}

// ==================== Webhook 端點 ====================
app.post('/webhook', async (req, res) => {
    const signature = req.headers['x-line-signature'];
    const body = JSON.stringify(req.body);
    
    // 驗證簽章
    if (!verifySignature(body, signature)) {
        logger.error('Invalid signature');
        return res.status(401).send('Invalid signature');
    }
    
    // 處理事件
    const events = req.body.events;
    for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            await handleMessageEvent(event);
        }
    }
    
    res.status(200).send('OK');
});

// ==================== 健康檢查 ====================
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// ==================== 啟動服務 ====================
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        // 初始化資料庫
        await mysql.initialize();
        logger.info('Database tables initialized');
        
        // 啟動 Express
        app.listen(PORT, () => {
            logger.info(`LINE Webhook server running on port ${PORT}`);
            logger.info(`Owner User IDs: ${OWNER_USER_IDS.join(', ')}`);
            logger.info(`Auto-reply keywords: ${AUTO_REPLY_KEYWORDS.join(', ')}`);
            logger.info(`Mode: /auto (自動回覆) | /manual (手動模式) | /status (查詢狀態)`);
        });
    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
