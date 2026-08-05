// 创建/更新管理员账号
// 用法: node scripts/create-admin.js <username> <password>
// 或设置环境变量: ADMIN_USERNAME / ADMIN_PASSWORD

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data.db');

const username = (process.argv[2] || process.env.ADMIN_USERNAME || '').trim();
const password = process.argv[3] || process.env.ADMIN_PASSWORD || '';

if (!username || !password) {
  console.error('用法: node scripts/create-admin.js <username> <password>');
  console.error('或设置环境变量 ADMIN_USERNAME / ADMIN_PASSWORD');
  process.exit(1);
}

if (password.length < 8) {
  console.error('密码至少需要 8 个字符');
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

try {
  // 确保 role 列存在
  try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'"); } catch {}

  const passwordHash = bcrypt.hashSync(password, 10);
  const existing = db.prepare('SELECT id, role FROM users WHERE username = ?').get(username);

  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE id = ?')
      .run(passwordHash, 'admin', existing.id);
    console.log(`[admin] ${username} 已更新为管理员 (id=${existing.id})`);
  } else {
    const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, passwordHash, 'admin');
    console.log(`[admin] ${username} 已创建为管理员 (id=${result.lastInsertRowid})`);
  }
} catch (err) {
  console.error('[admin] 创建失败:', err.message);
  process.exit(1);
} finally {
  db.close();
}
