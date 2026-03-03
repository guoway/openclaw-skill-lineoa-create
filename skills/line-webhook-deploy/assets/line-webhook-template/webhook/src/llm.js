/**
 * LLM 模組
 * 
 * 整合各種 OpenAI-compatible API（Moonshot、Zaiku、Gemini 等）
 * 功能：
 * 1. 生成回覆（結合 RAG + Owner 語氣）
 * 2. 分析 Owner 語氣特徵
 */

const axios = require('axios');
const { mysql } = require('./db');

const API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || 'kimi-k2.5';

/**
 * 呼叫 LLM API
 * @param {array} messages - 訊息陣列
 * @param {object} options - 選項
 */
async function chatCompletion(messages, options = {}) {
    const response = await axios.post(`${BASE_URL}/chat/completions`, {
        model: options.model || MODEL,
        messages: messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens || 4000,  // 增加到 4000 以獲得完整回覆
        ...options.extraParams
    }, {
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        },
        timeout: 30000
    });
    
    return response.data.choices[0].message.content;
}

/**
 * 生成回覆（整合三層記憶系統）
 * 
 * @param {string} userQuestion - 用戶問題
 * @param {array} ragResults - RAG 檢索結果
 * @param {object} ownerStyle - Owner 語氣特徵
 * @param {object} [memoryContext] - 記憶上下文
 * @param {Array} [memoryContext.conversationHistory] - 第 1 層：短期對話上下文
 * @param {string} [memoryContext.userMemoryText] - 第 2 層：用戶記憶摘要文字
 * @param {Array} [memoryContext.learnedKnowledge] - 第 3 層：已審核通過的學習知識
 */
async function generateReply(userQuestion, ragResults, ownerStyle, memoryContext = {}) {
    const { conversationHistory = [], userMemoryText = '', learnedKnowledge = [] } = memoryContext;
    
    // 構建 RAG 上下文
    const context = ragResults.length > 0
        ? ragResults.map((r, i) => `[${i + 1}] ${r.content}`).join('\n\n')
        : '（無相關資料）';
    
    // 構建已學習知識上下文
    const learnedContext = learnedKnowledge.length > 0
        ? '\n\n【Bot 學習到的知識】\n' + learnedKnowledge.map(k => `- ${k.title || ''}：${k.content}`).join('\n')
        : '';
    
    // 構建 Owner 語氣提示
    let stylePrompt = '';
    if (ownerStyle) {
        stylePrompt = `
請模仿以下語氣風格回覆：
- 平均句長：${ownerStyle.avg_sentence_length || '中等'} 字
- 常用語：${ownerStyle.common_phrases ? JSON.parse(ownerStyle.common_phrases).slice(0, 5).join('、') : '無資料'}
- 正式程度：${ownerStyle.formality_level || 3}/5
- 標點風格：${ownerStyle.punctuation_style || '一般'}
`;
    }
    
    // 構建 system prompt
    const systemPrompt = `你是席爾克軟體的專業業務人員。請根據參考資料回答客戶的問題。

**重要指示**：
1. 你是在跟**客戶**對話，不是在跟內部同事對話
2. 參考資料是內部文件，包含很多內部備註和說明（例如「依工程師能力增減」、「視專案大小決定」等）
3. 你需要將內部資訊**轉化為對客戶友善的說明**，而不是直接引用內部備註
4. 不要告訴客戶「依工程師能力增減」這類內部資訊，改用「我們會依據您的需求調整」
5. 不要說「視專案大小決定」，改用「我們會根據專案的複雜度為您規劃最適合的方案」
6. 用專業、親切的語氣向客戶說明，就像業務人員在跟客戶解釋一樣
7. 價格和方案要清楚列出，但說明方式要對客戶友善

**⚠️ 嚴格禁止幻覺（Hallucination）**：
- **禁止**捏造或推測任何參考資料中沒有明確提到的資訊
- **禁止**假設公司有別名或別稱
- **禁止**推測公司之間的關係
- **禁止**創造任何參考資料中沒有的公司名稱、人名、電話、地址等資訊
- 如果資訊不明確，**寧可說「我需要確認」也不要猜測**
- 你的公司名稱就是「席爾克軟體」，**不要**加上任何別稱或括號補充
${userMemoryText}
${stylePrompt}
回答要完整詳細，但角度要正確 - 你是代表公司向客戶說明的業務人員。`;

    // 構建 messages 陣列
    const messages = [
        { role: 'system', content: systemPrompt }
    ];
    
    // 加入對話歷史（第 1 層：短期上下文）
    if (conversationHistory.length > 0) {
        messages.push(...conversationHistory);
    }
    
    // 最後加入當前問題 + RAG 上下文
    messages.push({
        role: 'user',
        content: `【參考資料】（這是內部文件，請轉化為對客戶友善的說明）
${context}${learnedContext}

【客戶問題】
${userQuestion}

請以業務人員的角度，友善且專業地向客戶說明。**不要直接引用內部備註**，要轉化為客戶容易理解的說明。**⚠️ 嚴格禁止幻覺**：不要捏造或推測任何參考資料中沒有明確提到的資訊。如果參考資料不足，請說「這個問題我需要進一步了解您的需求，建議您直接聯繫我們的業務專員。」`
    });
    
    return await chatCompletion(messages, { temperature: 0.7 });
}

