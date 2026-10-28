// repository 只寫一份,底下掛兩個 driver。介面刻意保持最小:
//   get / all / run / transaction,加上少數幾個無法可攜的方言片段。
//
// 刻意**不做 SQL 翻譯器**。合約叢集掃過之後,不可攜的地方只有 10 處
// (4 個 upsert、2 個 INSERT OR IGNORE、1 個 datetime 比較、1 個 MAX(a,b)、
// 2 處具名參數),明確處理這幾處遠比對整段 SQL 做正規表示式改寫安全。

const NAMED_PARAM = /@([a-zA-Z_][a-zA-Z0-9_]*)/g;

// better-sqlite3 用 @name,mysql2 只吃 ? 位置參數。轉換在 driver 內做,
// repository 兩邊都可以照原本的寫法寫。
function toPositional(sql, params) {
  if (Array.isArray(params)) return { sql, params };
  const values = [];
  const converted = sql.replace(NAMED_PARAM, (match, name) => {
    if (!(name in params)) throw new Error(`missing named parameter: ${name}`);
    values.push(params[name]);
    return '?';
  });
  return { sql: converted, params: values };
}

const SQLITE_DIALECT = {
  name: 'sqlite',
  insertIgnore: 'INSERT OR IGNORE',
  // SQLite 的 MAX() 接受兩個純量參數;MySQL 的 MAX() 是聚合函數,只吃一個。
  greatest: (left, right) => `MAX(${left}, ${right})`,
  // SQLite 的 datetime('now') 回傳 UTC。
  utcNow: () => "datetime('now')",
  utcValue: (column) => `datetime(${column})`,
  onConflict: (columns) => `ON CONFLICT(${columns}) DO UPDATE SET`,
  incoming: (column) => `excluded.${column}`
};

const MYSQL_DIALECT = {
  name: 'mysql',
  insertIgnore: 'INSERT IGNORE',
  greatest: (left, right) => `GREATEST(${left}, ${right})`,
  utcNow: () => 'UTC_TIMESTAMP()',
  // 欄位已經是 DATETIME,不需要再轉換。
  utcValue: (column) => column,
  // MySQL 的 upsert 不指定衝突欄位,由唯一索引決定。
  onConflict: () => 'ON DUPLICATE KEY UPDATE',
  incoming: (column) => `VALUES(${column})`
};

function sqliteDriver(db) {
  const driver = {
    dialect: SQLITE_DIALECT,

    // 合約證據檔案的存放位置歷來是從 SQLite 檔案位置推導的(測試的暫存 DB 也
    // 依賴這點)。mysql driver 沒有這個方法,呼叫端會改用明確設定。
    sqliteFile() {
      const entry = db.pragma('database_list').find((row) => row.name === 'main');
      return entry ? entry.file : null;
    },

    async get(sql, params = []) {
      const query = toPositional(sql, params);
      return db.prepare(query.sql).get(...query.params);
    },

    async all(sql, params = []) {
      const query = toPositional(sql, params);
      return db.prepare(query.sql).all(...query.params);
    },

    async run(sql, params = []) {
      const query = toPositional(sql, params);
      const result = db.prepare(query.sql).run(...query.params);
      return { changes: result.changes, insertId: Number(result.lastInsertRowid) };
    },

    // 刻意不用 better-sqlite3 的 db.transaction()。它要求傳入的函式是**同步**的;
    // 傳 async function 進去,它會在 promise 還沒 resolve 時就 commit,造成靜默的
    // 資料錯誤。所以這裡自己下 BEGIN IMMEDIATE / COMMIT / ROLLBACK。
    //
    // 注意:交易進行中不可 await 外部呼叫(LINE、AI、檔案上傳)。SQLite 同時
    // 只有一個 writer,交易期間讓出事件迴圈會讓其他請求撞上
    // "cannot start a transaction within a transaction"。
    async transaction(fn) {
      if (db.inTransaction) {
        return fn(driver);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(driver);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return driver;
}

// connection 必須是 mysql2/promise 的**單一連線**,不是 pool。
// 對 pool 下 BEGIN 再下 UPDATE,兩句可能落在不同 session,交易保證會靜默消失。
function mysqlDriver(connection, { owned = false } = {}) {
  const driver = {
    dialect: MYSQL_DIALECT,
    inTransaction: false,

    async get(sql, params = []) {
      const query = toPositional(sql, params);
      const [rows] = await connection.query(query.sql, query.params);
      return rows[0];
    },

    async all(sql, params = []) {
      const query = toPositional(sql, params);
      const [rows] = await connection.query(query.sql, query.params);
      return rows;
    },

    async run(sql, params = []) {
      const query = toPositional(sql, params);
      const [result] = await connection.query(query.sql, query.params);
      return { changes: result.affectedRows, insertId: result.insertId };
    },

    async transaction(fn) {
      if (driver.inTransaction) {
        return fn(driver);
      }
      await connection.beginTransaction();
      driver.inTransaction = true;
      try {
        const result = await fn(driver);
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
        throw error;
      } finally {
        driver.inTransaction = false;
      }
    },

    owned
  };
  return driver;
}

module.exports = {
  MYSQL_DIALECT,
  SQLITE_DIALECT,
  mysqlDriver,
  sqliteDriver,
  toPositional
};
