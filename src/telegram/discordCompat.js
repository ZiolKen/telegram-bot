class OptionBuilder {
  constructor(type) {
    this.type = type;
    this.name = '';
    this.description = '';
    this.required = false;
    this.choices = [];
  }
  setName(v) { this.name = String(v || ''); return this; }
  setDescription(v) { this.description = String(v || ''); return this; }
  setRequired(v) { this.required = Boolean(v); return this; }
  addChoices(...choices) { this.choices.push(...choices.flat()); return this; }
  addStringOption(fn) { return this._addOption('string', fn); }
  addIntegerOption(fn) { return this._addOption('integer', fn); }
  addNumberOption(fn) { return this._addOption('number', fn); }
  addUserOption(fn) { return this._addOption('user', fn); }
  addChannelOption(fn) { return this._addOption('channel', fn); }
  addRoleOption(fn) { return this._addOption('role', fn); }
  addBooleanOption(fn) { return this._addOption('boolean', fn); }
  addSubcommand(fn) { return this._addOption('subcommand', fn); }
  _addOption(type, fn) {
    this.options = this.options || [];
    const opt = new OptionBuilder(type);
    if (typeof fn === 'function') fn(opt);
    this.options.push(opt);
    return this;
  }
  toJSON() { return { type: this.type, name: this.name, description: this.description, required: this.required, choices: this.choices, options: (this.options || []).map(o => o.toJSON()) }; }
}

class SlashCommandBuilder {
  constructor() {
    this.name = '';
    this.description = '';
    this.options = [];
    this.defaultMemberPermissions = null;
  }
  setName(v) { this.name = String(v || ''); return this; }
  setDescription(v) { this.description = String(v || ''); return this; }
  setDefaultMemberPermissions(v) { this.defaultMemberPermissions = v; return this; }
  setDMPermission() { return this; }
  addStringOption(fn) { return this._addOption('string', fn); }
  addIntegerOption(fn) { return this._addOption('integer', fn); }
  addNumberOption(fn) { return this._addOption('number', fn); }
  addUserOption(fn) { return this._addOption('user', fn); }
  addChannelOption(fn) { return this._addOption('channel', fn); }
  addRoleOption(fn) { return this._addOption('role', fn); }
  addBooleanOption(fn) { return this._addOption('boolean', fn); }
  addSubcommand(fn) { return this._addOption('subcommand', fn); }
  _addOption(type, fn) {
    const opt = new OptionBuilder(type);
    if (typeof fn === 'function') fn(opt);
    this.options.push(opt);
    return this;
  }
  toJSON() {
    return {
      name: this.name,
      description: this.description || this.name,
      options: this.options.map(o => o.toJSON()),
      default_member_permissions: this.defaultMemberPermissions
    };
  }
}

class EmbedBuilder {
  constructor(data) {
    this.data = { fields: [], ...(data || {}) };
  }
  setTitle(v) { this.data.title = v == null ? null : String(v); return this; }
  setDescription(v) { this.data.description = v == null ? null : String(v); return this; }
  setColor(v) { this.data.color = v; return this; }
  addFields(...fields) { this.data.fields.push(...fields.flat().filter(Boolean)); return this; }
  setFooter(v) { this.data.footer = typeof v === 'string' ? { text: v } : (v || null); return this; }
  setTimestamp(v = new Date()) { this.data.timestamp = v instanceof Date ? v.toISOString() : (v || new Date().toISOString()); return this; }
  setThumbnail(v) { this.data.thumbnail = v ? { url: String(v) } : null; return this; }
  setImage(v) { this.data.image = v ? { url: String(v) } : null; return this; }
  setURL(v) { this.data.url = v ? String(v) : null; return this; }
  setAuthor(v) { this.data.author = v || null; return this; }
  toJSON() { return this.data; }
}

class AttachmentBuilder {
  constructor(attachment, options = {}) {
    this.attachment = attachment;
    this.name = options.name || 'attachment.bin';
    this.description = options.description || '';
  }
}

class ButtonBuilder {
  constructor(data = {}) {
    this.data = { ...data };
  }
  static from(other) { return new ButtonBuilder(other?.data || other || {}); }
  setCustomId(v) { this.data.custom_id = String(v); return this; }
  setLabel(v) { this.data.label = String(v); return this; }
  setStyle(v) { this.data.style = v; return this; }
  setURL(v) { this.data.url = String(v); return this; }
  setDisabled(v = true) { this.data.disabled = Boolean(v); return this; }
  toJSON() { return this.data; }
}

class ActionRowBuilder {
  constructor(data = {}) {
    this.components = [];
    if (Array.isArray(data.components)) this.components = data.components;
  }
  addComponents(...components) { this.components.push(...components.flat().filter(Boolean)); return this; }
  toJSON() { return { type: 1, components: this.components.map(c => typeof c.toJSON === 'function' ? c.toJSON() : c) }; }
}

const ButtonStyle = Object.freeze({ Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 });

const PermissionFlagsBits = Object.freeze({
  Administrator: 'Administrator',
  ManageGuild: 'ManageGuild',
  BanMembers: 'BanMembers',
  KickMembers: 'KickMembers',
  ModerateMembers: 'ModerateMembers',
  ManageMessages: 'ManageMessages',
  ManageChannels: 'ManageChannels',
  ManageRoles: 'ManageRoles'
});

module.exports = {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits
};