/**
 * 分析 Owner 語氣特徵
 * 從歷史訊息中分析並儲存語氣特徵
 * @param {string} ownerUserId - Owner 的 User ID
 */
async function analyzeOwnerStyle(ownerUserId) {
    console.log(`Analyzing owner style for: ${ownerUserId}`);
    
    // 1. 取得 Owner 最近 500 條訊息
    const messages = await mysql.query(`
        SELECT content, create_time 
        FROM t_messages 
        WHERE user_id = ? AND message_type = 'text' AND content IS NOT NULL
        ORDER BY create_time DESC
        LIMIT 500
    `, [ownerUserId]);
    
    if (messages.length < 10) {
        console.log('Not enough messages for analysis');
        return null;
    }
    
    const texts = messages.map(m => m.content).join('\n---\n');
    
    // 2. 使用 LLM 分析語氣
    const analysisPrompt = `
分析以下對話的語氣特徵，並以 JSON 格式回傳：

${texts.substring(0, 3000)}

請分析並回傳以下格式的 JSON：
{
    "avg_sentence_length": 平均句長（數字）,
    "common_phrases": ["常用語1", "常用語2", "常用語3"],
    "emoji_usage": "表情符號使用頻率描述",
    "punctuation_style": "標點風格描述",
    "formality_level": 正式程度（1-5，數字）,
    "greeting_style": "問候方式",
    "closing_style": "結尾方式"
}
`;
    
    try {
        const analysisText = await chatCompletion([
            { role: 'user', content: analysisPrompt }
        ], { temperature: 0.3 });
        
        // 解析 JSON
        const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('Failed to parse analysis result');
        }
        
        const analysis = JSON.parse(jsonMatch[0]);
        
        // 3. 儲存到資料庫
        await mysql.query(`
            INSERT INTO t_owner_style (
                user_id, avg_sentence_length, common_phrases, 
                emoji_usage_pattern, punctuation_style, formality_level,
                total_messages_analyzed, last_analyzed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                avg_sentence_length = VALUES(avg_sentence_length),
                common_phrases = VALUES(common_phrases),
                emoji_usage_pattern = VALUES(emoji_usage_pattern),
                punctuation_style = VALUES(punctuation_style),
                formality_level = VALUES(formality_level),
                total_messages_analyzed = VALUES(total_messages_analyzed),
                last_analyzed_at = VALUES(last_analyzed_at),
                update_time = CURRENT_TIMESTAMP
        `, [
            ownerUserId,
            analysis.avg_sentence_length,
            JSON.stringify(analysis.common_phrases || []),
            analysis.emoji_usage,
            analysis.punctuation_style,
            analysis.formality_level,
            messages.length
        ]);
        
        console.log('Owner style analysis completed');
        return analysis;
        
    } catch (error) {
        console.error('Style analysis failed:', error);
        throw error;
    }
}

/**
 * 分析訊息意圖
 * @param {string} text - 訊息內容
 */
async function analyzeIntent(text) {
    const prompt = `分析以下訊息的意圖，只回傳一個標籤（問候、詢問、抱怨、感謝、確認、其他）：\n\n${text}`;
    
    const result = await chatCompletion([
        { role: 'user', content: prompt }
    ], { temperature: 0.3, maxTokens: 20 });
    
    return result.trim();
}

/**
 * 生成 Owner 語氣的模擬回覆（用於測試）
 * @param {string} question - 問題
 * @param {object} ownerStyle - Owner 語氣特徵
 */
async function generateOwnerStyleReply(question, ownerStyle) {
    const messages = [
        {
            role: 'system',
            content: `你正在模仿以下人物的語氣回覆訊息：
- 平均句長：${ownerStyle?.avg_sentence_length || '中等'} 字
- 常用語：${ownerStyle?.common_phrases ? JSON.parse(ownerStyle.common_phrases).join('、') : ''}
- 正式程度：${ownerStyle?.formality_level || 3}/5

請用這個人物的語氣回答問題，保持自然、口語化。`
        },
        {
            role: 'user',
            content: question
        }
    ];
    
    return await chatCompletion(messages, { temperature: 0.8 });
}

module.exports = {
    generateReply,
    analyzeOwnerStyle,
    analyzeIntent,
    generateOwnerStyleReply,
    chatCompletion
};
