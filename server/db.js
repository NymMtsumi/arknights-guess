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
  ]) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {}
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
