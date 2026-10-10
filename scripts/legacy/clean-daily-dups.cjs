const Database = require("better-sqlite3");
const db = new Database("/opt/liyiba/data.db");

// Step 1: Remove duplicate guest daily records (keep the earliest by id)
const guestDups = db.prepare(`
  SELECT player_key, daily_date, COUNT(*) as cnt, MIN(id) as keep_id
  FROM games
  WHERE mode='daily' AND user_id IS NULL AND daily_date IS NOT NULL
  GROUP BY player_key, daily_date
  HAVING cnt > 1
`).all();

console.log("Guest duplicates to clean:", JSON.stringify(guestDups, null, 2));

for (const dup of guestDups) {
  const result = db.prepare(`
    DELETE FROM games
    WHERE mode='daily'
      AND user_id IS NULL
      AND player_key = ?
      AND daily_date = ?
      AND id != ?
  `).run(dup.player_key, dup.daily_date, dup.keep_id);
  console.log(`Deleted ${result.changes} duplicate records for ${dup.player_key} on ${dup.daily_date}, kept id=${dup.keep_id}`);
}

// Step 2: Create the missing guest UNIQUE index
try {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_games_daily_guest_unique
    ON games(player_key, daily_date)
    WHERE user_id IS NULL AND daily_date IS NOT NULL
  `);
  console.log("idx_games_daily_guest_unique created successfully");
} catch (e) {
  console.error("Failed to create idx_games_daily_guest_unique:", e.message);
}

// Step 3: Re-verify all indexes
const indexes = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type='index' AND name LIKE '%daily%'
  ORDER BY name
`).all();
console.log("Final daily indexes:", JSON.stringify(indexes.map(i => i.name)));

// Step 4: Verify no duplicates remain
const remainingUserDups = db.prepare(`
  SELECT COUNT(*) as cnt FROM (
    SELECT user_id, daily_date FROM games
    WHERE mode='daily' AND user_id IS NOT NULL AND daily_date IS NOT NULL
    GROUP BY user_id, daily_date HAVING COUNT(*) > 1
  )
`).get();
const remainingGuestDups = db.prepare(`
  SELECT COUNT(*) as cnt FROM (
    SELECT player_key, daily_date FROM games
    WHERE mode='daily' AND user_id IS NULL AND daily_date IS NOT NULL
    GROUP BY player_key, daily_date HAVING COUNT(*) > 1
  )
`).get();
console.log(`Remaining user duplicates: ${remainingUserDups.cnt}`);
console.log(`Remaining guest duplicates: ${remainingGuestDups.cnt}`);

db.close();
console.log("Done.");
