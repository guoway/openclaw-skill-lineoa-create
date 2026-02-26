/**
 * 文件索引服務
 * 
 * 監控 knowledge/ 目錄，自動將新文件索引到 Qdrant
 * 支援格式：PDF, DOCX, TXT, MD, XLSX
 */

const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const winston = require('winston');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const axios = require('axios');
const XLSX = require('xlsx');

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
    useOllamaEmbeddings: process.env.USE_OLLAMA_EMBEDDINGS === 'true',
    ollamaApiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    ollamaEmbeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || 'bge-m3',
    useGeminiEmbeddings: process.env.USE_GEMINI_EMBEDDINGS === 'true',
    embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    chunkSize: 1000,
    chunkOverlap: 200
};

const COLLECTION_NAME = 'knowledge_base';

// Gemini Embeddings 初始化
let genAI = null;
let embeddingModel = null;

function initGeminiEmbeddings() {
    if (!genAI && CONFIG.useGeminiEmbeddings) {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        genAI = new GoogleGenerativeAI(CONFIG.apiKey);
        embeddingModel = genAI.getGenerativeModel({ model: CONFIG.embeddingModel });
        logger.info(`Initialized Gemini embeddings: ${CONFIG.embeddingModel}`);
    }
}

// ============================================
// 工具函數
// ============================================

