/**
 * 資料庫模組
 */

const mysql = require('mysql2/promise');

// 資料庫連線池
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'mysql',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'linebot',
    password: process.env.DB_PASSWORD || 'linebot123',
    database: process.env.DB_NAME || 'linebot',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 建表 SQL
const CREATE_TABLES = `
-- 用戶資料表
CREATE TABLE IF NOT EXISTS t_users (
    user_id VARCHAR(50) PRIMARY KEY,
    display_name VARCHAR(100),
    picture_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 對話記錄表
CREATE TABLE IF NOT EXISTS t_messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    message_type ENUM('user', 'bot', 'owner') NOT NULL,
    content TEXT,
    create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_create_time (create_time)
);

-- 自動回覆記錄表
CREATE TABLE IF NOT EXISTS t_auto_replies (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    user_message TEXT,
    final_reply TEXT,
    rag_context JSON,
    retrieval_time_ms INT,
    generation_time_ms INT,
    create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_create_time (create_time)
);

-- Owner 語氣特徵表
CREATE TABLE IF NOT EXISTS t_owner_styles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_user_id VARCHAR(50) NOT NULL UNIQUE,
    avg_sentence_length VARCHAR(20),
    common_phrases JSON,
    formality_level INT,
    punctuation_style VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
`;

/**
 * 初始化資料庫表
 */
async function initialize() {
    const connection = await pool.getConnection();
    try {
        // 執行建表 SQL
        const statements = CREATE_TABLES.split(';').filter(s => s.trim());
        for (const statement of statements) {
            if (statement.trim()) {
                await connection.query(statement);
            }
        }
        console.log('Database tables initialized');
    } finally {
        connection.release();
    }
}

/**
 * 執行查詢
 */
async function query(sql, params) {
    const [rows] = await pool.query(sql, params);
    return rows;
}

module.exports = {
    mysql: {
        initialize,
        query
    }
};
