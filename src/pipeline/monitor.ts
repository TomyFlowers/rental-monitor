import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { evaluate } from '../core/evaluator.js';
import { findEuroAmount, guessMunicipality, parseArea, parseTypology } from '../core/text.js';
import { emptyListing, type Delivery, type Listing } from '../core/types.js';
import type { Enricher } from '../enrich/commute.js';
import { HttpError } from '../http/client.js';
import type { Logger } from '../logger.js';
import type { ListingRow, Store } from '../store/db.js';
import { applyText, type SourceAdapter } from '../sources/types.js';

/** A source that is not a website to search, e.g. alert emails in a mailbox. */
export interface ListingFeed {
  readonly name: string;
  fetch(now: Date): Promise<{ listings: Listing[]; note: string | null }>;
}

export interface RunSummary {
  source: string;
  ok: boolean;
  found: number;
  fresh: number;
  mode: 'structured' | 'html';
  blocked: boolean;
  note: string | null;
}

/** An error whose message is safe and useful to show to the Telegram user. */
export class UserError extends Error {}

const WATCHED_FIELDS = ['typology', 'availableFrom', 'furnished'] as const;

/** New data wins wherever it says something; otherwise what we already knew is kept. */
export function merge(prev: Listing, fresh: Listing): Listing {
  const out: Listing = { ...prev };
  const target = out as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(fresh)) {
    if (v === null || v === undefined || v === '') continue;
    if (k === 'detailsFetched' || k === 'coordsApprox' || k === 'images') continue;
    target[k] = v;
  }
  // A search card shows a few photos, the listing page all of them.
  if (fresh.images.length > 0 && (fresh.detailsFetched || prev.images.length === 0)) out.images = fresh.images;
  if (fresh.lat !== null && fresh.lon !== null) out.coordsApprox = fresh.coordsApprox;
  out.detailsFetched = prev.detailsFetched || fresh.detailsFetched;
  return out;
}

export class Monitor {
  private running = false;

  constructor(
    private cfg: Config,
    private store: Store,
    private adapters: SourceAdapter[],
    private enricher: Enricher,
    private log: Logger,
    private clock: () => Date = () => new Date(),
    private feeds: ListingFeed[] = [],
  ) {}

  private iso(): string {
    return this.clock().toISOString();
  }

  private level(score: number): Delivery {
    const n = this.cfg.notifications;
    return score >= n.instantMinScore ? 'instant' : score >= n.digestMinScore ? 'digest' : 'none';
  }

  /** When a source that refused us may be tried again, or null if it is not resting. */
  cooldownUntil(source: string): Date | null {
    const until = this.store.get(`cooldown:${source}`);
    return until && until > this.iso() ? new Date(until) : null;
  }

  /**
   * After a refusal (403) or rate limit (429) the source is left alone for a
   * while: 2 hours, doubling on each repeat up to 12, or longer if the site
   * names a wait itself.
   */
  private rest(source: string, retryAfterSec: number | null): void {
    const n = Number(this.store.get(`blocks:${source}`) ?? '0') + 1;
    this.store.set(`blocks:${source}`, String(n));
    const hours = Math.min(12, 2 * 2 ** (n - 1));
    const ms = Math.max(hours * 3_600_000, (retryAfterSec ?? 0) * 1000);
    const until = new Date(this.clock().getTime() + ms).toISOString();
    this.store.set(`cooldown:${source}`, until);
    this.log.warn({ source, until }, 'source refused the request; resting it');
  }

