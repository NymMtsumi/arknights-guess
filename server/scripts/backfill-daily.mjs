import Database from 'better-sqlite3';
import { join } from 'path';

// PM2 cwd = /opt/liyiba, server opens data.db relative to that
const dbPath = process.env.DB_PATH || join(process.cwd(), 'data.db');
const db = new Database(dbPath);
console.log('Using DB:', dbPath);
db.pragma('journal_mode = WAL');

// 1. 找出会冲突的重复项并删除，保留最早
const conflictGroups = db.prepare(`
  SELECT user_id, date(timestamp) as dt, COUNT(*) as cnt
  FROM games
  WHERE mode = 'daily' AND user_id IS NOT NULL
  GROUP BY user_id, date(timestamp)
  HAVING cnt > 1
`).all();
console.log('[0] Conflict groups:', JSON.stringify(conflictGroups));

for (const g of conflictGroups) {
  const ids = db.prepare(`
    SELECT id FROM games
    WHERE mode = 'daily' AND user_id = ? AND date(timestamp) = ?
    ORDER BY id ASC
  `).all(g.user_id, g.dt);
  const keep = ids[0].id;
  const remove = ids.slice(1).map(r => r.id);
  console.log('    user_id=' + g.user_id + ' date=' + g.dt + ' keep=' + keep + ' remove=' + JSON.stringify(remove));
  for (const rid of remove) {
    db.prepare('DELETE FROM games WHERE id = ?').run(rid);
  }
}
console.log('[0] Duplicates cleaned');

// 2. 回填 daily_date
const backfill = db.prepare(
  "UPDATE games SET daily_date = date(timestamp) WHERE mode = 'daily' AND daily_date IS NULL"
).run();
console.log('[1] Backfilled daily_date for', backfill.changes, 'records');

// 3. 验证排行榜
const lb = db.prepare(`
  SELECT u.username, g.guess_count, g.timestamp, g.daily_date
  FROM games g INNER JOIN users u ON u.id = g.user_id
  WHERE g.mode = 'daily' AND g.daily_date = '2026-08-09' AND g.won = 1
  ORDER BY g.guess_count ASC, g.timestamp ASC LIMIT 10
`).all();
console.log('[2] Today leaderboard:', JSON.stringify(lb));

// 4. 统计
const total = db.prepare("SELECT COUNT(*) as cnt FROM games WHERE mode = 'daily'").get();
const withDate = db.prepare("SELECT COUNT(*) as cnt FROM games WHERE mode = 'daily' AND daily_date IS NOT NULL").get();
console.log('[3] Total daily:', total.cnt, 'with date:', withDate.cnt);
