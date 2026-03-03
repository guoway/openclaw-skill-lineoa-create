/**
 * RAG (Retrieval-Augmented Generation) 模組
 *
 * 使用 Qdrant 作為向量資料庫，支援文件檢索
 */

const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const QDRANT_URL = `http://${process.env.QDRANT_HOST || 'qdrant'}:${process.env.QDRANT_PORT || '6333'}`;
const COLLECTION_NAME = 'knowledge_base';

// 初始化 Google Generative AI（用於 embeddings）
let genAI = null;
let embeddingModel = null;

/**
 * 初始化 Gemini embeddings 模型
 */
function initGeminiEmbeddings() {
    if (!genAI && process.env.USE_GEMINI_EMBEDDINGS === 'true') {
        genAI = new GoogleGenerativeAI(process.env.OPENAI_API_KEY);
        const modelName = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
        embeddingModel = genAI.getGenerativeModel({ model: modelName });
        console.log(`Initialized Gemini embeddings: ${modelName}`);
    }
}

/**
 * 取得文本的向量嵌入
 * @param {string} text - 要編碼的文本
 * @param {string} taskType - 任務類型 (RETRIEVAL_QUERY, RETRIEVAL_DOCUMENT, etc.)
 * @returns {Promise<number[]>} 向量陣列
 */
async function getEmbedding(text, taskType = 'RETRIEVAL_QUERY') {
    try {
        const useOllamaEmbeddings = process.env.USE_OLLAMA_EMBEDDINGS === 'true';
        const useGeminiEmbeddings = process.env.USE_GEMINI_EMBEDDINGS === 'true';

        if (useOllamaEmbeddings) {
            // 使用 Ollama API (BGE-m3)
            const ollamaApiUrl = process.env.OLLAMA_API_URL || 'http://ollama.sylksoft.com:11434';
            const ollamaEmbeddingModel = process.env.OLLAMA_EMBEDDING_MODEL || 'bge-m3';
            
            console.log(`Using Ollama embeddings: model=${ollamaEmbeddingModel}`);
            
            const response = await axios.post(`${ollamaApiUrl}/api/embed`, {
                model: ollamaEmbeddingModel,
                input: text
            }, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });
            
            const embedding = response.data.embeddings[0];
            console.log(`Ollama embedding success: dimension=${embedding.length}`);
            return embedding;
        } else if (useGeminiEmbeddings) {
            // 使用 Google Gemini Embeddings SDK
            initGeminiEmbeddings();

            console.log(`Using Gemini embeddings SDK: taskType=${taskType}`);

            try {
                const result = await embeddingModel.embedContent({
                    content: { parts: [{ text }] },
                    taskType: taskType
                });

                const embedding = result.embedding;
                console.log(`Gemini embedding success: dimension=${embedding.values.length}`);
                return embedding.values;
            } catch (sdkError) {
                console.error('Gemini SDK error:', {
                    message: sdkError.message,
                    stack: sdkError.stack
                });
                throw sdkError;
            }
        } else {
            // 使用 OpenAI-compatible API（預設）
            const apiKey = process.env.OPENAI_API_KEY;
            const baseUrl = (process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
            const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

            console.log(`Using OpenAI embeddings: model=${model}, baseUrl=${baseUrl}`);

            const response = await axios.post(`${baseUrl}/embeddings`, {
                input: text,
                model: model
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            return response.data.data[0].embedding;
        }
    } catch (error) {
        if (error.response) {
            console.error('Embedding API error:', {
                status: error.response.status,
                data: error.response.data,
                url: error.config?.url
            });
        } else {
            console.error('Embedding error:', error.message);
        }
        throw error;
    }
}

/**
 * 取得 embedding 維度
 * @returns {number} 向量維度
 */
function getEmbeddingDimension() {
    const useOllamaEmbeddings = process.env.USE_OLLAMA_EMBEDDINGS === 'true';
    const useGeminiEmbeddings = process.env.USE_GEMINI_EMBEDDINGS === 'true';
    
    if (useOllamaEmbeddings) {
        return 1024;  // BGE-m3 的維度
    }
    if (useGeminiEmbeddings) {
        return 3072;  // gemini-embedding-001 的實際維度
    }
    const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
    if (model.includes('large')) {
        return 3072;
    }
    return 1536;  // text-embedding-3-small 的維度
}

/**
 * 確保集合存在
 */
async function ensureCollection() {
    try {
        const response = await axios.get(`${QDRANT_URL}/collections/${COLLECTION_NAME}`);
        const currentDimension = response.data.result?.config?.params?.vectors?.size;
        const expectedDimension = getEmbeddingDimension();

        // 如果維度不匹配，刪除舊集合並重建
        if (currentDimension && currentDimension !== expectedDimension) {
            console.log(`Collection dimension mismatch: current=${currentDimension}, expected=${expectedDimension}. Recreating...`);
            await axios.delete(`${QDRANT_URL}/collections/${COLLECTION_NAME}`);
            throw new Error('Collection deleted for recreation');
        }
    } catch (error) {
        // 集合不存在或已刪除，創建它
        const dimension = getEmbeddingDimension();
        await axios.put(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
            vectors: {
                size: dimension,
                distance: 'Cosine'
            }
        });
        console.log(`Created collection: ${COLLECTION_NAME} with dimension ${dimension}`);
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

        // 取得查詢的向量（使用 RETRIEVAL_QUERY 任務類型）
        const vector = await getEmbedding(query, 'RETRIEVAL_QUERY');

        // 搜索：先取得大量候選，再做 reranking
        const candidateLimit = Math.max(limit, 100);  // 提升到 100 個候選
        const response = await axios.post(
            `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/search`,
            {
                vector: vector,
                limit: candidateLimit,
                with_payload: true,
                with_vector: false
            }
        );

        const results = response.data.result.map(point => ({
            id: point.id,
            score: point.score,
            content: point.payload.content,
            source: point.payload.source,
            metadata: point.payload.metadata
        }));

        // 關鍵詞重排：大幅提升相關檔名的權重
        const queryText = (query || '').toLowerCase();
        const reranked = results.map(item => {
            let boostedScore = item.score;
            const source = (item.source || '').toLowerCase();

            // 當問題包含「報價原則」時，大幅提升含「報價原則」檔名的文件
            if (queryText.includes('報價原則') && source.includes('報價原則')) {
                boostedScore += 1.0;  // 大幅提升
            }
            // 當問題包含「原則」或「規則」時，提升相關檔名
            else if ((queryText.includes('原則') || queryText.includes('規則')) && (source.includes('原則') || source.includes('規則'))) {
                boostedScore += 0.5;
            }
            // 當問題包含「報價」時，稍微提升報價相關文件
            else if (queryText.includes('報價') && source.includes('報價')) {
                boostedScore += 0.3;
            }

            return { ...item, score: boostedScore };
        });

        reranked.sort((a, b) => b.score - a.score);
        return reranked.slice(0, limit);
    } catch (error) {
        console.error('RAG search error:', error.message);
        if (error.response) {
            console.error('Error details:', JSON.stringify(error.response.data, null, 2));
        }
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

        // 取得文檔的向量（使用 RETRIEVAL_DOCUMENT 任務類型）
        const vector = await getEmbedding(content, 'RETRIEVAL_DOCUMENT');

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
            // 取得文檔的向量（使用 RETRIEVAL_DOCUMENT 任務類型）
            const vector = await getEmbedding(doc.content, 'RETRIEVAL_DOCUMENT');
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
