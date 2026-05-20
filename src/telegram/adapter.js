const EventEmitter = require('events');
const { AttachmentBuilder } = require('./discordCompat');

class SimpleCollection extends Map {
  first() { return this.values().next().value || null; }
  find(fn) {
    for (const [k, v] of this) if (fn(v, k, this)) return v;
    return undefined;
  }
  map(fn) { return Array.from(this.values()).map(fn); }
  filter(fn) {
    const out = new SimpleCollection();
    for (const [k, v] of this) if (fn(v, k, this)) out.set(k, v);
    return out;
  }
}

function asId(v) {
  if (v == null) return '';
  return String(v);
}

function usernameOf(user) {
  return user?.username || [user?.first_name, user?.last_name].filter(Boolean).join(' ') || `user${user?.id || ''}`;
}

function makeUser(tgUser) {
  const id = asId(tgUser?.id || tgUser);
  const username = usernameOf(tgUser || { id });
  return {
    id,
    username,
    globalName: [tgUser?.first_name, tgUser?.last_name].filter(Boolean).join(' ') || username,
    tag: tgUser?.username ? `@${tgUser.username}` : username,
    bot: Boolean(tgUser?.is_bot),
    createdTimestamp: Date.now(),
    displayAvatarURL() { return ''; },
    bannerURL() { return null; },
    toString() { return tgUser?.username ? `@${tgUser.username}` : username; }
  };
}

function stripMarkdownLite(text) {
  let s = String(text ?? '');

  s = s.replace(/```([\s\S]*?)```/g, '$1');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/_([^_\n]{1,80})_/g, '$1');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => {
    const a = String(label).trim();
    const b = String(url).trim();
    return a && a !== b ? `${a}: ${b}` : b;
  });

  return s;
}

