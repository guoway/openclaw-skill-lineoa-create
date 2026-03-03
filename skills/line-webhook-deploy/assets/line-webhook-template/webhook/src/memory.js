/**
 * Memory 模組 - 三層記憶系統
 *
 * 第 1 層：短期對話上下文（最近 10 輪 + 30 分鐘窗口）
 * 第 2 層：用戶記憶摘要（每用戶一份，對話結束後更新）
 * 第 3 層：長期知識庫學習建議（Bot 學習 → Owner 審核）
 *
 * @module memory
 */

const { mysql } = require('./db');
const { chatCompletion } = require('./llm');
const winston = require('winston');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: '/app/logs/memory.log' })
    ]
});

// ============================================
// 配置參數
// ============================================
const MEMORY_CONFIG = {
    /** 短期上下文最大訊息數 */
    CONTEXT_LIMIT: parseInt(process.env.MEMORY_CONTEXT_LIMIT || '10'),
    /** 短期上下文時間窗口（分鐘） */
    CONTEXT_WINDOW_MIN: parseInt(process.env.MEMORY_CONTEXT_WINDOW_MIN || '30'),
    /** 是否自動更新用戶記憶 */
    AUTO_UPDATE: process.env.MEMORY_AUTO_UPDATE !== 'false',
    /** 是否啟用 Bot 學習建議 */
    LEARNING_ENABLED: process.env.MEMORY_LEARNING_ENABLED !== 'false'
};

// ============================================
// 對話結束偵測用的 Timer 管理
// ============================================

/** @type {Map<string, NodeJS.Timeout>} chatId → timer */
const conversationTimers = new Map();

// ============================================
// 第 1 層：短期對話上下文
// ============================================

/**
 * 取得最近的對話上下文
 *
 * 規則：同一個 chat_id 中，最近 N 輪對話 + M 分鐘時間窗口，取交集。
 *
 * @param {string} chatId - 對話 ID（群組 ID 或用戶 ID）
 * @param {string} currentUserId - 目前發問的用戶 ID
 * @returns {Promise<Array<{role: string, content: string}>>} LLM messages 格式的對話歷史
 */
async function getRecentConversation(chatId, currentUserId) {
    try {
        const windowMinutes = MEMORY_CONFIG.CONTEXT_WINDOW_MIN;
        const limit = MEMORY_CONFIG.CONTEXT_LIMIT;

        const sql = `
            SELECT user_id, content, is_auto_reply, is_owner, create_time
            FROM t_messages
            WHERE chat_id = ?
              AND content IS NOT NULL
              AND content != ''
              AND message_type = 'text'
              AND create_time > DATE_SUB(NOW(), INTERVAL ? MINUTE)
            ORDER BY create_time DESC
            LIMIT ?
        `;

        const rows = await mysql.query(sql, [chatId, windowMinutes, limit]);

        if (rows.length === 0) {
            return [];
        }

        // 反轉為時間順序（從舊到新）
        rows.reverse();

        // 轉換為 LLM messages 格式
        const messages = rows.map(row => {
            // Bot 的自動回覆 → assistant
            // 用戶的訊息 → user
            const role = row.is_auto_reply ? 'assistant' : 'user';
            const prefix = (!row.is_auto_reply && !row.is_owner && row.user_id !== currentUserId)
                ? `[${row.user_id}] `
                : '';

            return {
                role,
                content: `${prefix}${row.content}`
            };
        });

        logger.info(`Retrieved ${messages.length} context messages for chat ${chatId}`);
        return messages;

    } catch (error) {
        logger.error('Failed to get recent conversation:', error);
        return [];
    }
}

// ============================================
// 第 2 層：用戶記憶摘要
// ============================================

/**
 * 取得用戶的記憶摘要
 *
 * @param {string} userId - LINE User ID
 * @returns {Promise<object|null>} 用戶記憶物件，或 null
 */
async function getUserMemory(userId) {
    try {
        const sql = 'SELECT * FROM t_user_memory WHERE user_id = ?';
        const rows = await mysql.query(sql, [userId]);

        if (rows.length === 0) {
            return null;
        }

        const memory = rows[0];
        // 解析 JSON 欄位
        if (typeof memory.topics === 'string') {
            memory.topics = JSON.parse(memory.topics);
        }
        if (typeof memory.preferences === 'string') {
            memory.preferences = JSON.parse(memory.preferences);
        }

        return memory;
    } catch (error) {
        logger.error('Failed to get user memory:', error);
        return null;
    }
}

/**
 * 更新用戶的記憶摘要
 *
 * 在對話結束後（30 分鐘無互動）觸發，用 LLM 產生摘要。
 *
 * @param {string} userId - LINE User ID
 * @param {string} chatId - 對話 ID
 * @param {string} displayName - 用戶顯示名稱
 */
