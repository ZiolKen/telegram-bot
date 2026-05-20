const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const pkg = require('../package.json');
const { all: commands, findCommand } = require('./commands/_registry');
const { getGuildSettings } = require('./services/guildSettings');
const { handleAutoMod } = require('./services/automod');
const { addXp } = require('./services/leveling');
const { handleNoiTuMessage } = require('./services/noitu');
const { popDueReminders } = require('./services/reminders');
const { listIncidents, createIncident: createIncidentDb, resolveIncident: resolveIncidentDb } = require('./services/incidents');
const { handleButton } = require('./services/gameSessions');
const { renderLandingPage } = require('./web/landing');
const { migrateLegacyEconomyToGlobal } = require('./services/economyMigration');
const { TelegramDiscordAdapter, sendPayload, makeUser, optionless } = require('./telegram/adapter');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TOKEN;
if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in environment variables.');
  process.exit(1);
}

const botStartTime = Date.now();
const lastBoot = new Date().toISOString();
const HOST_PROVIDER = process.env.HOST_PROVIDER || 'Render.com';
const DEFAULT_PREFIX = process.env.DEFAULT_PREFIX || '!';
const USE_POLLING = process.env.TELEGRAM_USE_WEBHOOK !== '1';

function uptime() {
  const ms = Date.now() - botStartTime;
  const totalSeconds = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}h ${m}m ${s}s`;
}

function isoNow() {
  return new Date().toISOString();
}

const services = { api: 'online', gateway: 'offline', commands: 'online' };

async function createIncident(service, title) {
  await createIncidentDb(service, title).catch(() => {});
}

async function resolveIncident(service) {
  await resolveIncidentDb(service).catch(() => {});
}

function parseArgs(input) {
  const out = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(input || '')))) {
    out.push((m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(["'\\])/g, '$1'));
  }
  return out;
}

function splitCommand(text, botUsername) {
  const value = String(text || '').trim();
  if (!value) return null;
  const m = value.match(/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name: m[1].toLowerCase(), args: parseArgs(m[3] || ''), rawArgs: m[3] || '', mode: 'slash' };
}

function splitPrefix(text, prefix) {
  const value = String(text || '').trim();
  if (!value.startsWith(prefix)) return null;
  const rest = value.slice(prefix.length).trim();
  if (!rest) return null;
  const [rawName, ...args] = parseArgs(rest);
  const name = String(rawName || '').toLowerCase();
  if (!name) return null;
  return { name, args, rawArgs: rest.slice(rawName.length).trim(), mode: 'prefix' };
}

function getOptionDefinition(cmd, args) {
  const data = cmd?.slash?.data?.toJSON?.() || null;
  const root = Array.isArray(data?.options) ? data.options : [];
  const subDefs = root.filter(o => o.type === 'subcommand');
  if (!subDefs.length) return { subcommand: null, defs: root, args };
  const requested = String(args[0] || '').toLowerCase();
  const sub = subDefs.find(o => o.name === requested) || subDefs[0];
  return { subcommand: sub?.name || null, defs: sub?.options || [], args: sub?.name === requested ? args.slice(1) : args };
}

function createOptions(cmd, args, message) {
  const parsed = getOptionDefinition(cmd, args);
  const values = new Map();
  const named = new Map();
  const positional = [];

  for (const arg of parsed.args) {
    const m = String(arg).match(/^([a-zA-Z0-9_\-]+)[:=]([\s\S]*)$/);
    if (m) named.set(m[1].toLowerCase(), m[2]);
    else positional.push(arg);
  }

  let pos = 0;
  for (const def of parsed.defs) {
    const key = String(def.name || '').toLowerCase();
    let v = named.has(key) ? named.get(key) : positional[pos++];
    if (v == null && def.type === 'user') {
      const u = message.mentions.users.first();
      if (u) v = u.id;
    }
    if (v != null) values.set(key, v);
  }

  const userFor = (name) => {
    const first = message.mentions.users.first();
    if (first) return first;
    const raw = values.get(String(name || '').toLowerCase());
    if (!raw) return null;
    const id = String(raw).replace(/^@/, '');
    return makeUser({ id, username: id });
  };

  return {
    getSubcommand() { return parsed.subcommand; },
    getString(name, required = false) {
      const v = values.get(String(name || '').toLowerCase());
      if (v == null && required) throw new Error(`Missing option ${name}`);
      return v == null ? null : String(v);
    },
    getInteger(name, required = false) {
      const v = values.get(String(name || '').toLowerCase());
      if (v == null && required) throw new Error(`Missing option ${name}`);
      const n = Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    },
    getNumber(name, required = false) {
      const v = values.get(String(name || '').toLowerCase());
      if (v == null && required) throw new Error(`Missing option ${name}`);
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    },
    getBoolean(name, required = false) {
      const v = values.get(String(name || '').toLowerCase());
      if (v == null && required) throw new Error(`Missing option ${name}`);
      if (v == null) return null;
      return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
    },
    getUser(name) { return userFor(name); },
    getMember(name) {
      const u = userFor(name);
      if (!u) return null;
      return message.mentions.members.first() || { id: u.id, user: u, joinedAt: null, permissions: message.member.permissions };
    },
    getChannel() { return message.channel; },
    getRole() { return null; }
  };
}

function createInteractionFromMessage(message, cmd, args) {
  const interaction = {
    id: message.id,
    commandName: cmd.name,
    user: message.author,
    member: message.member,
    guild: message.guild,
    guildId: message.guild.id,
    channel: message.channel,
    channelId: message.channel.id,
    client: message.client,
    options: cmd?.slash?.data ? createOptions(cmd, args, message) : optionless(),
    replied: false,
    deferred: false,
    isChatInputCommand() { return true; },
    async deferReply() { this.deferred = true; return null; },
    async reply(payload) { this.replied = true; return message.reply(payload); },
    async editReply(payload) { this.replied = true; return message.reply(payload); },
    async followUp(payload) { return message.reply(payload); }
  };
  return interaction;
}

async function registerTelegramCommands(bot) {
  const seen = new Set();
  const list = [];
  for (const c of commands) {
    const names = [c.name, ...(c.telegramAliases || [])];
    for (const raw of names) {
      const name = String(raw || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      list.push({ command: name, description: String(c.description || c.category || 'Command').slice(0, 256) });
    }
  }
  await bot.setMyCommands(list.slice(0, 100)).catch(err => console.warn('Failed to set Telegram commands:', err.message || err));
}

function computeUsers(client) {
  let sum = 0;
  for (const g of client.guilds.cache.values()) sum += Number(g.memberCount || 0);
  return sum;
}

process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION:', err));
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION:', err));

const bot = new TelegramBot(TOKEN, { polling: USE_POLLING ? { interval: 1000, autoStart: true } : false });
const client = new TelegramDiscordAdapter(bot);
const snipeCache = new Map();
const afkMap = new Map();

async function bootstrapBot() {
  try {
    await client.init();
    services.gateway = 'online';
    await resolveIncident('gateway');
    console.log(`Logged in to Telegram as ${client.user.tag}`);

    if (process.env.ECONOMY_AUTO_MIGRATE !== '0') {
      try {
        await migrateLegacyEconomyToGlobal({ force: process.env.ECONOMY_FORCE_MIGRATE === '1' });
      } catch (err) {
        console.warn('[Economy migration] Failed:', err);
      }
    }

    await registerTelegramCommands(bot);

    setInterval(() => {
      console.log(`Telegram update latency: ${Number(client.ws.ping || 0).toFixed(2)}ms`);
    }, 90_000).unref();

    setInterval(async () => {
      try {
        const due = await popDueReminders(20);
        for (const r of due) {
          await bot.sendMessage(r.channel_id, `⏰ Reminder for @${r.user_id}: ${r.text}`, { disable_web_page_preview: true }).catch(() => null);
        }
      } catch (e) {
        console.warn('Reminder scheduler error:', e);
      }
    }, 30_000).unref();
  } catch (err) {
    services.gateway = 'offline';
    await createIncident('gateway', 'Telegram login failed');
    console.error('Telegram login failed:', err);
  }
}

bot.on('polling_error', async err => {
  services.gateway = 'offline';
  await createIncident('gateway', 'Telegram polling error');
  console.error('Telegram polling error:', err.message || err);
});

bot.on('webhook_error', async err => {
  services.gateway = 'offline';
  await createIncident('gateway', 'Telegram webhook error');
  console.error('Telegram webhook error:', err.message || err);
});

bot.on('callback_query', async query => {
  try {
    const interaction = await client.makeCallback(query);
    const handled = await handleButton(interaction);
    if (!handled) await bot.answerCallbackQuery(query.id).catch(() => null);
  } catch (err) {
    console.error('Callback error:', err);
    await bot.answerCallbackQuery(query.id, { text: 'Interaction error.', show_alert: true }).catch(() => null);
  }
});

bot.on('message', async tgMessage => {
  if (!tgMessage.text && !tgMessage.caption) return;
  if (tgMessage.from?.is_bot) return;

  let message;
  try {
    message = await client.makeMessage(tgMessage);
  } catch (err) {
    console.error('Telegram message adapter error:', err);
    return;
  }

  try {
    await handleAutoMod(message);
  } catch (e) {
    console.warn('AutoMod error:', e);
  }

  let settings;
  try {
    settings = await getGuildSettings(message.guild.id);
  } catch {
    settings = { prefix: DEFAULT_PREFIX, level_enabled: false, commands_disabled: false };
  }

  const prefix = settings.prefix || DEFAULT_PREFIX;
  const parsed = splitCommand(message.content, client.me?.username) || splitPrefix(message.content, prefix);

  try {
    const allowCommandXp = process.env.LEVEL_XP_COMMANDS === '1';
    const minLen = Math.max(1, Number.parseInt(process.env.LEVEL_MIN_MESSAGE_LENGTH || '2', 10) || 2);
    const content = String(message.content || '').trim();
    if (settings.level_enabled && content.length >= minLen && (!parsed || allowCommandXp)) {
      const result = await addXp(message.guild.id, message.author.id);
      if (result?.leveledUp) {
        await message.channel.send(`🎉 ${message.author} lên level ${result.level}! ${result.xp}/${result.nextXp} XP`).catch(() => null);
      }
    }
  } catch {}

  try {
    for (const [id] of message.mentions.users) {
      const key = `${message.guild.id}:${id}`;
      const afk = afkMap.get(key);
      if (afk) await message.reply(`💤 @${id} đang AFK: ${afk.reason || 'AFK'}`).catch(() => null);
    }
    const selfKey = `${message.guild.id}:${message.author.id}`;
    if (afkMap.has(selfKey)) {
      afkMap.delete(selfKey);
      await message.reply('✅ Welcome back! AFK removed.').catch(() => null);
    }
  } catch {}

  if (!parsed) {
    if (client.dispatchCollectors(message)) return;
    try {
      const noituHandled = await handleNoiTuMessage(message);
      if (noituHandled) return;
    } catch (e) {
      console.warn('Noi Tu error:', e);
      await message.reply('⚠️ Lỗi nối từ. Thử lại sau.').catch(() => null);
      return;
    }
    return;
  }

  const cmd = findCommand(parsed.name);
  if (!cmd) {
    if (client.dispatchCollectors(message)) return;
    return;
  }

  if (settings.commands_disabled && cmd.name !== 'disable') {
    return;
  }

  try {
    services.commands = 'online';
    await resolveIncident('commands');
    const ctx = { client, commands, uptime, prefix, snipeCache, afkMap };
    if (cmd.prefix?.run) {
      await cmd.prefix.run(message, parsed.args, ctx);
      return;
    }
    if (cmd.slash?.run) {
      const interaction = createInteractionFromMessage(message, cmd, parsed.args);
      await cmd.slash.run(interaction, ctx);
      return;
    }
    await message.reply('⚠️ This command is not available on Telegram yet.').catch(() => null);
  } catch (err) {
    console.error('Command error:', err);
    services.commands = 'offline';
    await createIncident('commands', 'Command execution failed');
    await message.reply(`⚠️ Lỗi lệnh: ${err.message || 'unknown'}`).catch(() => null);
  }
});

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  );
  next();
}

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const cur = hits.get(ip);
    if (!cur || now > cur.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    cur.count += 1;
    if (cur.count > max) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin: '*', methods: ['GET', 'POST'], maxAge: 600 }));
app.use(securityHeaders);
app.use(createRateLimiter({ windowMs: 60_000, max: 120 }));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets'), { maxAge: '7d' }));
app.use('/src/web', express.static(path.join(__dirname, '..', 'src/web'), { maxAge: '7d' }));

if (!USE_POLLING) {
  app.use(express.json({ limit: '2mb' }));
  app.post(`/telegram/${TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

app.get('/', (req, res) => {
  const username = client.me?.username || '';
  const html = renderLandingPage({
    title: username ? `@${username}` : 'Telegram Bot',
    clientId: username,
    permissions: 'telegram',
    statusUrl: process.env.STATUS_URL || ''
  }).replace(/Discord Bot/g, 'Telegram Bot').replace(/Invite Bot/g, 'Open Bot');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
});

app.get('/invite', (req, res) => {
  const username = client.me?.username || process.env.TELEGRAM_BOT_USERNAME || '';
  if (!username) return res.status(503).send('Bot username unavailable.');
  res.redirect(302, `https://t.me/${encodeURIComponent(username)}`);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, status: client.isReady() ? 'online' : 'starting', platform: 'telegram', updated: isoNow() });
});

app.get('/status', async (req, res) => {
  if (!client.isReady()) {
    services.api = 'offline';
    await createIncident('api', 'API unreachable');
    return res.status(503).json({ status: 'offline', platform: 'telegram' });
  }

  services.api = 'online';
  services.gateway = 'online';
  await resolveIncident('api');
  await resolveIncident('gateway');

  res.json({
    status: 'online',
    platform: 'telegram',
    version: pkg.version,
    ping: client.ws.ping,
    uptime: uptime(),
    lastBoot,
    updated: isoNow(),
    host: HOST_PROVIDER,
    chats: client.guilds.cache.size,
    users: computeUsers(client),
    services
  });
});

app.get('/incidents', async (req, res) => {
  const rows = await listIncidents(30).catch(() => []);
  res.json(rows.map(r => ({
    id: r.id,
    service: r.service,
    title: r.title,
    status: r.status,
    startedAt: r.started_at,
    resolvedAt: r.resolved_at
  })));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Express server running on port ${PORT}`);
  await bootstrapBot();
});
