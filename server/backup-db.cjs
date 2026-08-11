// 数据库备份脚本 — 独立于部署流程，通过 cron 定时执行
// CommonJS 格式（.cjs），与项目的 ESM package.json 隔离，避免 require 错误
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data.db');
const BACKUP_DIR = path.join(__dirname, '..');
const MAX_BACKUPS = 14;

try {
  if (!fs.existsSync(DB_PATH)) {
    console.error('[backup] data.db not found at', DB_PATH);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const filename = `data.db.bak-${ts}`;
  const filepath = path.join(BACKUP_DIR, filename);

  // better-sqlite3 backup API — 事务性快照，无需锁定数据库
  db.backup(filepath);
  db.close();
  console.log('[backup] OK:', filename);

  // 清理超过 MAX_BACKUPS 的旧备份
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('data.db.bak-'))
    .sort();
  if (files.length > MAX_BACKUPS) {
    const toDelete = files.slice(0, files.length - MAX_BACKUPS);
    for (const f of toDelete) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      console.log('[backup] deleted old:', f);
    }
  }
} catch (err) {
  console.error('[backup] FAILED:', err.message);
  process.exit(1);
}
