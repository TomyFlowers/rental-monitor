import { Bot, InlineKeyboard, InputMediaBuilder, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Config, Secrets } from '../config.js';
import type { Logger } from '../logger.js';
import { UserError, type Monitor, type RunSummary } from '../pipeline/monitor.js';
import type { ListingRow, Store, UserState } from '../store/db.js';
import type { Dispatcher, Notifier } from './dispatcher.js';
import { ago, alertHtml, digestLine, esc } from './format.js';

export interface BotHooks {
  monitor: Monitor;
  dispatcher: Dispatcher;
  /** Runs a full check now (same path as the scheduler). */
  checkNow: () => Promise<RunSummary[] | null>;
  nextCheckAt: () => Date | null;
}

const HELP = [
  '<b>Rental monitor</b>',
  '/status – what the monitor is doing',
  '/rate – go through matches you have not rated yet, one at a time',
  '/top – best current matches',
  '/favorites – listings you starred',
  '/contacted – favourites you have contacted, longest-waiting first',
  '/ignored – listings you ignored',
  '/show_12 – tap one in any list to open that listing with its buttons',
  '/note 12 text – add a note (or just reply to a listing card)',
  '/add &lt;link&gt; [notes] – score a listing you found yourself (e.g. on Facebook: <code>/add https://… T2 900€ Gaia mobilado</code>)',
  'Or just paste a link (with optional notes) without any command.',
  '/check – check all sites now',
  '/pause – stop checks and messages',
  '/resume – start again',
].join('\n');

export function keyboard(row: ListingRow): InlineKeyboard {
  const kb = new InlineKeyboard();
  const open = () => kb.url('🔗 Open', row.listing.url);
  if (row.userState === 'ignored') {
    kb.text('⭐ Favorite', `f:${row.id}`).text('🚫 Ignored (undo)', `u:${row.id}`);
    return open();
  }
  if (row.userState !== 'favorite') {
    kb.text('⭐ Favorite', `f:${row.id}`).text('🚫 Ignore', `i:${row.id}`);
    return open();
  }
  // A favourite moves through stages: contacted, then visit booked. "Closed" is ignore.
  if (row.stage === 'none') kb.text('⭐ Favorited (undo)', `u:${row.id}`).text('📞 Contacted', `c:${row.id}`).row().text('🚫 Ignore', `i:${row.id}`);
  else if (row.stage === 'contacted') kb.text('📞 Contacted (undo)', `x:${row.id}`).text('📅 Visit booked', `v:${row.id}`).row().text('🚫 Closed', `i:${row.id}`);
  else kb.text('📅 Visit booked (undo)', `y:${row.id}`).row().text('🚫 Closed', `i:${row.id}`);
  return open();
}

/** Buttons for the /rate flow: every press moves on to the next listing. */
export function rateKeyboard(row: ListingRow): InlineKeyboard {
  return new InlineKeyboard().text('⭐ Favorite', `rf:${row.id}`).text('🚫 Ignore', `ri:${row.id}`).text('⏭ Skip', `rs:${row.id}`).row().url('🔗 Open', row.listing.url);
}

/** The Telegram side: delivers messages to every allowed user and handles commands and buttons. */
export class TelegramBot implements Notifier {
  readonly bot: Bot;
  private hooks: BotHooks | null = null;
  /** Listings each chat skipped in its current /rate round (cleared by /rate). */
  private skipped = new Map<number, Set<number>>();

  constructor(
    private secrets: Secrets,
    private cfg: Config,
    private store: Store,
    private log: Logger,
    /** Supplied by tests so the bot does not ask Telegram who it is. */
    botInfo?: UserFromGetMe,
  ) {
    this.bot = new Bot(secrets.botToken, botInfo ? { botInfo } : undefined);
    this.register();
  }

  attach(hooks: BotHooks): void {
    this.hooks = hooks;
  }