async function updateUserMemory(userId, chatId, displayName) {
    try {
        logger.info(`Updating user memory for ${userId} in chat ${chatId}`);

        // 1. 取得本次對話的所有訊息（最近 30 分鐘 + 往前延伸到上次沉默 30 分鐘的點）
        const conversation = await getFullConversation(chatId);
        if (conversation.length < 2) {
            logger.info('Conversation too short, skipping memory update');
            return;
        }

        // 2. 取得現有記憶
        const existingMemory = await getUserMemory(userId);

        // 3. 用 LLM 產生更新後的摘要
        const updatedMemory = await generateMemorySummary(existingMemory, conversation, displayName);
        if (!updatedMemory) {
            logger.warn('LLM failed to generate memory summary');
            return;
        }

        // 4. 寫回資料庫
        const sql = `
            INSERT INTO t_user_memory (
                user_id, display_name, summary, topics, preferences,
                visit_count, status, last_conversation_summary, last_interaction
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                display_name = VALUES(display_name),
                summary = VALUES(summary),
                topics = VALUES(topics),
                preferences = VALUES(preferences),
                visit_count = visit_count + 1,
                status = VALUES(status),
                last_conversation_summary = VALUES(last_conversation_summary),
                last_interaction = NOW(),
                update_time = CURRENT_TIMESTAMP
        `;

        await mysql.query(sql, [
            userId,
            displayName || null,
            updatedMemory.summary || null,
            JSON.stringify(updatedMemory.topics || []),
            JSON.stringify(updatedMemory.preferences || {}),
            updatedMemory.status || '新訪客',
            updatedMemory.last_conversation_summary || null
        ]);

        logger.info(`User memory updated for ${userId}`);

    } catch (error) {
        logger.error('Failed to update user memory:', error);
    }
}

/**
 * 取得完整的本次對話（用於記憶更新）
 *
 * @param {string} chatId - 對話 ID
 * @returns {Promise<Array>} 對話訊息陣列
 */
async function getFullConversation(chatId) {
    try {
        // 取得最近 2 小時內的對話（給記憶更新用，範圍比上下文大）
        const sql = `
            SELECT user_id, content, is_auto_reply, is_owner, create_time
            FROM t_messages
            WHERE chat_id = ?
              AND content IS NOT NULL
              AND content != ''
              AND message_type = 'text'
              AND create_time > DATE_SUB(NOW(), INTERVAL 2 HOUR)
            ORDER BY create_time ASC
        `;
        return await mysql.query(sql, [chatId]);
    } catch (error) {
        logger.error('Failed to get full conversation:', error);
        return [];
    }
}

/**
 * 用 LLM 產生更新後的記憶摘要
 *
 * @param {object|null} existingMemory - 現有記憶
 * @param {Array} conversation - 本次對話訊息
 * @param {string} displayName - 用戶顯示名稱
 * @returns {Promise<object|null>} 更新後的記憶 JSON
 */
async function generateMemorySummary(existingMemory, conversation, displayName) {
    try {
        const existingSummary = existingMemory
            ? JSON.stringify({
                summary: existingMemory.summary,
                topics: existingMemory.topics,
                preferences: existingMemory.preferences,
                status: existingMemory.status,
                visit_count: existingMemory.visit_count
            }, null, 2)
            : '（這是新用戶，尚無記憶）';

        const conversationText = conversation.map(msg => {
            const role = msg.is_auto_reply ? 'Bot' : (msg.is_owner ? 'Owner' : `用戶(${displayName || msg.user_id})`);
            return `${role}: ${msg.content}`;
        }).join('\n');

        const prompt = `你是記憶管理員。根據以下對話內容，更新用戶的記憶摘要。

【現有摘要】
${existingSummary}

【本次對話】
${conversationText}

請輸出一個 JSON 物件，包含：
- summary: 一段簡短的摘要（100字內），包含用戶的關鍵資訊，合併歷史和本次對話
- topics: 用戶關心的主題（JSON 陣列）
- preferences: 用戶偏好，例如預算範圍、技術偏好、溝通風格等（JSON 物件）
- status: 用戶狀態，從以下選一個：新訪客、潛在客戶、已成交、回頭客
- last_conversation_summary: 本次對話的簡短摘要（50字內）

規則：
1. 只保留有價值的資訊，不要記錄閒聊
2. 如果本次對話沒有新的有價值資訊，保持現有摘要不變
3. 合併而非覆蓋歷史資訊
4. 只輸出 JSON，不要其他文字`;

        const result = await chatCompletion([
            { role: 'user', content: prompt }
        ], { temperature: 0.3, maxTokens: 1000 });

        // 解析 JSON
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            logger.error('Failed to parse memory summary JSON');
            return null;
        }

        return JSON.parse(jsonMatch[0]);

    } catch (error) {
        logger.error('Failed to generate memory summary:', error);
        return null;
    }
}

