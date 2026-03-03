/**
 * MySQL 資料庫連接模組
 */

const mysql = require('mysql2/promise');

// 連接池設定
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'mysql',
    port: process.env.DB_PORT || 3306,
    database: process.env.DB_NAME || 'linebot',
    user: process.env.DB_USER || 'linebot',
    password: process.env.DB_PASSWORD || 'linebot123',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

/**
 * 執行 SQL 查詢
 * @param {string} sql - SQL 語句
 * @param {array} params - 參數
 */
async function query(sql, params = []) {
    const [results] = await pool.execute(sql, params);
    return results;
}

/**
 * 執行事務
 * @param {function} callback - 事務回調函數
 */
async function transaction(callback) {
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    
    try {
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = {
    mysql: { query },
    pool,
    query
};