async function getFileHash(filepath) {
    const content = await fs.readFile(filepath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

function getEmbeddingDimension() {
    if (CONFIG.useOllamaEmbeddings) {
        return 1024;  // BGE-m3 的維度
    }
    if (CONFIG.useGeminiEmbeddings) {
        return 3072;  // gemini-embedding-001 的維度
    }
    if (CONFIG.embeddingModel.includes('large')) {
        return 3072;
    }
    return 1536;  // text-embedding-3-small 的維度
}

async function getEmbedding(text) {
    try {
        if (CONFIG.useOllamaEmbeddings) {
            const response = await axios.post(`${CONFIG.ollamaApiUrl}/api/embed`, {
                model: CONFIG.ollamaEmbeddingModel,
                input: text
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            });
            return response.data.embeddings[0];
        } else if (CONFIG.useGeminiEmbeddings) {
            initGeminiEmbeddings();
            const result = await embeddingModel.embedContent({
                content: { parts: [{ text }] },
                taskType: 'RETRIEVAL_DOCUMENT'
            });
            return result.embedding.values;
        } else {
            const response = await axios.post(`${CONFIG.baseUrl}/embeddings`, {
                input: text,
                model: CONFIG.embeddingModel
            }, {
                headers: {
                    'Authorization': `Bearer ${CONFIG.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            return response.data.data[0].embedding;
        }
    } catch (error) {
        logger.error('Embedding error:', error.message);
        throw error;
    }
}

function splitIntoChunks(text, chunkSize = CONFIG.chunkSize, overlap = CONFIG.chunkOverlap) {
    const chunks = [];
    let i = 0;
    
    while (i < text.length) {
        const chunk = text.slice(i, i + chunkSize);
        const content = chunk.replace(/[, \n\r\t]/g, '');
        if (content.length > 10) {
            chunks.push(chunk);
        }
        i += chunkSize - overlap;
    }
    
    return chunks;
}

// ============================================
// 文件解析
// ============================================

async function parsePDF(filepath) {
    const buffer = await fs.readFile(filepath);
    const data = await pdfParse(buffer);
    return data.text;
}

async function parseDOCX(filepath) {
    const result = await mammoth.extractRawText({ path: filepath });
    return result.value;
}

async function parseTXT(filepath) {
    return await fs.readFile(filepath, 'utf8');
}

async function parseExcel(filepath) {
    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(filepath);
    let allText = '';
    
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        
        const lines = csv.split('\n').filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            if (/^[,]+$/.test(trimmed)) return false;
            const content = trimmed.replace(/[, ]/g, '');
            return content.length > 0;
        });
        
        if (lines.length > 0) {
            allText += `\n\n=== 工作表: ${sheetName} ===\n`;
            allText += lines.join('\n');
        }
    }
    
    return allText;
}

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
            return await parseTXT(filepath);
        case '.xlsx':
        case '.xls':
            return await parseExcel(filepath);
        default:
            throw new Error(`Unsupported file type: ${ext}`);
    }
}

// ============================================
// Qdrant 操作
// ============================================

async function ensureCollection() {
    try {
        await axios.get(`${CONFIG.qdrantUrl}/collections/${COLLECTION_NAME}`);
    } catch (error) {
        const dimension = getEmbeddingDimension();
        await axios.put(`${CONFIG.qdrantUrl}/collections/${COLLECTION_NAME}`, {
            vectors: { size: dimension, distance: 'Cosine' }
        });
        logger.info(`Created collection: ${COLLECTION_NAME} with dimension ${dimension}`);
    }
}

async function addDocument(id, content, metadata) {
    await ensureCollection();
    
    const vector = await getEmbedding(content);
    
    await axios.put(`${CONFIG.qdrantUrl}/collections/${COLLECTION_NAME}/points`, {
        points: [{
            id: id,
            vector: vector,
            payload: {
                content: content,
                source: metadata.filename,
                filepath: metadata.filepath,
                metadata: metadata
            }
        }]
    });
}

// ============================================
// 文件處理
// ============================================

async function processFile(filepath) {
    try {
        logger.info(`Processing: ${path.basename(filepath)}`);
        
        const text = await parseFile(filepath);
        const chunks = splitIntoChunks(text);
        logger.info(`Split into ${chunks.length} chunks`);
        
        const fileHash = await getFileHash(filepath);
        
        for (let i = 0; i < chunks.length; i++) {
            const chunkId = crypto.createHash('md5')
                .update(`${filepath}_${i}`)
                .digest('hex');
            
            await addDocument(chunkId, chunks[i], {
                filename: path.basename(filepath),
                filepath: filepath,
                source_id: fileHash,
                indexed_at: new Date().toISOString(),
                chunk_index: i,
                total_chunks: chunks.length,
                content_hash: crypto.createHash('sha256').update(chunks[i]).digest('hex')
            });
        }
        
        logger.info(`Indexed ${chunks.length} chunks for: ${path.basename(filepath)}`);
        
    } catch (error) {
        logger.error(`Failed to process ${path.basename(filepath)}:`, error.message);
    }
}

async function processAllFiles() {
    try {
        const supportedExts = ['.pdf', '.docx', '.doc', '.txt', '.md', '.markdown', '.xlsx', '.xls'];
        
        async function walkDir(dir) {
            const items = await fs.readdir(dir, { withFileTypes: true });
            
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                
                if (item.isDirectory()) {
                    await walkDir(fullPath);
                } else if (item.isFile()) {
                    const ext = path.extname(item.name).toLowerCase();
                    if (supportedExts.includes(ext)) {
                        await processFile(fullPath);
                    }
                }
            }
        }
        
        await walkDir(CONFIG.knowledgeDir);
        logger.info('Initial indexing completed');
    } catch (error) {
        logger.error('Initial indexing failed:', error.message);
    }
}

// ============================================
// 監控
// ============================================

function startWatcher() {
    const watcher = chokidar.watch(CONFIG.knowledgeDir, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        ignoreInitial: true
    });
    
    watcher
        .on('add', filepath => {
            logger.info(`File added: ${filepath}`);
            processFile(filepath);
        })
        .on('change', filepath => {
            logger.info(`File changed: ${filepath}`);
            processFile(filepath);
        })
        .on('unlink', filepath => {
            logger.info(`File removed: ${filepath}`);
            // TODO: Remove from Qdrant
        });
    
    logger.info('File watcher started');
}

// ============================================
// 啟動
// ============================================

async function main() {
    logger.info('Indexer service starting...');
    
    // 確保 collection 存在
    await ensureCollection();
    
    // 初始索引
    await processAllFiles();
    
    // 啟動監控
    startWatcher();
}

main().catch(error => {
    logger.error('Indexer failed:', error);
    process.exit(1);
});