  async start(): Promise<void> {
    const commands = [
      { command: 'status', description: 'What the monitor is doing' },
      { command: 'rate', description: 'Rate matches one at a time' },
      { command: 'top', description: 'Best current matches' },
      { command: 'favorites', description: 'Listings you starred' },
      { command: 'contacted', description: 'Favourites you have contacted' },
      { command: 'ignored', description: 'Listings you ignored' },
      { command: 'note', description: 'Add a note: /note 12 text' },
      { command: 'add', description: 'Score a listing from a link' },
      { command: 'check', description: 'Check all sites now' },
      { command: 'pause', description: 'Stop checks and messages' },
      { command: 'resume', description: 'Start again' },
    ];
    // Cosmetic (fills the bot's command menu): a network hiccup here must not stop startup.
    await this.bot.api.setMyCommands(commands).catch((err) => this.log.warn({ err: String(err) }, 'could not register the command menu'));
    // Long polling: no public address or open port needed on the NAS.
    this.bot
      .start({ drop_pending_updates: true, onStart: (me) => this.log.info({ bot: me.username }, 'telegram bot started') })
      .catch((err) => {
        // Reached when Telegram rejects the token; nothing useful can run without the bot.
        this.log.fatal({ err: String(err) }, 'telegram bot stopped: check TELEGRAM_BOT_TOKEN');
        setTimeout(() => process.exit(1), 500);
      });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  // --- Notifier --------------------------------------------------------------

  /** Runs `send` for each allowed user; fails only if nobody could be reached. */
  private async broadcast(send: (chatId: number) => Promise<unknown>): Promise<void> {
    let delivered = 0;
    let lastErr: unknown;
    for (const id of this.secrets.allowedUserIds) {
      try {
        await send(id);
        delivered++;
      } catch (err) {
        lastErr = err;
        // Typical cause: this person has not pressed Start on the bot yet.
        this.log.warn({ user: id, err: String(err) }, 'could not message user');
      }
    }
    if (delivered === 0) throw lastErr instanceof Error ? lastErr : new Error('no recipient could be reached');
  }

  async sendText(html: string): Promise<void> {
    await this.broadcast((id) => this.bot.api.sendMessage(id, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }));
  }

  async sendAlert(row: ListingRow, html: string, photos: string[]): Promise<void> {
    await this.broadcast((id) => this.sendCard(id, row, html, photos));
  }

