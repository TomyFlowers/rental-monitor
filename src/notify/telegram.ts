import { Bot, InlineKeyboard, InputMediaBuilder, type Context } from 'grammy';
import type { Config, Secrets } from '../config.js';
import type { Logger } from '../logger.js';
import { UserError, type Monitor, type RunSummary } from '../pipeline/monitor.js';
import type { ListingRow, Store, UserState } from '../store/db.js';
import type { Dispatcher, Notifier } from './dispatcher.js';
import { alertHtml, digestLine, esc } from './format.js';

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
  '/top – best current matches',
  '/favorites – listings you starred',
  '/add &lt;link&gt; [notes] – score a listing you found yourself (e.g. on Facebook: <code>/add https://… T2 900€ Gaia mobilado</code>)',
  '/check – check all sites now',
  '/pause – stop checks and messages',
  '/resume – start again',
].join('\n');

export function keyboard(row: ListingRow): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (row.userState === 'favorite') kb.text('⭐ Favorited (undo)', `u:${row.id}`);
  else kb.text('⭐ Favorite', `f:${row.id}`);
  if (row.userState === 'ignored') kb.text('🚫 Ignored (undo)', `u:${row.id}`);
  else kb.text('🚫 Ignore', `i:${row.id}`);
  return kb.url('🔗 Open', row.listing.url);
}

/** The Telegram side: delivers messages to every allowed user and handles commands and buttons. */
export class TelegramBot implements Notifier {
  readonly bot: Bot;
  private hooks: BotHooks | null = null;

  constructor(
    private secrets: Secrets,
    private cfg: Config,
    private store: Store,
    private log: Logger,
  ) {
    this.bot = new Bot(secrets.botToken);
    this.register();
  }

  attach(hooks: BotHooks): void {
    this.hooks = hooks;
  }

  async start(): Promise<void> {
    const commands = [
      { command: 'status', description: 'What the monitor is doing' },
      { command: 'top', description: 'Best current matches' },
      { command: 'favorites', description: 'Listings you starred' },
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

  private async sendCard(chatId: number, row: ListingRow, html: string, photos: string[]): Promise<void> {
    // Telegram albums cannot carry buttons, so the album goes first and the
    // text with buttons follows. If Telegram cannot fetch the photos, the
    // text is still sent.
    try {
      if (photos.length >= 2) await this.bot.api.sendMediaGroup(chatId, photos.map((p) => InputMediaBuilder.photo(p)));
      else if (photos.length === 1) await this.bot.api.sendPhoto(chatId, photos[0]!);
    } catch (err) {
      this.log.debug({ err: String(err), listing: row.listing.url }, 'photos could not be sent');
    }
    await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup: keyboard(row), link_preview_options: { is_disabled: true } });
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

    this.bot.command('top', async (ctx) => {
      const rows = this.store.topPicks(10);
      if (rows.length === 0) return ctx.reply('No matching listings yet.');
      await ctx.reply(['<b>Top matches</b>', ...rows.map((r, i) => digestLine(r, `${i + 1}. `))].join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    });

    this.bot.command('favorites', async (ctx) => {
      const rows = this.store.favorites();
      if (rows.length === 0) return ctx.reply('No favourites yet. Tap ⭐ on a listing to add one.');
      await ctx.reply(['<b>Favourites</b>', ...rows.map((r) => digestLine(r, r.status === 'removed' ? '❌ ' : ''))].join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    });

    this.bot.command('check', async (ctx) => {
      if (!this.hooks) return;
      await ctx.reply('Checking all sites now. This can take a few minutes…');
      const res = await this.hooks.checkNow();
      if (res === null) return ctx.reply('A check is already running.');
      const lines = res.map((s) => `${s.ok ? '✅' : '⚠️'} ${esc(s.source)}: ${s.found} read, ${s.fresh} new${s.note ? ` (${esc(s.note)})` : ''}`);
      await ctx.reply(lines.join('\n') || 'No sources are enabled.', { parse_mode: 'HTML' });
    });

    this.bot.command('add', async (ctx) => {
      if (!this.hooks) return;
      const [link, ...rest] = ctx.match.trim().split(/\s+/);
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
    });

    this.bot.callbackQuery(/^([fiu]):(\d+)$/, async (ctx) => {
      const action = ctx.match[1];
      const id = Number(ctx.match[2]);
      const state: UserState = action === 'f' ? 'favorite' : action === 'i' ? 'ignored' : 'none';
      const before = this.store.byId(id);
      if (!before) return ctx.answerCallbackQuery({ text: 'That listing is no longer in the database.' });
      this.store.setUserState(id, state);
      const text = state === 'favorite' ? 'Added to favourites' : state === 'ignored' ? 'Ignored: no more messages about this one' : 'Undone';
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
    for (const [name, sc] of Object.entries(this.cfg.sources)) {
      if (!sc.enabled) {
        lines.push(`• ${esc(name)}: disabled`);
        continue;
      }
      const last = this.store.recentRuns(name, 1)[0];
      lines.push(
        last
          ? `• ${esc(name)}: ${last.ok ? '✅' : '⚠️'} ${fmt(last.startedAt)}, ${last.found} read, ${last.fresh} new${last.note ? `\n   <i>${esc(last.note.slice(0, 200))}</i>` : ''}`
          : `• ${esc(name)}: not checked yet`,
      );
    }
    return lines.filter((l) => l !== null).join('\n');
  }
}
