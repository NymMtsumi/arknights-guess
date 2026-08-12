import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// ===== 危险操作保护 =====
const forceFlag = process.argv.includes('--i-am-sure');
if (!forceFlag) {
  console.error('⚠️  此脚本将删除数据库中的所有用户和游戏数据！');
  console.error('⚠️  这不可逆！');
  console.error('');
  console.error('如果确定要执行，请使用: node server/scripts/reset-and-create-admins.js --i-am-sure');
  console.error('或者在生产环境设置环境变量: CONFIRM_RESET_DB=yes');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data.db');

console.log('正在连接数据库...');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 二次确认
const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
const gameCount = db.prepare('SELECT COUNT(*) as cnt FROM games').get().cnt;
console.log(`\n当前数据库状态：`);
console.log(`  用户: ${userCount}`);
console.log(`  对局: ${gameCount}`);
console.log(`\n即将删除以上所有数据...\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const confirmed = await new Promise(resolve => {
  rl.question('输入 "DELETE" 确认操作: ', answer => { rl.close(); resolve(answer === 'DELETE'); });
});
if (!confirmed) {
  console.log('已取消。');
  db.close();
  process.exit(0);
}
db.exec('DELETE FROM games');
db.exec('DELETE FROM email_verifications');
db.exec('DELETE FROM pending_registrations');
db.exec('DELETE FROM users');
db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users', 'games', 'email_verifications', 'pending_registrations')");
console.log('已清空所有账号和游戏数据。');

// ===== 第二步：创建管理员账号 =====
// 密码必须从环境变量提供（ADMIN_PASSWORD 或 ADMIN_PASSWORD_<USERNAME>），
// 缺失则生成随机强密码并打印（不再硬编码弱密码）。
function resolveAdminPassword(username) {
  const perUser = process.env['ADMIN_PASSWORD_' + username.toUpperCase()];
  if (perUser && perUser.length >= 8) return perUser;
  const shared = process.env.ADMIN_PASSWORD;
  if (shared && shared.length >= 8) return shared;
  return randomBytes(12).toString('base64url'); // 16 字符随机强密码
}

const ADMINS = [
  { username: 'aLurta', displayId: '1109' },
  { username: 'NymMutsumi', displayId: '0210' },
];

const insertUser = db.prepare(`
  INSERT INTO users (username, password_hash, display_id, nickname, role, email, email_verified_at, player_key, created_at)
  VALUES (?, ?, ?, ?, 'admin', ?, datetime('now'), ?, datetime('now'))
`);

for (const admin of ADMINS) {
  const adminPassword = resolveAdminPassword(admin.username);
  const passwordHash = bcrypt.hashSync(adminPassword, 10);
  const playerKey = 'p_' + randomBytes(9).toString('base64url');

  // 生成唯一 email（用于防重复）
  const email = `${admin.username.toLowerCase()}@admin.arknights-guess.online`;

  insertUser.run(admin.username, passwordHash, admin.displayId, admin.username, email, playerKey);

  console.log(`✅ 已创建管理员: ${admin.username} (display_id: #${admin.displayId})`);
  console.log(`   🔑 密码: ${adminPassword}`);
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
