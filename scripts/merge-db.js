// 数据库合并脚本：将当前库的新用户/游戏合并到备份库
// 用法：node scripts/merge-db.js
const Database = require('better-sqlite3');
const path = require('path');

const BACKUP_PATH = process.argv[2] || '/opt/liyiba/data.db.bak-20260805-1515';
const CURRENT_PATH = process.argv[3] || '/opt/liyiba/data.db';
const OUTPUT_PATH = process.argv[4] || '/opt/liyiba/data.db.merged';

console.log('[merge] 开始合并数据库...');
console.log(`  备份库: ${BACKUP_PATH}`);
console.log(`  当前库: ${CURRENT_PATH}`);
console.log(`  输出库: ${OUTPUT_PATH}`);

// 打开两个数据库
const bak = new Database(BACKUP_PATH);
const cur = new Database(CURRENT_PATH);

// 复制备份库到输出位置
const fs = require('fs');
fs.copyFileSync(BACKUP_PATH, OUTPUT_PATH);
const out = new Database(OUTPUT_PATH);

// 启用 WAL + 外键
out.pragma('journal_mode = WAL');
out.pragma('foreign_keys = ON');

// 获取备份库中已有的 username 和 email（去重检查）
const existingUsernames = new Set(
  out.prepare('SELECT username FROM users').all().map(r => r.username.toLowerCase())
);
const existingEmails = new Set(
  out.prepare('SELECT email FROM users WHERE email IS NOT NULL').all().map(r => r.email.toLowerCase())
);

console.log(`  备份库: ${out.prepare('SELECT COUNT(*) as c FROM users').get().c} 用户, ${out.prepare('SELECT COUNT(*) as c FROM games').get().c} 局游戏`);

// 获取当前库的用户
const curUsers = cur.prepare('SELECT * FROM users ORDER BY id').all();
console.log(`  当前库: ${curUsers.length} 用户, ${cur.prepare('SELECT COUNT(*) as c FROM games').get().c} 局游戏`);

let newUsers = 0;
let newGames = 0;
let skippedUsers = 0;

// 事务：插入新用户和他们的游戏
const insertUser = out.prepare(`
  INSERT INTO users (username, display_id, nickname, player_key, password_hash, email, email_verified_at, role, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGame = out.prepare(`
  INSERT INTO games (player_key, won, guess_count, difficulty, target_name, timestamp, mode)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const mergeAll = out.transaction(() => {
  for (const user of curUsers) {
    // 检查是否已存在（按 username 或 email）
    if (existingUsernames.has(user.username.toLowerCase())) {
      console.log(`  [跳过] ${user.username} — 用户名已存在`);
      skippedUsers++;
      continue;
    }
    if (user.email && existingEmails.has(user.email.toLowerCase())) {
      console.log(`  [跳过] ${user.username} — 邮箱已存在`);
      skippedUsers++;
      continue;
    }

    // 插入用户
    insertUser.run(
      user.username,
      user.display_id,
      user.nickname,
      user.player_key,
      user.password_hash,
      user.email,
      user.email_verified_at,
      user.role || 'user',
      user.created_at
    );
    newUsers++;
    console.log(`  [新增] ${user.username} (${user.email || '无邮箱'}) — player_key=${user.player_key?.slice(0, 10)}...`);

    // 获取该用户的游戏记录
    const games = cur.prepare('SELECT * FROM games WHERE player_key = ?').all(user.player_key);
    for (const game of games) {
      insertGame.run(
        game.player_key,
        game.won ? 1 : 0,
        game.guess_count || 0,
        game.difficulty || 'hard',
        game.target_name || '',
        game.timestamp || new Date().toISOString(),
        game.mode || 'single'
      );
      newGames++;
    }
  }
});

try {
  mergeAll();
  console.log(`\n[merge] 完成!`);
  console.log(`  新增用户: ${newUsers}`);
  console.log(`  跳过用户: ${skippedUsers}`);
  console.log(`  新增游戏: ${newGames}`);
  console.log(`  合并后总用户: ${out.prepare('SELECT COUNT(*) as c FROM users').get().c}`);
  console.log(`  合并后总游戏: ${out.prepare('SELECT COUNT(*) as c FROM games').get().c}`);
} catch (err) {
  console.error('[merge] 失败:', err.message);
  out.close();
  cur.close();
  bak.close();
  process.exit(1);
}

out.close();
cur.close();
bak.close();
console.log('[merge] 输出文件:', OUTPUT_PATH);
