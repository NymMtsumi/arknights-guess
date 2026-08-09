// 数据库 Schema 迁移、定期清理（Database 实例由 index.js 创建并传入）
export function initSchema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ===== Schema =====
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      player_key TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_key TEXT NOT NULL,
      won INTEGER NOT NULL DEFAULT 0,
      guess_count INTEGER NOT NULL DEFAULT 0,
      difficulty TEXT NOT NULL DEFAULT 'hard',
      target_name TEXT NOT NULL DEFAULT '',
      timestamp TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS admin_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      is_popup INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_player_key ON users(player_key);
    CREATE INDEX IF NOT EXISTS idx_games_player_key ON games(player_key);
    CREATE INDEX IF NOT EXISTS idx_pending_reg_token ON pending_registrations(token_hash);
    CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token_hash);
  `);

  // 补充列（兼容旧数据库，列已存在则跳过）
  for (const [table, col, type] of [
    ['users', 'email', 'TEXT'],
    ['users', 'email_verified_at', 'TEXT'],
    ['users', 'nickname', 'TEXT'],
    ['users', 'avatar', 'TEXT'],
    ['users', 'display_id', 'TEXT'],
    ['users', 'role', "TEXT DEFAULT 'user'"],
    ['users', 'banned_at', 'TEXT'],
    ['users', 'token_version', "INTEGER DEFAULT 0"],
    ['games', 'mode', "TEXT DEFAULT 'single'"],
    ['games', 'user_id', "INTEGER REFERENCES users(id)"],
    ['games', 'daily_date', 'TEXT'],
  ]) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {}
  }

  // 创建 user_id 索引（用于按用户查询战绩）
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_games_user_id ON games(user_id)'); } catch {}

  // 清理可能的测试数据
  try {
    const cleanResult = db.prepare("DELETE FROM games WHERE target_name = 'test' OR player_key = 'test'").run();
    if (cleanResult.changes > 0) {
      console.log(`[DB] Cleaned ${cleanResult.changes} test records from games`);
    }
  } catch {}

  // ===== 1. 先清理重复的 pk（确保 users 表 pk 唯一后再回填） =====
  // 保留最早注册的账号（MIN(id)），删除重复 pk 的后续注册
  try {
    const dupResult = db.prepare(`
      DELETE FROM users WHERE id IN (
        SELECT id FROM users WHERE player_key IS NOT NULL AND id NOT IN (
          SELECT MIN(id) FROM users WHERE player_key IS NOT NULL GROUP BY player_key
        )
      )
    `).run();
    if (dupResult.changes > 0) {
      console.log(`[DB] Cleaned ${dupResult.changes} duplicate player_key user records`);
    }
  } catch (e) {
    console.warn('[DB] Duplicate pk cleanup failed:', e.message);
  }

  // ===== 2. 回填历史数据的 user_id（在去重之后执行，确保引用完整性） =====
  try {
    const backfillResult = db.prepare(`
      UPDATE games SET user_id = (
        SELECT u.id FROM users u WHERE u.player_key = games.player_key AND u.player_key IS NOT NULL ORDER BY u.id LIMIT 1
      ) WHERE games.user_id IS NULL AND EXISTS (
        SELECT 1 FROM users u WHERE u.player_key = games.player_key AND u.player_key IS NOT NULL
      )
    `).run();
    if (backfillResult.changes > 0) {
      console.log(`[DB] Backfilled user_id for ${backfillResult.changes} existing game records`);
    }
  } catch (e) {
    console.error('[DB] Backfill user_id FAILED — pre-migration games will be invisible to /api/me and /api/history:', e.message);
  }

  // UNIQUE 索引（兼容旧数据）
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display_id ON users(display_id)'); } catch {}

  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_player_key_unique ON users(player_key)'); } catch (e) {
    console.warn('[DB] Could not create UNIQUE index on users(player_key) — duplicates may exist:', e.message);
  }

  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL AND email != ''"); } catch (e) {
    console.warn('[DB] Could not create UNIQUE index on users(email) — duplicates may exist:', e.message);
  }

  // 性能索引
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_games_mode_diff ON games(mode, difficulty)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_games_player_mode ON games(player_key, mode)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_games_mode_player ON games(mode, player_key)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_games_player_ts ON games(player_key, timestamp DESC)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_admin_actions_action ON admin_actions(action, created_at)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_email_verifications_token ON email_verifications(token_hash)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at)'); } catch {}

  // 每日挑战去重：每个用户每天只能有一条记录
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_games_daily_unique ON games(user_id, daily_date) WHERE user_id IS NOT NULL AND daily_date IS NOT NULL'); } catch {}

  // ===== 定期清理 =====
  // 清理过期记录（每小时）
  setInterval(() => {
    db.prepare("DELETE FROM pending_registrations WHERE datetime(expires_at) < datetime('now')").run();
    db.prepare("DELETE FROM password_resets WHERE datetime(expires_at) < datetime('now')").run();
    // email_verifications 过期清理
    db.prepare("DELETE FROM email_verifications WHERE datetime(expires_at) < datetime('now')").run();
  }, 3600_000);

  return db;
}
