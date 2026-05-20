const fs = require('fs');
const path = require('path');
const db = require('../db');

const WORD_LENGTH = 2;
const MAX_WRONG_COUNT = Math.max(1, Number.parseInt(process.env.NOITU_MAX_WRONG || '3', 10) || 3);
const DEFAULT_MODE = 'bot';
const MODES = new Set(['bot', 'pvp']);

const schemaReady = new Set();
const disabledCache = new Map();
const DISABLED_CACHE_MS = 60_000;

function normalizeVietnamese(text) {
  let normalized = String(text || '').toLowerCase().trim();

  const rules = [
    {
      pattern: /o[àáảãạ](?=$|[^\p{L}])/gu,
      replace: (m) => ({ 'oà': 'òa', 'oá': 'óa', 'oả': 'ỏa', 'oã': 'õa', 'oạ': 'ọa' }[m] || m)
    },
    {
      pattern: /u[ýỳỷỹỵ](?=$|[^\p{L}])/gu,
      replace: (m, offset, str) => {
        if (offset > 0 && str[offset - 1] === 'q') return m;
        return { 'uý': 'úy', 'uỳ': 'ùy', 'uỷ': 'ủy', 'uỹ': 'ũy', 'uỵ': 'ụy' }[m] || m;
      }
    },
    { pattern: /hoà(?=$|[^\p{L}])/gu, replace: () => 'hòa' },
    { pattern: /toà(?=$|[^\p{L}])/gu, replace: () => 'tòa' }
  ];

  for (const rule of rules) normalized = normalized.replace(rule.pattern, (...args) => rule.replace(...args));
  return normalized;
}

