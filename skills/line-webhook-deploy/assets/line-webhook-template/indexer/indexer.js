/**
 * 文件索引服務
 * 
 * 監控 knowledge/ 目錄，自動將新文件索引到 Qdrant
 * 支援格式：PDF, DOCX, TXT, MD
 */

const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const winston = require('winston');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const axios = require('axios');

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

// 設定
const CONFIG = {
    knowledgeDir: process.env.KNOWLEDGE_BASE_DIR || '/app/knowledge',
    qdrantUrl: `http://${process.env.QDRANT_HOST || 'qdrant'}:${process.env.QDRANT_PORT || '6333'}`,
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    chunkSize: 1000,      // 每個 chunk 的字元數
    chunkOverlap: 200     // chunk 之間的重疊
};

const COLLECTION_NAME = 'knowledge_base';

// ============================================
// 工具函數
// ============================================

/**
 * 取得檔案雜湊
 */
async function getFileHash(filepath) {
    const content = await fs.readFile(filepath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * 取得文本的向量嵌入
 */
async function getEmbedding(text) {
    const response = await axios.post(`${CONFIG.baseUrl}/embeddings`, {
        input: text,
        model: 'text-embedding-3-small'
    }, {
        headers: {
            'Authorization': `Bearer ${CONFIG.apiKey}`,
            'Content-Type': 'application/json'
        }
    });
    return response.data.data[0].embedding;
}

/**
 * 將文本切分為 chunks
 */
function splitIntoChunks(text, chunkSize = CONFIG.chunkSize, overlap = CONFIG.chunkOverlap) {
    const chunks = [];
    let i = 0;
    
    while (i < text.length) {
        const chunk = text.slice(i, i + chunkSize);
        chunks.push(chunk);
        i += chunkSize - overlap;
    }
    
    return chunks;
}

// ============================================
// 文件解析
// ============================================

/**
 * 解析 PDF
 */
async function parsePDF(filepath) {
    const buffer = await fs.readFile(filepath);
    const data = await pdfParse(buffer);
    return data.text;
}

/**
 * 解析 DOCX
 */
async function parseDOCX(filepath) {
    const buffer = await fs.readFile(filepath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
}

/**
 * 解析 TXT/MD
 */
async function parseText(filepath) {
    return await fs.readFile(filepath, 'utf-8');
}

/**
 * 根據副檔名解析文件
 */
async function parseFile(filepath) {
    const ext = path.extname(filepath).toLowerCase();
    
    switch (ext) {
        case '.pdf':
            return await parsePDF(filepath);
        case '.docx':
        case '.doc':
            return await parseDOCX(filepath);
        case '.txt':
        case '.md':
        case '.markdown':
            return await parseText(filepath);
        default:
            throw new Error(`Unsupported file type: ${ext}`);
    }
}

// ============================================
// Qdrant 操作
// ============================================

/**
 * 確保集合存在
 */
async function ensureCollection() {
    try {
        await axios.get(`${CONFIG.qdrantUrl}/collections/${COLLECTION_NAME}`);
    } catch (error) {
        await axios.put(`${CONFIG.qdrantUrl}/collections/${COLLECTION_NAME}`, {
            vectors: {
                size: 1536,
                distance: 'Cosine'
            }
        });
        logger.info(`Created collection: ${COLLECTION_NAME}`);
    }
}

/**
 * 刪除文件的舊 chunks
 */
async function deleteOldChunks(sourceId) {
    try {
        await axios.post(`${CONFIG.qdrantUrl}/collections/${COLLECTION_NAME}/points/delete`, {
            filter: {
                must: [{
                    key: 'metadata.source_id',
                    match: { value: sourceId }
                }]
            }
        });
    } catch (error) {
        logger.error('Failed to delete old chunks:', error.message);
    }
}

/**
 * 上傳 chunks 到 Qdrant
 */
async function uploadChunks(chunks, metadata) {
    const points = [];
    
    for (let i = 0; i < chunks.length; i++) {
        const vector = await getEmbedding(chunks[i]);
        points.push({
            id: `${metadata.source_id}_chunk_${i}`,
            vector: vector,
            payload: {
                content: chunks[i],
                source: metadata.filename,
                metadata: {
                    ...metadata,
                    chunk_index: i,
                    total_chunks: chunks.length
                }
            }
        });
    }
    
    // 分批上傳
    const batchSize = 50;
    for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        await axios.put(`${CONFIG.qdrantUrl}/collections/${COLLECTION_NAME}/points`, {
            points: batch
        });
    }
    
    return points.length;
}

// ============================================
// 文件處理
// ============================================

/**
 * 處理單一文件
 */
async function processFile(filepath) {
    const filename = path.basename(filepath);
    const sourceId = crypto.createHash('md5').update(filepath).digest('hex');
    
    logger.info(`Processing: ${filename}`);
    
    try {
        // 1. 取得檔案雜湊
        const contentHash = await getFileHash(filepath);
        
        // 2. 解析內容
        const content = await parseFile(filepath);
        
        if (!content || content.trim().length === 0) {
            logger.warn(`Empty content: ${filename}`);
            return;
        }
        
        // 3. 切分 chunks
        const chunks = splitIntoChunks(content);
        logger.info(`Split into ${chunks.length} chunks`);
        
        // 4. 刪除舊資料
        await deleteOldChunks(sourceId);
        
        // 5. 上傳新 chunks
        const uploaded = await uploadChunks(chunks, {
            source_id: sourceId,
            filename: filename,
            filepath: filepath,
            content_hash: contentHash,
            indexed_at: new Date().toISOString()
        });
        
        logger.info(`Indexed ${uploaded} chunks for: ${filename}`);
        
    } catch (error) {
        logger.error(`Failed to process ${filename}:`, error.message);
    }
}

/**
 * 處理目錄中的所有文件
 */
async function processAllFiles() {
    try {
        const files = await fs.readdir(CONFIG.knowledgeDir);
        const supportedExts = ['.pdf', '.docx', '.doc', '.txt', '.md', '.markdown'];
        
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (supportedExts.includes(ext)) {
                await processFile(path.join(CONFIG.knowledgeDir, file));
            }
        }
        
        logger.info('Initial indexing completed');
    } catch (error) {
        logger.error('Initial indexing failed:', error.message);
    }
}

// ============================================
// 主程式
// ============================================

async function main() {
    logger.info('Indexer service starting...');
    
    // 確保 knowledge 目錄存在
    await fs.ensureDir(CONFIG.knowledgeDir);
    
    // 確保 Qdrant 集合存在
    await ensureCollection();
    
    // 處理現有文件
    await processAllFiles();
    
    // 監控文件變化
    const watcher = chokidar.watch(CONFIG.knowledgeDir, {
        ignored: /(^|[\/\\])\../,  // 忽略隱藏檔
        persistent: true,
        awaitWriteFinish: {
            stabilityThreshold: 2000,
            pollInterval: 100
        }
    });
    
    watcher
        .on('add', async (filepath) => {
            logger.info(`File added: ${path.basename(filepath)}`);
            await processFile(filepath);
        })
        .on('change', async (filepath) => {
            logger.info(`File changed: ${path.basename(filepath)}`);
            await processFile(filepath);
        })
        .on('unlink', async (filepath) => {
            logger.info(`File removed: ${path.basename(filepath)}`);
            const sourceId = crypto.createHash('md5').update(filepath).digest('hex');
            await deleteOldChunks(sourceId);
        })
        .on('error', (error) => {
            logger.error('Watcher error:', error);
        });
    
    logger.info(`Watching directory: ${CONFIG.knowledgeDir}`);
}

main().catch(error => {
    logger.error('Fatal error:', error);
    process.exit(1);
});