  /** Checks every enabled source once. Returns null if a run is already in progress. */
  async runAll(): Promise<RunSummary[] | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const startedAt = this.iso();
      const summaries: RunSummary[] = [];
      let anyFirstRun = false;
      for (const adapter of this.adapters) {
        const sc = this.cfg.sources[adapter.name];
        if (!sc?.enabled) continue;
        if (this.cooldownUntil(adapter.name)) continue;
        const firstRun = !this.store.hasSuccessfulRun(adapter.name);
        anyFirstRun ||= firstRun;
        summaries.push(await this.searchSource(adapter, sc, firstRun));
      }
      for (const feed of this.feeds) {
        anyFirstRun ||= !this.store.hasSuccessfulRun(feed.name);
        summaries.push(await this.readFeed(feed));
      }
      for (const adapter of this.adapters) {
        // A disabled source (e.g. a site that refuses requests) is left alone entirely.
        if (!this.cfg.sources[adapter.name]?.enabled || this.cooldownUntil(adapter.name)) continue;
        await this.detailsPhase(adapter);
        await this.delistPhase(adapter, startedAt);
      }
      if (anyFirstRun) {
        const windows = JSON.parse(this.store.get('baseline_windows') ?? '[]') as [string, string][];
        windows.push([startedAt, this.iso()]);
        this.store.set('baseline_windows', JSON.stringify(windows));
      }
      this.announce();
      return summaries;
    } finally {
      this.running = false;
    }
  }

  private async searchSource(adapter: SourceAdapter, sc: Config['sources'][string], firstRun: boolean): Promise<RunSummary> {
    const s: RunSummary = { source: adapter.name, ok: true, found: 0, fresh: 0, mode: 'structured', blocked: false, note: null };
    const startedAt = this.iso();
    const seen = new Set<string>();
    const maxPages = firstRun ? sc.firstRunMaxPages : sc.maxPages;
    try {
      for (const searchUrl of sc.searches) {
        for (let page = 1; page <= maxPages; page++) {
          const res = await adapter.search(searchUrl, page, this.clock());
          if (res.mode === 'html') s.mode = 'html';
          let pageNew = 0;
          let pageUnique = 0;
          for (const l of res.listings) {
            const key = `${l.source}:${l.sourceId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            pageUnique++;
            const { isNew } = await this.process(l);
            s.found++;
            if (isNew) {
              s.fresh++;
              pageNew++;
            }
          }
          if (pageUnique === 0) break; // empty page, or the site repeated the previous one
          if (res.totalPages !== null && page >= res.totalPages) break;
          // Results are newest-first: once a whole page is already known, older pages are too.
          if (!firstRun && pageNew === 0) break;
        }
      }
      if (s.found === 0) {
        s.ok = false;
        s.note = 'no listings found (the page layout may have changed)';
      } else if (s.mode === 'html') {
        s.note = 'embedded data not found; read the page markup instead (less detail)';
      }
    } catch (err) {
      s.blocked = err instanceof HttpError && err.blocked;
      if (err instanceof HttpError && err.blocked) this.rest(adapter.name, err.retryAfterSec);
      s.ok = s.found > 0;
      s.note = err instanceof Error ? err.message : String(err);
      this.log.warn({ source: adapter.name, err: s.note }, 'search failed');
    }
    if (!s.blocked && s.ok) this.store.set(`blocks:${adapter.name}`, '0');
    this.store.recordRun({ source: s.source, startedAt, ok: s.ok, found: s.found, fresh: s.fresh, note: s.note });
    this.log.info({ ...s }, 'source checked');
    return s;
  }

  private async readFeed(feed: ListingFeed): Promise<RunSummary> {
    const s: RunSummary = { source: feed.name, ok: true, found: 0, fresh: 0, mode: 'structured', blocked: false, note: null };
    const startedAt = this.iso();
    try {
      const res = await feed.fetch(this.clock());
      s.note = res.note;
      for (const l of res.listings) {
        const { isNew } = await this.process(l);
        s.found++;
        if (isNew) s.fresh++;
      }
    } catch (err) {
      // Unlike a website, an empty feed is normal; only a failure to read it counts.
      s.ok = false;
      s.note = err instanceof Error ? err.message : String(err);
      this.log.warn({ source: feed.name, err: s.note }, 'feed failed');
    }
    this.store.recordRun({ source: s.source, startedAt, ok: s.ok, found: s.found, fresh: s.fresh, note: s.note });
    this.log.info({ ...s }, 'feed checked');
    return s;
  }

  /** Reads the pages of matching listings that only have search-card data so far. */
  private async detailsPhase(adapter: SourceAdapter): Promise<void> {
    const since = new Date(this.clock().getTime() - 7 * 86_400_000).toISOString();
    for (const row of this.store.needingDetails(adapter.name, this.cfg.details.maxPerRun, since)) {
      try {
        const res = await adapter.details(row.listing, this.clock());
        if (res.kind === 'gone') this.store.markRemoved(row.id);
        else await this.process(res.listing);
      } catch (err) {
        this.log.warn({ url: row.listing.url, err: String(err) }, 'could not read listing page');
        if (err instanceof HttpError && err.blocked) return; // stop knocking on a closed door
      }
    }
  }

  /**
   * Re-reads listings the user knows about that did not show up in this run's
   * search. Removal is only reported after the page itself says the listing
   * is gone, several times in a row; a broken search never causes removals.
   */
  private async delistPhase(adapter: SourceAdapter, runStartedAt: string): Promise<void> {
    const { perRun, confirmations } = this.cfg.notifications.delistCheck;
    for (const row of this.store.delistCandidates(adapter.name, perRun, runStartedAt)) {
      try {
        const res = await adapter.details(row.listing, this.clock());
        if (res.kind === 'ok') {
          await this.process(res.listing);
        } else if (this.store.bumpGone(row.id, this.iso()) >= confirmations) {
          this.store.markRemoved(row.id);
          this.store.addEvent(row.id, 'removed', {}, 'digest', this.iso());
        }
      } catch (err) {
        this.log.warn({ url: row.listing.url, err: String(err) }, 'could not re-check listing');
        if (err instanceof HttpError && err.blocked) return;
      }
    }
  }

  /** Creates the "new match" event for listings that are ready to be shown. */
  private announce(): void {
    const now = this.clock();
    const cutoff = new Date(now.getTime() - 3 * this.cfg.schedule.intervalMinutes * 60_000).toISOString();
    const windows = JSON.parse(this.store.get('baseline_windows') ?? '[]') as [string, string][];
    for (const row of this.store.readyToAnnounce(cutoff)) {
      let delivery = this.level(row.evaluation.score);
      const seeded = windows.some(([from, to]) => row.firstSeen >= from && row.firstSeen <= to);
      // Listings found while seeding the database are not "news": no instant alert.
      if (delivery === 'instant' && seeded && this.cfg.notifications.firstRun === 'digest') delivery = 'digest';
      const reconsidered = this.store.get(`reconsidered:${row.id}`) === '1';
      this.store.addEvent(row.id, 'new', reconsidered ? { reconsidered: true } : {}, delivery, now.toISOString());
      this.store.markAnnounced(row.id);
    }
  }

  /** Stores one listing (new or seen before), re-scores it and records what changed. */
  async process(fresh: Listing): Promise<{ row: ListingRow; isNew: boolean }> {
    const prev = this.store.find(fresh.source, fresh.sourceId);
    let l = prev ? merge(prev.listing, fresh) : fresh;
    let e = evaluate(l, this.cfg);
    if (e.verdict === 'match' && l.commuteMinutes === null) {
      l = await this.enricher.enrich(l);
      e = evaluate(l, this.cfg);
    }
    const now = this.iso();

    if (!prev) {
      const id = this.store.insert(l, e, now);
      return { row: this.store.byId(id)!, isNew: true };
    }

    this.store.transaction(() => {
      this.store.update(prev.id, l, e, now);
      const tracked = prev.notified || prev.userState === 'favorite';
      const muted = prev.userState === 'ignored';
      const was = prev.listing;

      if (prev.status === 'removed' && tracked && !muted) this.store.addEvent(prev.id, 'relisted', {}, 'digest', now);

      if (l.price !== was.price) {
        this.store.addPrice(prev.id, l.price, now);
        if (was.price !== null && l.price !== null && prev.announced && !muted && e.verdict === 'match') {
          const drop = l.price < was.price;
          const delivery: Delivery = drop ? this.level(e.score) : tracked ? 'digest' : 'none';
          this.store.addEvent(prev.id, drop ? 'price_drop' : 'price_up', { from: was.price, to: l.price }, delivery, now);
        }
      } else if (tracked && !muted && e.verdict === 'match') {
        // Only a value that was known and is now different counts as a change;
        // a blank being filled in by a later, more detailed read does not.
        const changes = WATCHED_FIELDS.filter((f) => was[f] !== null && l[f] !== null && was[f] !== l[f]).map((f) => ({
          field: f,
          from: was[f],
          to: l[f],
        }));
        if (changes.length > 0) this.store.addEvent(prev.id, 'changed', { changes }, 'digest', now);
      }

      if (prev.evaluation.verdict === 'match' && e.verdict === 'rejected' && tracked && !muted) {
        this.store.addEvent(prev.id, 'changed', { nowRejected: e.reasons }, 'digest', now);
      }
      // A rejected listing that now qualifies is announced like a new one, with a note.
      if (prev.evaluation.verdict === 'rejected' && e.verdict === 'match' && !prev.announced) {
        this.store.set(`reconsidered:${prev.id}`, '1');
      }
    });
    return { row: this.store.byId(prev.id)!, isNew: false };
  }

  /**
   * Adds a listing by hand (the /add command). Links from a supported site are
   * read from the site; any other link (e.g. Facebook) is scored from the note
   * typed after it, such as "T2 900€ Gaia mobilado com garagem".
   */
  async addByUrl(rawUrl: string, note: string): Promise<ListingRow> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new UserError('That does not look like a link. Usage: /add <link> [notes]');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UserError('Only web links are supported.');

    let listing: Listing | null = null;
    for (const adapter of this.adapters) {
      if (!adapter.matches(url)) continue;
      const stub = adapter.stub(url);
      if (!stub) throw new UserError(`That is a ${adapter.name} link, but not a link to a single listing.`);
      const res = await adapter.details(stub, this.clock());
      if (res.kind === 'gone') throw new UserError('That listing is no longer available.');
      listing = res.listing;
      if (note) listing = applyText({ ...listing, description: `${listing.description ?? ''} . ${note}` }, '', this.clock());
      break;
    }
    if (!listing) listing = this.manualListing(url, note);

    const { row } = await this.process(listing);
    this.store.markAnnounced(row.id); // the reply to /add is the announcement
    this.store.markNotified(row.id);
    return this.store.byId(row.id)!;
  }

  private manualListing(url: URL, note: string): Listing {
    const id = createHash('sha1').update(url.toString()).digest('hex').slice(0, 12);
    let l = emptyListing('manual', id, url.toString());
    l.title = note.slice(0, 120) || `Listing on ${url.hostname.replace(/^www\./, '')}`;
    l.description = note || null;
    l.price = findEuroAmount(note);
    l.typology = parseTypology(note);
    l.areaM2 = parseArea(note);
    l.municipality = guessMunicipality(note, this.cfg.criteria.municipalities);
    l = applyText(l, '', this.clock());
    l.detailsFetched = true;
    return l;
  }
}