/**
 * 格式化用戶記憶為 Prompt 片段
 *
 * 將用戶記憶轉換成可以直接塞入 system prompt 的文字。
 *
 * @param {object|null} memory - 用戶記憶物件
 * @returns {string} 格式化後的記憶文字，若無記憶則返回空字串
 */
function formatUserMemoryForPrompt(memory) {
    if (!memory || !memory.summary) {
        return '';
    }

    let memoryText = `\n【用戶記憶】\n`;
    memoryText += `- 摘要：${memory.summary}\n`;

    if (memory.topics && memory.topics.length > 0) {
        memoryText += `- 關心主題：${memory.topics.join('、')}\n`;
    }

    if (memory.preferences && Object.keys(memory.preferences).length > 0) {
        const prefs = Object.entries(memory.preferences)
            .map(([k, v]) => `${k}: ${v}`)
            .join('、');
        memoryText += `- 偏好：${prefs}\n`;
    }

    if (memory.status) {
        memoryText += `- 用戶類型：${memory.status}（第 ${memory.visit_count || 1} 次互動）\n`;
    }

    if (memory.last_conversation_summary) {
        memoryText += `- 上次對話：${memory.last_conversation_summary}\n`;
    }

    return memoryText;
}

// ============================================
// 第 3 層：學習建議
// ============================================

/**
 * 提交一筆學習建議
 *
 * @param {object} data - 學習建議資料
 * @param {string} data.sourceType - 來源類型：conversation | owner_correction | owner_teach
 * @param {string} [data.sourceChatId] - 來源對話 ID
 * @param {Array} [data.sourceMessageIds] - 相關訊息 ID
 * @param {string} data.title - 標題
 * @param {string} data.content - 內容
 * @param {string} [data.category] - 分類
 * @returns {Promise<number>} 新建記錄的 ID
 */
async function suggestLearning(data) {
    try {
        const sql = `
            INSERT INTO t_learned_knowledge (
                source_type, source_chat_id, source_message_ids,
                title, content, category
            ) VALUES (?, ?, ?, ?, ?, ?)
        `;

        const result = await mysql.query(sql, [
            data.sourceType,
            data.sourceChatId || null,
            data.sourceMessageIds ? JSON.stringify(data.sourceMessageIds) : null,
            data.title || null,
            data.content,
            data.category || null
        ]);

        logger.info(`Learning suggestion created: ${data.title}`);
        return result.insertId;
    } catch (error) {
        logger.error('Failed to create learning suggestion:', error);
        throw error;
    }
}

/**
 * 分析對話中是否有值得學習的經驗
 *
 * 偵測條件：
 * 1. Owner 手動回覆了某個問題（可能是 Bot 回答不好）
 * 2. 客戶反覆問同類問題
 *
 * @param {Array} conversation - 本次對話訊息
 * @param {string} chatId - 對話 ID
 */
async function analyzeLearningOpportunity(conversation, chatId) {
    if (!MEMORY_CONFIG.LEARNING_ENABLED) return;

    try {
        // 找出 Owner 手動回覆的訊息（可能是 Bot 回答不好，Owner 需要介入）
        const ownerCorrections = [];
        for (let i = 1; i < conversation.length; i++) {
            const curr = conversation[i];
            const prev = conversation[i - 1];

            // 如果前一則是用戶訊息，而這一則是 Owner 回覆（非自動回覆）
            if (!prev.is_owner && !prev.is_auto_reply && curr.is_owner) {
                ownerCorrections.push({
                    userQuestion: prev.content,
                    ownerAnswer: curr.content
                });
            }
        }

        if (ownerCorrections.length === 0) return;

        // 用 LLM 分析是否有值得記住的經驗
        const prompt = `你是知識管理員。分析以下 Owner 親自回覆客戶的對話，判斷是否有值得 Bot 學習的經驗。

${ownerCorrections.map((c, i) => `【對話 ${i + 1}】\n客戶問：${c.userQuestion}\nOwner 答：${c.ownerAnswer}`).join('\n\n')}

請判斷是否有值得學習的知識點。如果有，請用以下 JSON 格式輸出（可以有多筆）：
{
    "suggestions": [
        {
            "title": "簡短標題",
            "content": "完整的知識內容，Bot 未來可以直接用來回答類似問題",
            "category": "分類（FAQ/報價/技術/流程/其他）"
        }
    ]
}

如果沒有值得學習的，輸出：
{ "suggestions": [] }

注意：只記錄有通用價值的知識，不要記錄特定客戶的私人資訊。`;

        const result = await chatCompletion([
            { role: 'user', content: prompt }
        ], { temperature: 0.3, maxTokens: 1000 });

        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;

        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.suggestions || parsed.suggestions.length === 0) return;

        // 寫入學習建議
        for (const suggestion of parsed.suggestions) {
            await suggestLearning({
                sourceType: 'owner_correction',
                sourceChatId: chatId,
                title: suggestion.title,
                content: suggestion.content,
                category: suggestion.category
            });
        }

        logger.info(`${parsed.suggestions.length} learning suggestions created from conversation`);

    } catch (error) {
        logger.error('Failed to analyze learning opportunity:', error);
    }
}