  private async sendCard(chatId: number, row: ListingRow, html: string, photos: string[], buttons: InlineKeyboard = keyboard(row)): Promise<void> {
    // Telegram albums cannot carry buttons, so the album goes first and the
    // text with buttons follows. If Telegram cannot fetch the photos, the
    // text is still sent.
    try {
      if (photos.length >= 2) await this.bot.api.sendMediaGroup(chatId, photos.map((p) => InputMediaBuilder.photo(p)));
      else if (photos.length === 1) await this.bot.api.sendPhoto(chatId, photos[0]!);
    } catch (err) {
      this.log.debug({ err: String(err), listing: row.listing.url }, 'photos could not be sent');
    }
    await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup: buttons, link_preview_options: { is_disabled: true } });
  }

  /** The full card for one listing: facts, where it stands, and its latest notes. */
  private cardHtml(row: ListingRow): string {
    const state = row.status === 'removed' ? '❌ no longer online' : row.userState === 'ignored' ? '🚫 ignored' : row.userState === 'favorite' ? '⭐ favourite' : 'not rated';
    const lines = [alertHtml({ type: 'new', payload: {}, row }, this.cfg.commute.destination.name).replace(/^.*\n/, `📋 <b>Listing ${row.id} · ${state} · ${Math.round(row.evaluation.score)}/100</b>\n`)];
    const now = new Date();
    if (row.contactedAt) lines.push(`📞 Contacted ${ago(row.contactedAt, now)}${row.stage === 'visit' && row.stageAt ? ` · 📅 visit booked ${ago(row.stageAt, now)}` : ''}`);
    for (const n of this.store.notes(row.id, 3).reverse()) lines.push(`📝 ${esc(n.author)}, ${ago(n.at, now)}: ${esc(n.text)}`);
    return lines.join('\n');
  }

  /** Sends the best listing this chat has not rated or skipped yet, or says there is none left. */
  private async sendNextToRate(chatId: number): Promise<void> {
    const skipped = this.skipped.get(chatId) ?? new Set<number>();
    const row = this.store.unrated(1, skipped)[0];
    if (!row) {
      const all = this.store.unratedCount();
      await this.bot.api.sendMessage(chatId, all > 0 ? `That is everything except the ${all} you skipped. Send /rate to go through those again.` : '✅ Nothing left to rate. New matches will show up here as they are found.');
      return;
    }
    const left = this.store.unratedCount() - skipped.size;
    const html = alertHtml({ type: 'new', payload: {}, row }, this.cfg.commute.destination.name).replace(/^.*\n/, `🗳 <b>To rate · ${left} left · ${Math.round(row.evaluation.score)}/100</b>\n`);
    await this.sendCard(chatId, row, html, row.listing.images.slice(0, this.cfg.notifications.ratePhotos), rateKeyboard(row));
    this.store.markNotified(row.id); // it has been shown, so later changes to it are reported
  }

  // --- Commands and buttons --------------------------------------------------

  private register(): void {
    const allowed = new Set(this.secrets.allowedUserIds);
    this.bot.use(async (ctx, next) => {
      if (ctx.from && allowed.has(ctx.from.id)) return next();
      this.log.warn({ from: ctx.from?.id }, 'ignored message from a user who is not on the allow list');
    });

    this.bot.command(['start', 'help'], (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

    this.bot.command('pause', async (ctx) => {
      this.hooks?.dispatcher.setPaused(true);
      await ctx.reply('⏸ Paused. No checks and no messages until /resume.');
    });

    this.bot.command('resume', async (ctx) => {
      this.hooks?.dispatcher.setPaused(false);
      await ctx.reply('▶️ Resumed. The next check runs on schedule; use /check to run one now.');
    });

    this.bot.command('status', (ctx) => ctx.reply(this.statusHtml(), { parse_mode: 'HTML' }));

    this.bot.command('rate', async (ctx) => {
      this.skipped.delete(ctx.chat.id);
      await this.sendNextToRate(ctx.chat.id);
    });

    this.bot.callbackQuery(/^r([fis]):(\d+)$/, async (ctx) => {
      const action = ctx.match[1];
      const id = Number(ctx.match[2]);
      const chatId = ctx.chat?.id ?? ctx.from.id;
      if (!this.store.byId(id)) return ctx.answerCallbackQuery({ text: 'That listing is no longer in the database.' });
      if (action === 's') {
        if (!this.skipped.has(chatId)) this.skipped.set(chatId, new Set());
        this.skipped.get(chatId)!.add(id);
        await ctx.answerCallbackQuery({ text: 'Skipped for now' });
      } else {
        this.store.setUserState(id, action === 'f' ? 'favorite' : 'ignored');
        await ctx.answerCallbackQuery({ text: action === 'f' ? 'Added to favourites' : 'Ignored' });
      }
      // The card keeps the ordinary buttons, so the choice can still be undone or made later.
      await this.refreshButtons(ctx, id);
      await this.sendNextToRate(chatId);
    });

    this.bot.command('top', async (ctx) => {
      const rows = this.store.topPicks(10);
      if (rows.length === 0) return ctx.reply('No matching listings yet.');
      await ctx.reply(['<b>Top matches</b>', ...rows.map((r, i) => digestLine(r, `${i + 1}. `))].join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    });

    const list = async (ctx: Context, rows: ListingRow[], title: string, empty: string, line: (row: ListingRow) => string = (r) => digestLine(r, r.status === 'removed' ? '❌ ' : '')) => {
      if (rows.length === 0) return ctx.reply(empty);
      const shown = rows.slice(0, 25);
      const head = `<b>${title} (${rows.length})</b>${rows.length > shown.length ? ` – first ${shown.length}` : ''}\nTap a /show link to open a listing with its buttons.`;
      await ctx.reply([head, ...shown.map(line)].join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    };
    this.bot.command('favorites', (ctx) => list(ctx, this.store.favorites(), 'Favourites', 'No favourites yet. Tap ⭐ on a listing to add one.'));
    this.bot.command('ignored', (ctx) => list(ctx, this.store.ignored(), 'Ignored', 'Nothing is ignored.'));
    this.bot.command('contacted', (ctx) =>
      list(ctx, this.store.inProgress(), 'Contacted', 'Nothing in progress. Tap 📞 Contacted on a favourite once you have written or called.', (row) => {
        const what = row.stage === 'visit' ? `visit booked ${ago(row.stageAt ?? '', new Date())}` : `contacted ${ago(row.contactedAt ?? row.stageAt ?? '', new Date())}`;
        const note = this.store.notes(row.id, 1)[0];
        return `${digestLine(row, row.status === 'removed' ? '❌ ' : '')}\n   ${what}${note ? ` · 📝 ${esc(note.text.slice(0, 80))}` : ''}`;
      }),
    );

    // /show_12 (tappable in lists) or "/show 12": the full card for one listing, with buttons.
    this.bot.hears(/^\/show[_ ](\d+)(?:@\w+)?$/, async (ctx) => {
      const row = this.store.byId(Number(ctx.match[1]));
      if (!row || !ctx.chat) return ctx.reply('There is no listing with that number.');
      await this.sendCard(ctx.chat.id, row, this.cardHtml(row), row.listing.images.slice(0, this.cfg.notifications.ratePhotos));
    });

    const saveNote = async (ctx: Context, id: number, text: string) => {
      const row = this.store.byId(id);
      if (!row) return ctx.reply('There is no listing with that number.');
      if (!text.trim()) return ctx.reply('Usage: /note <number> <text>, or reply to a listing card with the text.');
      this.store.addNote(id, ctx.from?.first_name ?? 'someone', text.trim().slice(0, 500), new Date().toISOString());
      await ctx.reply(`📝 Note saved on /show_${id}`);
    };
    this.bot.command('note', (ctx) => {
      const m = /^(\d+)\s+([\s\S]+)$/.exec(ctx.match.trim());
      return m ? saveNote(ctx, Number(m[1]), m[2]!) : ctx.reply('Usage: /note <number> <text>, or reply to a listing card with the text.');
    });
    // Replying to a listing card with plain text saves the text as a note on that listing.
    this.bot.on('message:text').filter(
      (ctx) => !!ctx.message.reply_to_message && !ctx.message.text.startsWith('/'),
      (ctx) => {
        const rows = ctx.message.reply_to_message?.reply_markup?.inline_keyboard ?? [];
        const data = rows.flat().map((b) => ('callback_data' in b ? b.callback_data : '')).find((d) => /^\w+:\d+$/.test(d ?? ''));
        if (!data) return ctx.reply('To add a note, reply to a listing card (a message with buttons), or use /note <number> <text>.');
        return saveNote(ctx, Number(data.split(':')[1]), ctx.message.text);
      },
    );

    this.bot.command('check', async (ctx) => {
      if (!this.hooks) return;
      await ctx.reply('Checking all sites now. This can take a few minutes…');
      const res = await this.hooks.checkNow();
      if (res === null) return ctx.reply('A check is already running.');
      const lines = res.map((s) => `${s.ok ? '✅' : '⚠️'} ${esc(s.source)}: ${s.found} read, ${s.fresh} new${s.note ? ` (${esc(s.note)})` : ''}`);
      await ctx.reply(lines.join('\n') || 'No sources are enabled.', { parse_mode: 'HTML' });
    });

    const add = async (ctx: Context, input: string) => {
      if (!this.hooks || !ctx.chat) return;
      const [link, ...rest] = input.trim().split(/\s+/);
      if (!link) return ctx.reply('Usage: /add <link> [notes]\nExample: /add https://facebook.com/… T2 900€ Gaia mobilado com garagem');
      try {
        const row = await this.hooks.monitor.addByUrl(link, rest.join(' '));
        const html = alertHtml({ type: 'new', payload: {}, row }, this.cfg.commute.destination.name).replace(/^.*\n/, `📌 <b>Added by hand · ${Math.round(row.evaluation.score)}/100</b>\n`);
        await this.sendCard(ctx.chat.id, row, html, row.listing.images.slice(0, this.cfg.notifications.photos));
      } catch (err) {
        if (err instanceof UserError) return ctx.reply(err.message);
        this.log.warn({ err: String(err) }, '/add failed');
        await ctx.reply('Could not read that link (the site did not answer or refused the request).');
      }
    };
    this.bot.command('add', (ctx) => add(ctx, ctx.match));
    // A pasted link, with or without notes after it, works like /add.
    this.bot.hears(/^https?:\/\/\S+/i, (ctx) => add(ctx, ctx.message?.text ?? ''));

    this.bot.callbackQuery(/^([fiucvxy]):(\d+)$/, async (ctx) => {
      const action = ctx.match[1]!;
      const id = Number(ctx.match[2]);
      const before = this.store.byId(id);
      if (!before) return ctx.answerCallbackQuery({ text: 'That listing is no longer in the database.' });
      const now = new Date().toISOString();
      let text: string;
      switch (action) {
        case 'f':
          this.store.setUserState(id, 'favorite');
          text = 'Added to favourites';
          break;
        case 'i':
          this.store.setUserState(id, 'ignored');
          text = before.userState === 'favorite' ? 'Closed: moved from favourites to ignored' : 'Ignored: no more messages about this one';
          break;
        case 'c':
          this.store.setStage(id, 'contacted', now);
          text = 'Marked as contacted. Reply to this message to add a note.';
          break;
        case 'v':
          this.store.setStage(id, 'visit', now);
          text = 'Visit booked. Reply to this message to note the date.';
          break;
        case 'x':
          this.store.setStage(id, 'none', now);
          text = 'No longer marked as contacted';
          break;
        case 'y':
          this.store.setStage(id, 'contacted', now);
          text = 'Back to contacted';
          break;
        default:
          this.store.setUserState(id, 'none');
          text = 'Undone';
      }
      await ctx.answerCallbackQuery({ text });
      await this.refreshButtons(ctx, id);
    });

    this.bot.catch((err) => this.log.error({ err: String(err.error) }, 'telegram handler failed'));
  }

  private async refreshButtons(ctx: Context, id: number): Promise<void> {
    const row = this.store.byId(id);
    if (!row) return;
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard(row) });
    } catch {
      // "message is not modified" when the state did not change: nothing to do.
    }
  }

  private statusHtml(): string {
    const c = this.store.counts();
    const d = this.hooks?.dispatcher;
    const next = this.hooks?.nextCheckAt();
    const fmt = (iso: string | Date) => new Date(iso).toLocaleString('en-GB', { timeZone: this.cfg.timezone, dateStyle: 'short', timeStyle: 'short' });
    const lines = [
      `<b>Status:</b> ${d?.paused ? '⏸ paused' : d?.isQuiet() ? '🌙 running (quiet hours: messages held)' : '▶️ running'}`,
      `Listings tracked: ${c.active} (${c.matches} match your criteria)`,
      `⭐ ${c.favorites} favourites · 🚫 ${c.ignored} ignored · ❌ ${c.removed} removed`,
      `Waiting to send: ${this.store.pendingEvents('instant').length} alerts, ${this.store.pendingEvents('digest').length} digest items`,
      next && !d?.paused ? `Next check: ${fmt(next)}` : null,
      '',
      '<b>Sources</b>',
    ];
    if (this.cfg.email.enabled) {
      const last = this.store.recentRuns('email', 1)[0];
      lines.push(last ? `• email alerts: ${last.ok ? '✅' : '⚠️'} ${fmt(last.startedAt)}, ${last.found} read, ${last.fresh} new${last.note ? `\n   <i>${esc(last.note.slice(0, 200))}</i>` : ''}` : '• email alerts: not checked yet');
    }
    for (const [name, sc] of Object.entries(this.cfg.sources)) {
      if (!sc.enabled) {
        lines.push(`• ${esc(name)}: disabled`);
        continue;
      }
      const last = this.store.recentRuns(name, 1)[0];
      const resting = this.hooks?.monitor.cooldownUntil(name);
      if (resting) lines.push(`• ${esc(name)}: 💤 resting until ${fmt(resting)} after the site refused or rate-limited a request`);
      lines.push(
        last
          ? `• ${esc(name)}: ${last.ok ? '✅' : '⚠️'} ${fmt(last.startedAt)}, ${last.found} read, ${last.fresh} new${last.note ? `\n   <i>${esc(last.note.slice(0, 200))}</i>` : ''}`
          : `• ${esc(name)}: not checked yet`,
      );
    }
    return lines.filter((l) => l !== null).join('\n');
  }
}
