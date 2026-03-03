/**
 * RAG (Retrieval-Augmented Generation) 模組
 * 
 * 使用 Qdrant 作為向量資料庫，支援文件檢索
 */

const axios = require('axios');

const QDRANT_URL = `http://${process.env.QDRANT_HOST || 'qdrant'}:${process.env.QDRANT_PORT || '6333'}`;
const COLLECTION_NAME = 'knowledge_base';

/**
 * 取得文本的向量嵌入
 * @param {string} text - 要編碼的文本
 */
async function getEmbedding(text) {
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    
    const response = await axios.post(`${baseUrl}/embeddings`, {
        input: text,
        model: 'text-embedding-3-small'  // 或根據你的模型調整
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });
    
    return response.data.data[0].embedding;
}

/**
 * 確保集合存在
 */
async function ensureCollection() {
    try {
        await axios.get(`${QDRANT_URL}/collections/${COLLECTION_NAME}`);
    } catch (error) {
        // 集合不存在，創建它
        await axios.put(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
            vectors: {
                size: 1536,  // text-embedding-3-small 的維度
                distance: 'Cosine'
            }
        });
        console.log(`Created collection: ${COLLECTION_NAME}`);
    }
}

/**
 * 搜索相似文本
 * @param {string} query - 查詢文本
 * @param {number} limit - 返回結果數量
 */
async function searchSimilar(query, limit = 5) {
    try {
        // 確保集合存在
        await ensureCollection();
        
        // 取得查詢的向量
        const vector = await getEmbedding(query);
        
        // 搜索
        const response = await axios.post(
            `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`,
            {
                vector: vector,
                limit: limit,
                with_payload: true,
                with_vector: false
            }
        );
        
        return response.data.result.map(point => ({
            id: point.id,
            score: point.score,
            content: point.payload.content,
            source: point.payload.source,
            metadata: point.payload.metadata
        }));
    } catch (error) {
        console.error('RAG search error:', error.message);
        return [];
    }
}

/**
 * 添加文檔到向量資料庫
 * @param {string} id - 文檔唯一 ID
 * @param {string} content - 文檔內容
 * @param {object} metadata - 元數據
 */
async function addDocument(id, content, metadata = {}) {
    try {
        await ensureCollection();
        
        const vector = await getEmbedding(content);
        
        await axios.put(
            `${QDRANT_URL}/collections/${COLLECTION_NAME}/points`,
            {
                points: [{
                    id: id,
                    vector: vector,
                    payload: {
                        content: content,
                        source: metadata.source || 'unknown',
                        metadata: metadata
                    }
                }]
            }
        );
        
        return true;
    } catch (error) {
        console.error('Add document error:', error.message);
        throw error;
    }
}

/**
 * 批量添加文檔
 * @param {array} documents - 文檔陣列 [{id, content, metadata}]
 */
async function addDocumentsBatch(documents) {
    try {
        await ensureCollection();
        
        const points = [];
        for (const doc of documents) {
            const vector = await getEmbedding(doc.content);
            points.push({
                id: doc.id,
                vector: vector,
                payload: {
                    content: doc.content,
                    source: doc.metadata?.source || 'unknown',
                    metadata: doc.metadata
                }
            });
        }
        
        // 分批上傳（每批 100 個）
        const batchSize = 100;
        for (let i = 0; i < points.length; i += batchSize) {
            const batch = points.slice(i, i + batchSize);
            await axios.put(
                `${QDRANT_URL}/collections/${COLLECTION_NAME}/points`,
                { points: batch }
            );
        }
        
        return points.length;
    } catch (error) {
        console.error('Batch add documents error:', error.message);
        throw error;
    }
}

/**
 * 刪除文檔
 * @param {string} id - 文檔 ID
 */
async function deleteDocument(id) {
    try {
        await axios.post(
            `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/delete`,
            { points: [id] }
        );
        return true;
    } catch (error) {
        console.error('Delete document error:', error.message);
        throw error;
    }
}

module.exports = {
    searchSimilar,
    addDocument,
    addDocumentsBatch,
    deleteDocument,
    getEmbedding
};