/**
 * 取得待審核的學習建議
 *
 * @param {number} [limit=5] - 返回數量
 * @returns {Promise<Array>} 學習建議列表
 */
async function getPendingLearning(limit = 5) {
    try {
        const sql = `
            SELECT id, source_type, title, content, category, create_time
            FROM t_learned_knowledge
            WHERE status = 'pending'
            ORDER BY create_time ASC
            LIMIT ?
        `;
        return await mysql.query(sql, [limit]);
    } catch (error) {
        logger.error('Failed to get pending learning:', error);
        return [];
    }
}

/**
 * 審核學習建議
 *
 * @param {number} id - 學習建議 ID
 * @param {'approved'|'rejected'} action - 審核動作
 * @param {string} reviewerId - 審核者 User ID
 * @param {string} [rejectReason] - 拒絕原因
 * @returns {Promise<boolean>} 是否成功
 */
async function reviewLearning(id, action, reviewerId, rejectReason) {
    try {
        const sql = `
            UPDATE t_learned_knowledge
            SET status = ?, reviewed_by = ?, reviewed_at = NOW(),
                reject_reason = ?
            WHERE id = ? AND status = 'pending'
        `;

        const result = await mysql.query(sql, [
            action,
            reviewerId,
            action === 'rejected' ? (rejectReason || null) : null,
            id
        ]);

        if (result.affectedRows > 0) {
            logger.info(`Learning #${id} ${action} by ${reviewerId}`);
            return true;
        }
        return false;
    } catch (error) {
        logger.error('Failed to review learning:', error);
        return false;
    }
}

/**
 * 取得已審核通過的知識（用於補充 RAG）
 *
 * @param {string} [category] - 分類篩選
 * @returns {Promise<Array>} 已通過的知識列表
 */
async function getApprovedKnowledge(category) {
    try {
        let sql = `
            SELECT id, title, content, category, create_time
            FROM t_learned_knowledge
            WHERE status = 'approved'
        `;
        const params = [];

        if (category) {
            sql += ' AND category = ?';
            params.push(category);
        }

        sql += ' ORDER BY create_time DESC';

        return await mysql.query(sql, params);
    } catch (error) {
        logger.error('Failed to get approved knowledge:', error);
        return [];
    }
}

// ============================================
// 對話結束偵測與記憶更新排程
// ============================================

/**
 * 排程記憶更新
 *
 * 每次收到訊息時呼叫，重設 30 分鐘的 timer。
 * 當 30 分鐘無新訊息時，觸發記憶更新。
 *
 * @param {string} chatId - 對話 ID
 * @param {string} userId - 用戶 ID
 * @param {string} [displayName] - 用戶顯示名稱
 */
function scheduleMemoryUpdate(chatId, userId, displayName) {
    if (!MEMORY_CONFIG.AUTO_UPDATE) return;

    const timerKey = `${chatId}:${userId}`;

    // 清除舊的 timer
    if (conversationTimers.has(timerKey)) {
        clearTimeout(conversationTimers.get(timerKey));
    }

    // 設定新的 timer（30 分鐘後觸發）
    const timer = setTimeout(async () => {
        conversationTimers.delete(timerKey);
        logger.info(`Conversation ended for ${userId} in ${chatId}, updating memory...`);

        // 更新用戶記憶
        await updateUserMemory(userId, chatId, displayName);

        // 分析學習機會
        const conversation = await getFullConversation(chatId);
        await analyzeLearningOpportunity(conversation, chatId);

    }, MEMORY_CONFIG.CONTEXT_WINDOW_MIN * 60 * 1000);

    conversationTimers.set(timerKey, timer);
}

module.exports = {
    // 第 1 層
    getRecentConversation,
    // 第 2 層
    getUserMemory,
    updateUserMemory,
    formatUserMemoryForPrompt,
    // 第 3 層
    suggestLearning,
    analyzeLearningOpportunity,
    getPendingLearning,
    reviewLearning,
    getApprovedKnowledge,
    // 排程
    scheduleMemoryUpdate,
    // 配置
    MEMORY_CONFIG
};
