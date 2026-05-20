const db = require('../db');

const cooldown = new Map();

function intEnv(key, def, { min = 0, max = 2147483647 } = {}) {
  const raw = process.env[key];
  if (raw == null || raw === '') return def;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

const XP_MIN = intEnv('LEVEL_XP_MIN', 8, { min: 1, max: 1000 });
const XP_MAX = Math.max(XP_MIN, intEnv('LEVEL_XP_MAX', 18, { min: 1, max: 1000 }));
const COOLDOWN_MS = intEnv('LEVEL_COOLDOWN_SECONDS', 45, { min: 5, max: 3600 }) * 1000;
const MAX_LEVELUPS_PER_MESSAGE = intEnv('LEVEL_MAX_LEVELUPS_PER_MESSAGE', 10, { min: 1, max: 100 });

function randomXp() {
  return Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN;
}

function xpForNext(level) {
  const lv = Math.max(0, Math.trunc(Number(level) || 0));
  return 5 * (lv * lv) + 50 * lv + 100;
}

function progressBar(current, max, size = 10) {
  const total = Math.max(1, Math.trunc(Number(max) || 1));
  const cur = Math.max(0, Math.min(total, Math.trunc(Number(current) || 0)));
  const filled = Math.max(0, Math.min(size, Math.round((cur / total) * size)));
  return '█'.repeat(filled) + '░'.repeat(size - filled);
}

function buildLevelView(row, rank = null) {
  const level = Math.max(0, Math.trunc(Number(row?.level) || 0));
  const xp = Math.max(0, Math.trunc(Number(row?.xp) || 0));
  const nextXp = xpForNext(level);
  const percent = Math.floor((xp / nextXp) * 100);
  return {
    userId: String(row?.user_id || ''),
    level,
    xp,
    nextXp,
    percent,
    rank,
    bar: progressBar(xp, nextXp)
  };
}

async function addXp(guildId, userId, amount = null) {
  const gid = String(guildId || '');
  const uid = String(userId || '');
  if (!gid || !uid) return null;

  const key = `${gid}:${uid}`;
  const last = cooldown.get(key) || 0;
  if (Date.now() - last < COOLDOWN_MS) return null;
  cooldown.set(key, Date.now());

  const gain = Math.max(1, Math.trunc(Number.isInteger(amount) ? amount : randomXp()));

  return db.txGuild(gid, async (client) => {
    await client.query(
      `INSERT INTO user_stats (guild_id, user_id, xp, level)
       VALUES ($1,$2,0,0)
       ON CONFLICT (guild_id,user_id) DO NOTHING`,
      [gid, uid]
    );

    const cur = await client.query(
      `SELECT guild_id, user_id, xp, level
       FROM user_stats
       WHERE guild_id=$1 AND user_id=$2
       FOR UPDATE`,
      [gid, uid]
    );

    let xp = Math.max(0, Math.trunc(Number(cur.rows[0]?.xp) || 0)) + gain;
    let level = Math.max(0, Math.trunc(Number(cur.rows[0]?.level) || 0));
    const oldLevel = level;
    let levelUps = 0;

    while (xp >= xpForNext(level) && levelUps < MAX_LEVELUPS_PER_MESSAGE) {
      xp -= xpForNext(level);
      level += 1;
      levelUps += 1;
    }

    const upd = await client.query(
      `UPDATE user_stats
       SET xp=$3, level=$4
       WHERE guild_id=$1 AND user_id=$2
       RETURNING guild_id, user_id, xp, level`,
      [gid, uid, xp, level]
    );

    const view = buildLevelView(upd.rows[0]);
    return {
      ...view,
      gained: gain,
      oldLevel,
      leveledUp: level > oldLevel,
      levelUps
    };
  });
}

async function getLevel(guildId, userId) {
  const gid = String(guildId || '');
  const uid = String(userId || '');
  const { rows } = await db.queryGuild(
    gid,
    `WITH ins AS (
       INSERT INTO user_stats (guild_id, user_id)
       VALUES ($1,$2)
       ON CONFLICT (guild_id,user_id) DO NOTHING
       RETURNING guild_id, user_id, xp, level
     ), row AS (
       SELECT guild_id, user_id, xp, level FROM ins
       UNION ALL
       SELECT guild_id, user_id, xp, level FROM user_stats WHERE guild_id=$1 AND user_id=$2
       LIMIT 1
     )
     SELECT row.*,
       (
         SELECT COUNT(*) + 1
         FROM user_stats other
         WHERE other.guild_id=$1
           AND (other.level > row.level OR (other.level = row.level AND other.xp > row.xp))
       ) AS rank
     FROM row`,
    [gid, uid]
  );
  return buildLevelView(rows[0], Number(rows[0]?.rank || 1));
}

async function getLevelLeaderboard(guildId, limit = 10) {
  const gid = String(guildId || '');
  const lim = Math.max(1, Math.min(25, Math.trunc(Number(limit) || 10)));
  const { rows } = await db.queryGuild(
    gid,
    `SELECT user_id, xp, level
     FROM user_stats
     WHERE guild_id=$1 AND (level > 0 OR xp > 0)
     ORDER BY level DESC, xp DESC, user_id ASC
     LIMIT $2`,
    [gid, lim]
  );
  return rows.map((row, i) => buildLevelView(row, i + 1));
}

module.exports = {
  addXp,
  getLevel,
  getLevelLeaderboard,
  xpForNext,
  progressBar
};
