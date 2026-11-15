import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { EventRow, ListingRow, Store } from '../store/db.js';
import { alertHtml, digestHtml } from './format.js';

/** What the dispatcher needs from a messaging channel. Telegram implements it; tests fake it. */
export interface Notifier {
  /** A listing card: photos, text, and the favourite/ignore buttons. */
  sendAlert(row: ListingRow, html: string, photos: string[]): Promise<void>;
  sendText(html: string): Promise<void>;
}

export function localTime(date: Date, timeZone: string): { minutes: number; ymd: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return { minutes: Number(get('hour')) * 60 + Number(get('minute')), ymd: `${get('year')}-${get('month')}-${get('day')}` };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function inQuietHours(date: Date, timeZone: string, quiet: { start: string; end: string } | null): boolean {
  if (!quiet) return false;
  const now = localTime(date, timeZone).minutes;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Decides when queued events actually go out: instant alerts outside quiet
 * hours and under the daily cap, everything else in the daily digest.
 */
export class Dispatcher {
  private failures = new Map<number, number>();
  private flushing = false;

  constructor(
    private cfg: Config,
    private store: Store,
    private notifier: Notifier,
    private log: Logger,
    private clock: () => Date = () => new Date(),
  ) {}

  get paused(): boolean {
    return this.store.get('paused') === '1';
  }

  setPaused(value: boolean): void {
    this.store.set('paused', value ? '1' : '0');
  }

  isQuiet(): boolean {
    return inQuietHours(this.clock(), this.cfg.timezone, this.cfg.schedule.quietHours);
  }

  /** Sends a system message (health alert), holding it until quiet hours end. */
  async system(html: string): Promise<void> {
    if (this.isQuiet()) {
      const queue = JSON.parse(this.store.get('system_queue') ?? '[]') as string[];
      queue.push(html);
      this.store.set('system_queue', JSON.stringify(queue.slice(-20)));
      return;
    }
    await this.notifier.sendText(html);
  }

  /** Sends whatever is due now. Safe to call often; it does nothing during quiet hours or while paused. */
  async flushInstant(): Promise<number> {
    if (this.flushing || this.paused || this.isQuiet()) return 0;
    this.flushing = true;
    let sent = 0;
    try {
      const queued = JSON.parse(this.store.get('system_queue') ?? '[]') as string[];
      if (queued.length) {
        this.store.set('system_queue', '[]');
        for (const html of queued) await this.notifier.sendText(html);
      }

      const max = this.cfg.notifications.maxInstantPerDay;
      const dayAgo = new Date(this.clock().getTime() - 86_400_000).toISOString();
      let used = this.store.instantSentSince(dayAgo);
      for (const ev of this.store.pendingEvents('instant')) {
        const now = this.clock().toISOString();
        if (ev.row.userState === 'ignored' || ev.row.status === 'removed') {
          this.store.markEventSent(ev.id, now);
          continue;
        }
        if (used >= max) {
          this.store.moveEventToDigest(ev.id); // over the cap: it will appear in the digest instead
          continue;
        }
        try {
          const photos = ev.row.listing.images.slice(0, this.cfg.notifications.photos);
          await this.notifier.sendAlert(ev.row, alertHtml(ev, this.cfg.commute.destination.name), photos);
          this.store.markEventSent(ev.id, now);
          this.store.markNotified(ev.row.id);
          used++;
          sent++;
        } catch (err) {
          const n = (this.failures.get(ev.id) ?? 0) + 1;
          this.failures.set(ev.id, n);
          this.log.warn({ event: ev.id, attempt: n, err: String(err) }, 'could not send alert');
          if (n >= 5) this.store.moveEventToDigest(ev.id);
          break; // most likely a connection problem: try again on the next tick
        }
      }
    } finally {
      this.flushing = false;
    }
    return sent;
  }

  /** Builds and sends the daily digest, then marks its events as delivered. */
  async sendDigest(): Promise<boolean> {
    if (this.paused) return false;
    const now = this.clock();
    const nowIso = now.toISOString();
    const latest = new Map<string, EventRow>();
    const skipped: EventRow[] = [];
    for (const ev of this.store.pendingEvents('digest')) {
      if (ev.row.userState === 'ignored') {
        skipped.push(ev);
        continue;
      }
      // One line per listing per section, keeping the most recent event.
      const group = ev.type === 'new' ? 'new' : ev.type === 'removed' ? 'removed' : 'changed';
      const key = `${group}:${ev.row.id}`;
      const existing = latest.get(key);
      if (existing) skipped.push(existing.id < ev.id ? existing : ev);
      if (!existing || existing.id < ev.id) latest.set(key, ev);
    }
    const all = [...latest.entries()];
    const pick = (g: string) => all.filter(([k]) => k.startsWith(`${g}:`)).map(([, ev]) => ev);
    const max = this.cfg.notifications.maxDigestItems;
    // A listing that vanished the same day it appeared is only shown as removed.
    const removed = pick('removed');
    const removedIds = new Set(removed.map((e) => e.row.id));
    const allNew = pick('new').filter((e) => e.row.status === 'active' && !removedIds.has(e.row.id));
    const fresh = allNew.slice(0, max);
    const changed = pick('changed').filter((e) => !removedIds.has(e.row.id)).slice(0, max);

    const shown = new Set([...fresh, ...changed, ...removed].map((e) => e.row.id));
    const topPicks = this.store.topPicks(this.cfg.notifications.topPicks + shown.size).filter((r) => !shown.has(r.id)).slice(0, this.cfg.notifications.topPicks);
    const sources = Object.entries(this.cfg.sources)
      .filter(([, s]) => s.enabled)
      .map(([name]) => ({ name, last: this.store.recentRuns(name, 1)[0] ?? null }));

    const messages = digestHtml({ date: localTime(now, this.cfg.timezone).ymd, fresh, changed, removed: removed.slice(0, max), topPicks, hidden: allNew.length - fresh.length, sources });
    for (const m of messages) await this.notifier.sendText(m);

    this.store.transaction(() => {
      for (const ev of [...latest.values(), ...skipped]) this.store.markEventSent(ev.id, nowIso);
      for (const ev of [...fresh, ...changed]) this.store.markNotified(ev.row.id);
      for (const row of topPicks) this.store.markNotified(row.id);
    });
    this.store.set('last_digest', nowIso);
    return true;
  }
}
