const Database = require("better-sqlite3");
const db = new Database("/opt/liyiba/data.db");

const userDups = db.prepare(`
  SELECT user_id, daily_date, COUNT(*) as cnt
  FROM games
  WHERE mode='daily' AND user_id IS NOT NULL AND daily_date IS NOT NULL
  GROUP BY user_id, daily_date
  HAVING cnt > 1
`).all();
console.log("User duplicates:", JSON.stringify(userDups, null, 2));

const guestDups = db.prepare(`
  SELECT player_key, daily_date, COUNT(*) as cnt
  FROM games
  WHERE mode='daily' AND user_id IS NULL AND daily_date IS NOT NULL
  GROUP BY player_key, daily_date
  HAVING cnt > 1
`).all();
console.log("Guest duplicates:", JSON.stringify(guestDups, null, 2));

const indexes = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type='index' AND name LIKE '%daily%'
`).all();
console.log("Daily indexes:", JSON.stringify(indexes, null, 2));

db.close();