function normalizePhrase(text) {
  return normalizeVietnamese(text)
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadWords() {
  const file = path.join(__dirname, '..', 'assets', 'wordPairs.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pairs = Object.create(null);
  const words = [];

  for (const [first, seconds] of Object.entries(raw)) {
    const key = normalizePhrase(first);
    if (!key) continue;
    if (!pairs[key]) pairs[key] = [];

    for (const value of Array.isArray(seconds) ? seconds : []) {
      const second = normalizePhrase(value);
      if (!second || pairs[key].includes(second)) continue;
      pairs[key].push(second);
      words.push(`${key} ${second}`);
    }
  }

  return { pairs, words, wordSet: new Set(words) };
}

const { pairs: wordPairs, words: listWords, wordSet } = loadWords();

function firstWord(word) {
  return normalizePhrase(word).split(' ')[0] || '';
}

function lastWord(word) {
  const parts = normalizePhrase(word).split(' ').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function hasContinuation(start, history = []) {
  const used = new Set((history || []).map(normalizePhrase));
  const values = wordPairs[start] || [];
  return values.some((second) => {
    if (second === start) return false;
    const full = `${start} ${second}`;
    return !used.has(full) && (wordPairs[second] || []).length > 0;
  });
}

function uniqueWord(start) {
  return !hasContinuation(start, []);
}

function newWord() {
  for (let i = 0; i < 500; i += 1) {
    const word = pick(listWords);
    if (word && !uniqueWord(lastWord(word))) return word;
  }
  return pick(listWords) || 'việt nam';
}

function getWordStartingWith(start, history = []) {
  const values = wordPairs[start] || [];
  if (!values.length) return null;

  const used = new Set((history || []).map(normalizePhrase));
  const available = values
    .map((second) => `${start} ${second}`)
    .filter((word) => !used.has(word));

  const valid = available.filter((word) => {
    const tail = lastWord(word);
    return tail !== start && (wordPairs[tail] || []).length > 0;
  });

  const pool = valid.length ? valid : available;
  return pool.length ? pick(pool) : null;
}

async function ensureSchema(guildId) {
  const key = String(guildId || '');
  if (schemaReady.has(key)) return;

  await db.queryGuild(key, `
    CREATE TABLE IF NOT EXISTS noitu_games (
      guild_id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      mode TEXT NOT NULL DEFAULT 'bot',
      current_word TEXT,
      history JSONB NOT NULL DEFAULT '[]'::jsonb,
      players JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (mode IN ('bot', 'pvp'))
    )
  `, []);

  await db.queryGuild(key, `CREATE INDEX IF NOT EXISTS idx_noitu_games_enabled ON noitu_games(enabled)`, []);
  schemaReady.add(key);
}

function mapGame(row, guildId) {
  return {
    guildId: String(row?.guild_id || guildId),
    enabled: Boolean(row?.enabled),
    mode: MODES.has(row?.mode) ? row.mode : DEFAULT_MODE,
    word: row?.current_word || null,
    history: Array.isArray(row?.history) ? row.history.map(normalizePhrase).filter(Boolean) : [],
    players: row?.players && typeof row.players === 'object' && !Array.isArray(row.players) ? row.players : {}
  };
}

async function readGame(guildId) {
  await ensureSchema(guildId);
  const { rows } = await db.queryGuild(String(guildId), `SELECT * FROM noitu_games WHERE guild_id=$1`, [String(guildId)]);
  return rows[0] ? mapGame(rows[0], guildId) : null;
}

async function saveGame(game) {
  await ensureSchema(game.guildId);
  const { rows } = await db.queryGuild(String(game.guildId), `
    INSERT INTO noitu_games (guild_id, enabled, mode, current_word, history, players, updated_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
    ON CONFLICT (guild_id) DO UPDATE SET
      enabled=EXCLUDED.enabled,
      mode=EXCLUDED.mode,
      current_word=EXCLUDED.current_word,
      history=EXCLUDED.history,
      players=EXCLUDED.players,
      updated_at=now()
    RETURNING *
  `, [
    String(game.guildId),
    Boolean(game.enabled),
    MODES.has(game.mode) ? game.mode : DEFAULT_MODE,
    game.word || null,
    JSON.stringify(Array.isArray(game.history) ? game.history : []),
    JSON.stringify(game.players && typeof game.players === 'object' ? game.players : {})
  ]);
  return mapGame(rows[0], game.guildId);
}

function freshGame(guildId, mode = DEFAULT_MODE, enabled = true, players = {}) {
  const word = newWord();
  return {
    guildId: String(guildId),
    enabled,
    mode: MODES.has(mode) ? mode : DEFAULT_MODE,
    word,
    history: [word],
    players: players && typeof players === 'object' ? players : {}
  };
}

async function enableGame(guildId) {
  disabledCache.delete(String(guildId));
  const existing = await readGame(guildId);
  const game = existing || freshGame(guildId, DEFAULT_MODE, true);
  game.enabled = true;
  if (!game.word) {
    game.word = newWord();
    game.history = [game.word];
  }
  if (!Array.isArray(game.history) || !game.history.length) game.history = [game.word];
  return saveGame(game);
}

async function disableGame(guildId) {
  disabledCache.set(String(guildId), Date.now() + DISABLED_CACHE_MS);
  await ensureSchema(guildId);
  const { rowCount } = await db.queryGuild(String(guildId), `DELETE FROM noitu_games WHERE guild_id=$1`, [String(guildId)]);
  return rowCount > 0;
}

async function setMode(guildId, mode) {
  disabledCache.delete(String(guildId));
  const nextMode = String(mode || '').toLowerCase();
  if (!MODES.has(nextMode)) throw new Error('Mode phải là bot hoặc pvp.');
  const game = (await readGame(guildId)) || freshGame(guildId, nextMode, true);
  game.mode = nextMode;
  game.enabled = true;
  if (!game.word) {
    game.word = newWord();
    game.history = [game.word];
  }
  return saveGame(game);
}

async function resetGame(guildId) {
  disabledCache.delete(String(guildId));
  const old = (await readGame(guildId)) || freshGame(guildId, DEFAULT_MODE, true);
  const game = freshGame(guildId, old.mode || DEFAULT_MODE, true, old.players || {});
  return saveGame(game);
}

function getPlayer(game, userId) {
  const id = String(userId);
  const raw = game?.players?.[id] || {};
  return {
    currentStreak: Number(raw.currentStreak || 0),
    bestStreak: Number(raw.bestStreak || 0),
    wins: Number(raw.wins || 0),
    wrongCount: Number(raw.wrongCount || 0)
  };
}

function setPlayer(game, userId, stats) {
  game.players = game.players && typeof game.players === 'object' ? game.players : {};
  game.players[String(userId)] = {
    currentStreak: Math.max(0, Number(stats.currentStreak || 0)),
    bestStreak: Math.max(0, Number(stats.bestStreak || 0)),
    wins: Math.max(0, Number(stats.wins || 0)),
    wrongCount: Math.max(0, Number(stats.wrongCount || 0))
  };
}

function makeStatsLine(stats) {
  return `Chuỗi: ${stats.currentStreak || 0} | Kỷ lục: ${stats.bestStreak || 0} | Thắng: ${stats.wins || 0}`;
}

function failMove(game, userId, code, reason) {
  const stats = getPlayer(game, userId);
  stats.wrongCount += 1;

  if (stats.wrongCount >= MAX_WRONG_COUNT) {
    const before = { ...stats };
    stats.currentStreak = 0;
    stats.wrongCount = 0;
    setPlayer(game, userId, stats);

    if (game.mode !== 'pvp') {
      game.word = newWord();
      game.history = [game.word];
    }

    return {
      type: 'error',
      code,
      game,
      stats,
      reset: true,
      message: `💥 Sai ${MAX_WRONG_COUNT} lần. ${reason}\n${makeStatsLine(before)}\n${game.mode === 'pvp' ? `Từ hiện tại: ${game.word}` : `Từ mới: ${game.word}`}`
    };
  }

  setPlayer(game, userId, stats);
  return {
    type: 'error',
    code,
    game,
    stats,
    reset: false,
    message: `❌ ${reason}\nCòn ${MAX_WRONG_COUNT - stats.wrongCount} lượt sai. Từ hiện tại: ${game.word}`
  };
}

function processMove(game, input, userId) {
  const playerWord = normalizePhrase(input);
  if (!playerWord || playerWord.split(' ').length !== WORD_LENGTH) {
    const required = game.word ? lastWord(game.word) : '...';
    return {
      type: 'error',
      code: 'invalid_format',
      game,
      message: `⚠️ Nhập đúng 2 từ. Từ đầu cần là: ${required}`
    };
  }

  if (!game.word) {
    game.word = newWord();
    game.history = [game.word];
    return { type: 'info', code: 'new', game, message: `🎮 Game mới bắt đầu. Từ hiện tại: ${game.word}` };
  }

  const required = lastWord(game.word);
  if (firstWord(playerWord) !== required) {
    return {
      type: 'error',
      code: 'mismatch',
      game,
      message: `❌ Phải bắt đầu bằng: ${required}\nTừ hiện tại: ${game.word}`
    };
  }

  if ((game.history || []).map(normalizePhrase).includes(playerWord)) {
    return failMove(game, userId, 'repeated', 'Từ này đã dùng rồi.');
  }

  if (!wordSet.has(playerWord)) {
    return failMove(game, userId, 'not_in_dict', 'Từ không có trong bộ từ điển.');
  }

  const stats = getPlayer(game, userId);
  stats.currentStreak += 1;
  stats.bestStreak = Math.max(stats.bestStreak || 0, stats.currentStreak);
  stats.wrongCount = 0;

  const history = Array.isArray(game.history) ? game.history : [];

  if (game.mode === 'pvp') {
    history.push(playerWord);
    game.history = history;
    game.word = playerWord;

    const next = getWordStartingWith(lastWord(playerWord), history);
    if (!next) {
      stats.wins += 1;
      setPlayer(game, userId, stats);
      const oldTail = lastWord(playerWord);
      game.word = newWord();
      game.history = [game.word];
      return {
        type: 'success',
        code: 'win',
        game,
        stats,
        message: `🏆 Thắng! "${oldTail}" không còn từ nối.\n${makeStatsLine(stats)}\nTừ mới: ${game.word}`
      };
    }

    setPlayer(game, userId, stats);
    return {
      type: 'success',
      code: 'ok',
      game,
      stats,
      message: `✅ Hợp lệ. Từ hiện tại: ${game.word}\n${makeStatsLine(stats)}`
    };
  }

  const botWord = getWordStartingWith(lastWord(playerWord), history);
  if (!botWord) {
    stats.wins += 1;
    setPlayer(game, userId, stats);
    const oldTail = lastWord(playerWord);
    game.word = newWord();
    game.history = [game.word];
    return {
      type: 'success',
      code: 'win',
      game,
      stats,
      message: `🏆 Bạn thắng! "${oldTail}" không còn từ nối.\n${makeStatsLine(stats)}\nTừ mới: ${game.word}`
    };
  }

  if (uniqueWord(lastWord(botWord))) {
    const before = { ...stats };
    stats.currentStreak = 0;
    stats.wrongCount = 0;
    setPlayer(game, userId, stats);
    game.word = newWord();
    game.history = [game.word];
    return {
      type: 'error',
      code: 'loss',
      game,
      stats,
      message: `😵 Bot: ${botWord}\nBạn thua, bot chặn được chuỗi.\n${makeStatsLine(before)}\nTừ mới: ${game.word}`
    };
  }

  history.push(playerWord, botWord);
  game.history = history.slice(-500);
  game.word = botWord;
  setPlayer(game, userId, stats);
  return {
    type: 'success',
    code: 'ok',
    game,
    stats,
    message: `✅ Bạn: ${playerWord}\n🤖 Bot: ${botWord}\n${makeStatsLine(stats)}`
  };
}

async function playMessage(guildId, userId, text) {
  const game = await readGame(guildId);
  if (!game || !game.enabled) return null;
  const result = processMove(game, text, userId);
  await saveGame(result.game);
  return result;
}

async function handleNoiTuMessage(message) {
  const guildId = String(message.guild.id);
  const disabledUntil = disabledCache.get(guildId) || 0;
  if (disabledUntil > Date.now()) return false;

  const game = await readGame(guildId);
  if (!game || !game.enabled) {
    disabledCache.set(guildId, Date.now() + DISABLED_CACHE_MS);
    return false;
  }
  const result = processMove(game, message.content, message.author.id);
  await saveGame(result.game);
  await message.reply(result.message).catch(() => null);
  return true;
}

async function getStats(guildId, userId) {
  const game = await readGame(guildId);
  const stats = game ? getPlayer(game, userId) : getPlayer({ players: {} }, userId);
  return { game, stats };
}

async function getTop(guildId, limit = 10) {
  const game = await readGame(guildId);
  if (!game) return [];
  return Object.entries(game.players || {})
    .map(([userId, stats]) => ({ userId, ...getPlayer({ players: { [userId]: stats } }, userId) }))
    .sort((a, b) => (b.bestStreak - a.bestStreak) || (b.wins - a.wins) || (b.currentStreak - a.currentStreak))
    .slice(0, limit);
}

async function lookupWord(word) {
  const value = normalizePhrase(word);
  if (!value) return 'Nhập từ cần tra cứu.';

  const local = wordSet.has(value) ? 'Có trong bộ từ nối từ.' : 'Chưa có trong bộ từ nối từ.';

  try {
    const url = `https://minhqnd.com/api/dictionary/lookup?word=${encodeURIComponent(value)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return `📖 ${value}\n${local}`;
    const data = await response.json();
    const meanings = Array.isArray(data?.meanings) ? data.meanings.slice(0, 3) : [];
    if (!meanings.length) return `📖 ${value}\n${local}\nKhông tìm thấy nghĩa từ API.`;

    const lines = meanings.map((m, i) => {
      const def = String(m.definition || '').trim();
      const pos = [m.pos, m.sub_pos].filter(Boolean).join(' · ');
      const ex = String(m.example || '').trim();
      return `${i + 1}. ${def}${pos ? ` (${pos})` : ''}${ex ? `\nVD: ${ex}` : ''}`;
    });

    return `📖 ${data.word || value}\n${local}\n${lines.join('\n')}`;
  } catch {
    return `📖 ${value}\n${local}\nKhông thể gọi API từ điển lúc này.`;
  }
}

function helpText() {
  return [
    '🎮 Nối từ tiếng Việt',
    'Luật: nhập 2 từ, từ đầu phải trùng từ cuối hiện tại.',
    '',
    '/noitu add - bật phòng chơi',
    '/noitu remove - tắt và xoá dữ liệu phòng',
    '/noitu mode bot|pvp - đổi chế độ',
    '/newgame - đổi từ mới',
    '/stats - xem thống kê',
    '/tratu <từ> - tra từ',
    '',
    'Ví dụ: Từ hiện tại “chân trời” → nhập “trời xanh”.'
  ].join('\n');
}

function statusText(game) {
  if (!game || !game.enabled) return 'Nối từ đang tắt trong chat này.';
  return `🎮 Nối từ đang bật\nMode: ${game.mode}\nTừ hiện tại: ${game.word || 'chưa có'}\nĐã dùng: ${(game.history || []).length} từ`;
}

module.exports = {
  MAX_WRONG_COUNT,
  normalizeVietnamese,
  normalizePhrase,
  firstWord,
  lastWord,
  wordPairs,
  listWords,
  wordSet,
  enableGame,
  disableGame,
  setMode,
  resetGame,
  readGame,
  saveGame,
  playMessage,
  handleNoiTuMessage,
  getStats,
  getTop,
  lookupWord,
  helpText,
  statusText
};
