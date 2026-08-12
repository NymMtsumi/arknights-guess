// 敌方单位独立数据库（与干员 data.db 分离）
// ⚠️ DEPRECATED：敌方单位功能未上线（routes/enemy.js 未在 index.js 接线），
// 本模块仅被未接线路由引用，属死代码。
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

let enemyDb = null;

export function initEnemyDb(dataDir) {
  const dbPath = join(dataDir, 'enemy_data.db');
  const isNew = !existsSync(dbPath);

  enemyDb = new Database(dbPath);
  enemyDb.pragma('journal_mode = WAL');
  enemyDb.pragma('foreign_keys = ON');
  enemyDb.pragma('busy_timeout = 5000');

  // 建表
  enemyDb.exec(`
    CREATE TABLE IF NOT EXISTS enemy_games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_key TEXT NOT NULL,
      user_id INTEGER,
      won INTEGER NOT NULL DEFAULT 0,
      guess_count INTEGER NOT NULL,
      difficulty TEXT NOT NULL,
      target_name TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      mode TEXT DEFAULT 'enemy_single',
      daily_date TEXT
    )
  `);

  // 索引
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_eg_mode_diff ON enemy_games(mode, difficulty)',
    'CREATE INDEX IF NOT EXISTS idx_eg_player_mode ON enemy_games(player_key, mode)',
    'CREATE INDEX IF NOT EXISTS idx_eg_user_ts ON enemy_games(user_id, timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_eg_daily_lb ON enemy_games(mode, daily_date, won)',
    // 每日去重索引
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_eg_daily_user ON enemy_games(user_id, daily_date)
       WHERE user_id IS NOT NULL AND daily_date IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_eg_daily_guest ON enemy_games(player_key, daily_date)
       WHERE user_id IS NULL AND daily_date IS NOT NULL`,
  ];

  for (const sql of indexes) {
    try { enemyDb.exec(sql); } catch (e) { console.warn('[enemy-db] Index failed:', e.message); }
  }

  if (isNew) {
    console.log(`[enemy-db] Created new database: ${dbPath}`);
  } else {
    console.log(`[enemy-db] Opened database: ${dbPath}`);
  }

  return enemyDb;
}

export function getEnemyDb() {
  if (!enemyDb) throw new Error('[enemy-db] Database not initialized — call initEnemyDb() first');
  return enemyDb;
}

export function closeEnemyDb() {
  if (enemyDb) {
    enemyDb.close();
    enemyDb = null;
    console.log('[enemy-db] Closed');
  }
}