function cleanDiscordMarkup(text) {
  return stripMarkdownLite(text)
    .replace(/<@!?(\d+)>/g, '@$1')
    .replace(/<#(-?\d+)>/g, '#$1')
    .replace(/<@&(-?\d+)>/g, '@role:$1')
    .replace(/tg:\/\/user\?id=(\w+)/g, '@$1')
    .replace(/<t:(\d+):R>/g, (_, sec) => relativeTime(Number(sec) * 1000))
    .replace(/<t:(\d+):D>/g, (_, sec) => new Date(Number(sec) * 1000).toLocaleDateString('en-US'))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function relativeTime(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const units = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1_000]
  ];
  for (const [name, size] of units) {
    if (abs >= size || name === 'second') {
      const n = Math.max(1, Math.round(abs / size));
      return diff >= 0 ? `in ${n} ${name}${n === 1 ? '' : 's'}` : `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
}

function embedToText(embed) {
  const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : (embed?.data || embed || {});
  const lines = [];
  if (data.title) lines.push(String(data.title));
  if (data.description) lines.push(String(data.description));
  if (Array.isArray(data.fields)) {
    for (const f of data.fields) {
      if (!f) continue;
      const name = f.name ? String(f.name).trim() : '';
      const value = f.value == null ? '' : String(f.value).trim();
      if (!name && !value) continue;
      lines.push(name ? `${name}: ${value || '-'}` : value);
    }
  }
  if (data.footer?.text) lines.push(String(data.footer.text));
  if (data.image?.url) lines.push(data.image.url);
  if (data.thumbnail?.url) lines.push(data.thumbnail.url);
  return cleanDiscordMarkup(lines.filter(Boolean).join('\n')).trim();
}

function payloadToText(payload) {
  if (typeof payload === 'string') return cleanDiscordMarkup(payload);
  const lines = [];
  if (payload?.content) lines.push(cleanDiscordMarkup(payload.content));
  if (payload?.embeds?.length) {
    for (const embed of payload.embeds) {
      const txt = embedToText(embed);
      if (txt) lines.push(txt);
    }
  }
  return cleanDiscordMarkup(lines.join('\n\n')) || ' ';
}

function componentToKeyboard(components) {
  if (!Array.isArray(components) || !components.length) return undefined;
  const inline_keyboard = [];
  for (const row of components) {
    const raw = row?.components || row?.toJSON?.().components || [];
    const buttons = [];
    for (const c of raw) {
      const data = typeof c?.toJSON === 'function' ? c.toJSON() : (c?.data || c || {});
      if (data.disabled) continue;
      const text = String(data.label || data.emoji?.name || 'Button').slice(0, 64);
      if (data.url) buttons.push({ text, url: data.url });
      else if (data.custom_id) buttons.push({ text, callback_data: String(data.custom_id).slice(0, 64) });
    }
    if (buttons.length) inline_keyboard.push(buttons);
  }
  return inline_keyboard.length ? { inline_keyboard } : undefined;
}

function optionless() {
  return {
    getString() { return null; },
    getInteger() { return null; },
    getNumber() { return null; },
    getBoolean() { return null; },
    getUser() { return null; },
    getMember() { return null; },
    getChannel() { return null; },
    getRole() { return null; },
    getSubcommand() { return null; }
  };
}

function parseMentions(tgMessage, client) {
  const users = new SimpleCollection();
  const members = new SimpleCollection();
  const channels = new SimpleCollection();
  const roles = new SimpleCollection();

  const add = (u) => {
    if (!u?.id) return;
    const user = makeUser(u);
    users.set(user.id, user);
    members.set(user.id, makeMember(client, tgMessage.chat, u, false));
  };

  if (tgMessage.reply_to_message?.from) add(tgMessage.reply_to_message.from);

  for (const ent of tgMessage.entities || tgMessage.caption_entities || []) {
    if (ent.type === 'text_mention' && ent.user) add(ent.user);
  }

  const text = tgMessage.text || tgMessage.caption || '';
  const mentionRe = /@([a-zA-Z0-9_]{5,32})/g;
  let m;
  while ((m = mentionRe.exec(text))) {
    const username = m[1];
    const user = makeUser({ id: username, username });
    users.set(user.id, user);
    members.set(user.id, makeMember(client, tgMessage.chat, { id: username, username }, false));
  }

  return { users, members, channels, roles };
}

function makePermissions(isAdmin) {
  return {
    has(flag) {
      if (flag === 'Administrator') return Boolean(isAdmin);
      return Boolean(isAdmin);
    }
  };
}

function isOwner(userId) {
  return String(process.env.OWNER_ID || '') === String(userId || '');
}

function makeMember(client, chat, tgUser, isAdmin) {
  const user = makeUser(tgUser);
  const chatId = chat?.id;
  const admin = isAdmin || isOwner(user.id);
  return {
    id: user.id,
    user,
    joinedAt: null,
    permissions: makePermissions(admin),
    moderatable: true,
    async kick(reason) {
      if (!client?.bot || !chatId) return null;
      await client.bot.banChatMember(chatId, user.id).catch(() => null);
      await client.bot.unbanChatMember(chatId, user.id, { only_if_banned: true }).catch(() => null);
      return true;
    },
    async timeout(ms, reason) {
      if (!client?.bot || !chatId) return null;
      if (ms == null) {
        return client.bot.restrictChatMember(chatId, user.id, {
          can_send_messages: true,
          can_send_audios: true,
          can_send_documents: true,
          can_send_photos: true,
          can_send_videos: true,
          can_send_video_notes: true,
          can_send_voice_notes: true,
          can_send_polls: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
          can_change_info: false,
          can_invite_users: true,
          can_pin_messages: false
        }).catch(() => null);
      }
      const until_date = Math.floor((Date.now() + Number(ms || 0)) / 1000);
      return client.bot.restrictChatMember(chatId, user.id, {
        until_date,
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false
      }).catch(() => null);
    },
    toString() { return user.toString(); }
  };
}

function makeGuild(client, chat) {
  const id = asId(chat.id);
  const name = chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || `Chat ${id}`;
  const channel = makeChannel(client, chat);
  return {
    id,
    name,
    memberCount: client.memberCounts.get(id) || 0,
    createdTimestamp: Date.now(),
    iconURL() { return null; },
    channels: { cache: new SimpleCollection([[id, channel]]) },
    roles: { everyone: { id: id, name: '@everyone' }, cache: new SimpleCollection() },
    members: {
      async fetch(userId) { return makeMember(client, chat, { id: userId, username: userId }, false); },
      async ban(userId, options = {}) { return client.bot.banChatMember(chat.id, userId).catch(() => null); },
      async unban(userId) { return client.bot.unbanChatMember(chat.id, userId, { only_if_banned: true }).catch(() => null); }
    },
    async fetchOwner() {
      const admins = await client.bot.getChatAdministrators(chat.id).catch(() => []);
      const owner = admins.find(a => a.status === 'creator')?.user || admins[0]?.user || { id: chat.id, username: name };
      return makeMember(client, chat, owner, true);
    }
  };
}

function makeChannel(client, chat) {
  const id = asId(chat.id);
  return {
    id,
    name: chat.title || chat.username || `chat_${id}`,
    type: chat.type,
    createdTimestamp: Date.now(),
    async send(payload) { return sendPayload(client, chat.id, payload); },
    async bulkDelete(amount) { return client.deleteRecent(chat.id, Number(amount || 0)); },
    async setRateLimitPerUser(seconds) { return client.setSlowMode(chat.id, Number(seconds || 0)); },
    permissionOverwrites: { edit: async () => null },
    createMessageCollector(options = {}) { return client.createCollector(chat.id, options); },
    toString() { return chat.username ? `@${chat.username}` : `${id}`; }
  };
}

async function sendFiles(client, chatId, files, opts = {}) {
  if (!Array.isArray(files)) return;
  for (const file of files) {
    const f = file instanceof AttachmentBuilder ? file : new AttachmentBuilder(file?.attachment || file, { name: file?.name || 'attachment.bin' });
    const source = Buffer.isBuffer(f.attachment) ? f.attachment : f.attachment;
    await client.bot.sendDocument(chatId, source, opts, { filename: f.name }).catch(() => null);
  }
}

function trimMessage(text) {
  const s = cleanDiscordMarkup(text || ' ');
  return s.length > 3900 ? `${s.slice(0, 3890)}…` : s;
}

async function sendPayload(client, chatId, payload, extra = {}) {
  const text = trimMessage(payloadToText(payload));
  const reply_markup = componentToKeyboard(payload?.components);
  const options = {
    disable_web_page_preview: true,
    allow_sending_without_reply: true,
    ...extra,
    ...(reply_markup ? { reply_markup } : {})
  };

  let msg = await client.bot.sendMessage(chatId, text, options).catch(async () => {
    const fallbackOptions = { ...options };
    delete fallbackOptions.reply_to_message_id;
    const fallback = trimMessage(cleanDiscordMarkup(text).replace(/[\u0000-\u001f\u007f]/g, ''));
    return client.bot.sendMessage(chatId, fallback || ' ', fallbackOptions).catch(() => null);
  });

  await sendFiles(client, chatId, payload?.files, extra);
  if (msg) client.rememberMessage(msg);
  return msg;
}

async function editPayload(client, chatId, messageId, payload) {
  const text = trimMessage(payloadToText(payload));
  const reply_markup = componentToKeyboard(payload?.components) || { inline_keyboard: [] };
  return client.bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    disable_web_page_preview: true,
    reply_markup
  }).catch(async () => client.bot.editMessageReplyMarkup(reply_markup, {
    chat_id: chatId,
    message_id: messageId
  }).catch(() => null));
}

class TelegramCollector extends EventEmitter {
  constructor(client, chatId, options = {}) {
    super();
    this.client = client;
    this.chatId = asId(chatId);
    this.filter = options.filter || (() => true);
    this.max = options.max || Infinity;
    this.collected = [];
    this.ended = false;
    this.timer = setTimeout(() => this.stop('time'), options.time || 60_000);
    if (this.timer.unref) this.timer.unref();
  }
  tryCollect(message) {
    if (this.ended || asId(message.chat.id) !== this.chatId) return;
    if (!this.filter(message)) return;
    this.collected.push(message);
    this.emit('collect', message);
    if (this.collected.length >= this.max) this.stop('limit');
  }
  stop(reason = 'user') {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.client.collectors.delete(this);
    const coll = new SimpleCollection(this.collected.map(m => [m.id || m.message_id || String(Math.random()), m]));
    this.emit('end', coll, reason);
  }
}

class TelegramDiscordAdapter {
  constructor(bot) {
    this.bot = bot;
    this.me = null;
    this.guilds = { cache: new SimpleCollection() };
    this.channels = { fetch: async (id) => this.channelCache.get(asId(id)) || null };
    this.users = { fetch: async (id) => makeUser({ id, username: id }) };
    this.channelCache = new SimpleCollection();
    this.memberCounts = new Map();
    this.recentMessages = new Map();
    this.collectors = new Set();
    this.ws = { ping: 0 };
    this.user = makeUser({ id: 0, username: 'telegram_bot', is_bot: true });
  }

  async init() {
    this.me = await this.bot.getMe();
    this.user = {
      ...makeUser(this.me),
      tag: this.me.username ? `@${this.me.username}` : usernameOf(this.me),
      displayAvatarURL() { return ''; },
      setActivity() {}
    };
    return this;
  }

  isReady() { return Boolean(this.me); }

  async hydrateChat(chat) {
    const guild = makeGuild(this, chat);
    const channel = makeChannel(this, chat);
    this.guilds.cache.set(guild.id, guild);
    this.channelCache.set(channel.id, channel);
    if (!this.memberCounts.has(guild.id)) {
      const count = await this.bot.getChatMemberCount(chat.id).catch(() => 0);
      this.memberCounts.set(guild.id, count || 0);
      guild.memberCount = count || 0;
    }
    return { guild, channel };
  }

  rememberMessage(tgMessage) {
    if (!tgMessage?.chat?.id || !tgMessage?.message_id) return;
    const id = asId(tgMessage.chat.id);
    const arr = this.recentMessages.get(id) || [];
    arr.push(tgMessage.message_id);
    while (arr.length > 300) arr.shift();
    this.recentMessages.set(id, arr);
  }

  async deleteRecent(chatId, amount) {
    const id = asId(chatId);
    const arr = this.recentMessages.get(id) || [];
    const targets = arr.splice(Math.max(0, arr.length - amount), amount);
    this.recentMessages.set(id, arr);
    for (const mid of targets.reverse()) {
      await this.bot.deleteMessage(chatId, mid).catch(() => null);
    }
    return true;
  }

  async setSlowMode(chatId, seconds) {
    if (typeof this.bot._request === 'function') {
      return this.bot._request('setChatSlowModeDelay', { form: { chat_id: chatId, slow_mode_delay: seconds } }).catch(() => null);
    }
    return null;
  }

  createCollector(chatId, options) {
    const c = new TelegramCollector(this, chatId, options);
    this.collectors.add(c);
    return c;
  }

  dispatchCollectors(message) {
    for (const c of Array.from(this.collectors)) c.tryCollect(message);
  }

  async getMember(chat, user) {
    const res = await this.bot.getChatMember(chat.id, user.id).catch(() => null);
    const isAdmin = ['creator', 'administrator'].includes(res?.status) || isOwner(user.id);
    return makeMember(this, chat, user, isAdmin);
  }

  async makeMessage(tgMessage) {
    const started = Date.now();
    this.rememberMessage(tgMessage);
    const { guild, channel } = await this.hydrateChat(tgMessage.chat);
    const author = makeUser(tgMessage.from);
    const member = await this.getMember(tgMessage.chat, tgMessage.from);
    const mentions = parseMentions(tgMessage, this);
    const message = {
      id: asId(tgMessage.message_id),
      message_id: tgMessage.message_id,
      chat: tgMessage.chat,
      content: tgMessage.text || tgMessage.caption || '',
      cleanContent: tgMessage.text || tgMessage.caption || '',
      author,
      member,
      guild,
      guildId: guild.id,
      channel,
      channelId: channel.id,
      client: this,
      mentions,
      createdTimestamp: (tgMessage.date || Math.floor(Date.now() / 1000)) * 1000,
      async reply(payload) { return sendPayload(this.client, tgMessage.chat.id, payload, { reply_to_message_id: tgMessage.message_id }); },
      async delete() { return this.client.bot.deleteMessage(tgMessage.chat.id, tgMessage.message_id).catch(() => null); }
    };
    this.ws.ping = Date.now() - started;
    return message;
  }

  async makeCallback(query) {
    const chat = query.message.chat;
    const { guild, channel } = await this.hydrateChat(chat);
    const user = makeUser(query.from);
    const member = await this.getMember(chat, query.from);
    const interaction = {
      id: query.id,
      customId: query.data,
      user,
      member,
      guild,
      guildId: guild.id,
      channel,
      channelId: channel.id,
      client: this,
      message: { components: [] },
      isButton() { return true; },
      async deferUpdate() { return this.client.bot.answerCallbackQuery(query.id).catch(() => null); },
      async reply(payload) {
        await this.client.bot.answerCallbackQuery(query.id, { text: payloadToText(payload).slice(0, 180), show_alert: Boolean(payload?.ephemeral) }).catch(() => null);
        if (!payload?.ephemeral) return sendPayload(this.client, chat.id, payload);
        return null;
      },
      async update(payload) {
        await this.client.bot.answerCallbackQuery(query.id).catch(() => null);
        return editPayload(this.client, chat.id, query.message.message_id, payload);
      }
    };
    return interaction;
  }
}

module.exports = {
  TelegramDiscordAdapter,
  SimpleCollection,
  makeUser,
  makeMember,
  makeGuild,
  makeChannel,
  sendPayload,
  editPayload,
  payloadToText,
  cleanDiscordMarkup,
  optionless
};
