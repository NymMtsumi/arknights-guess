import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===== 第一步：清空所有用户数据 =====
console.log('清空现有数据...');
db.exec('DELETE FROM games');
db.exec('DELETE FROM email_verifications');
db.exec('DELETE FROM pending_registrations');
db.exec('DELETE FROM users');
db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users', 'games', 'email_verifications', 'pending_registrations')");
console.log('已清空所有账号和游戏数据。');

// ===== 第二步：创建管理员账号 =====
const ADMINS = [
  { username: 'aLurta',  password: '12345678', displayId: '1109' },
  { username: 'NymMutsumi', password: '12345678', displayId: '0210' },
];

const insertUser = db.prepare(`
  INSERT INTO users (username, password_hash, display_id, nickname, role, email, email_verified_at, player_key, created_at)
  VALUES (?, ?, ?, ?, 'admin', ?, datetime('now'), ?, datetime('now'))
`);

for (const admin of ADMINS) {
  const passwordHash = bcrypt.hashSync(admin.password, 10);
  const playerKey = 'p_' + randomBytes(9).toString('base64url');

  // 生成唯一 email（用于防重复）
  const email = `${admin.username.toLowerCase()}@admin.arknights-guess.online`;

  insertUser.run(admin.username, passwordHash, admin.displayId, admin.username, email, playerKey);

  console.log(`✅ 已创建管理员: ${admin.username} (display_id: #${admin.displayId})`);
}

// ===== 第三步：验证 =====
const count = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE role = ?').get('admin');
console.log(`\n当前管理员数量: ${count.cnt}`);

const all = db.prepare('SELECT username, display_id, role FROM users').all();
for (const u of all) {
  console.log(`  - ${u.username} (#${u.display_id}) role=${u.role}`);
}

db.close();
console.log('\n完成。');
