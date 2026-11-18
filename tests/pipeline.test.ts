import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { Listing } from '../src/core/types.js';
import { noEnricher } from '../src/enrich/commute.js';
import { HealthMonitor } from '../src/health/monitor.js';
import { HttpError } from '../src/http/client.js';
import { silentLogger } from '../src/logger.js';
import { Dispatcher, inQuietHours, type Notifier } from '../src/notify/dispatcher.js';
import { Monitor } from '../src/pipeline/monitor.js';
import type { DetailResult, SearchPage, SourceAdapter } from '../src/sources/types.js';
import { Store, type ListingRow } from '../src/store/db.js';
import { listing, shippedConfig } from './helpers.js';

/** A stand-in website whose search results and listing pages the test controls. */
class FakeSite implements SourceAdapter {
  readonly name = 'imovirtual';
  results: Listing[] = [];
  pages = new Map<string, Listing | 'gone'>();
  fail: Error | null = null;
  searches = 0;
  matches = (u: URL) => u.hostname === 'example.test';
  stub = (u: URL) => listing({ source: this.name, sourceId: u.pathname.slice(1), url: u.toString(), detailsFetched: false });
  async search(_url: string, page: number): Promise<SearchPage> {
    this.searches++;
    if (this.fail) throw this.fail;
    return { listings: page === 1 ? this.results : [], mode: 'structured', totalPages: 1 };
  }
  async details(l: Listing): Promise<DetailResult> {
    const p = this.pages.get(l.sourceId);
    if (p === 'gone') return { kind: 'gone' };
    return { kind: 'ok', listing: { ...l, ...(p ?? {}), detailsFetched: true } };
  }
}

class FakeTelegram implements Notifier {
  alerts: Array<{ row: ListingRow; html: string; photos: string[] }> = [];
  texts: string[] = [];
  async sendAlert(row: ListingRow, html: string, photos: string[]) {
    this.alerts.push({ row, html, photos });
  }
  async sendText(html: string) {
    this.texts.push(html);
  }
}

const item = (id: string, over: Partial<Listing> = {}) => listing({ source: 'imovirtual', sourceId: id, url: `https://example.test/${id}`, ...over });
/** Scores 100 with the shipped weights. */
const great = (id: string, over: Partial<Listing> = {}) =>
  item(id, { commuteMinutes: 10, registration: true, furnished: 'yes', garage: true, outdoor: true, availableFrom: '2027-01-05', images: ['https://img.test/1.jpg', 'https://img.test/2.jpg', 'https://img.test/3.jpg', 'https://img.test/4.jpg', 'https://img.test/5.jpg'], ...over });

let cfg: Config;
let store: Store;
let site: FakeSite;
let tg: FakeTelegram;
let monitor: Monitor;
let dispatcher: Dispatcher;
let health: HealthMonitor;
let now: Date;
const clock = () => now;
const at = (iso: string) => (now = new Date(iso));
const hours = (n: number) => (now = new Date(now.getTime() + n * 3_600_000));

async function check() {
  const summaries = (await monitor.runAll())!;
  await health.report(summaries);
  await dispatcher.flushInstant();
  return summaries;
}

beforeEach(async () => {
  cfg = shippedConfig();
  cfg.sources = { imovirtual: { enabled: true, maxPages: 3, firstRunMaxPages: 3, searches: ['https://example.test/search'] } };
  store = new Store(':memory:');
  site = new FakeSite();
  tg = new FakeTelegram();
  at('2026-11-16T12:00:00Z'); // midday in Lisbon
  monitor = new Monitor(cfg, store, [site], noEnricher, silentLogger, clock);
  dispatcher = new Dispatcher(cfg, store, tg, silentLogger, clock);
  health = new HealthMonitor(cfg.health, store, (h) => dispatcher.system(h));
});

/** Gets past the first (seeding) run with one unremarkable listing. */
async function seed() {
  site.results = [item('seed', { price: 1150, commuteMinutes: 45 })];
  await check();
  hours(1);
}

describe('first run', () => {
  it('seeds the database without instant alerts and reports matches in the digest', async () => {
    site.results = [great('a'), item('b'), item('far', { municipality: 'Maia' })];
    const [s] = await check();
    expect(s).toMatchObject({ ok: true, found: 3, fresh: 3 });
    expect(tg.alerts).toHaveLength(0);
    expect(store.counts()).toMatchObject({ active: 3, matches: 2 });

    await dispatcher.sendDigest();
    const digest = tg.texts.join('\n');
    expect(digest).toContain('New (2)');
    expect(digest).toContain('https://example.test/a');
    expect(digest).not.toContain('https://example.test/far');
  });
});

describe('new listings', () => {
  beforeEach(seed);

  it('sends a great match at once with a small album, and holds a middling one for the digest', async () => {
    site.results = [great('a'), item('b'), item('far', { municipality: 'Maia' }), ...site.results];
    await check();
    expect(tg.alerts.map((a) => a.row.listing.sourceId)).toEqual(['a']);
    expect(tg.alerts[0]!.photos).toHaveLength(4);
    expect(tg.alerts[0]!.html).toContain('New match · 100/100');

    await check(); // seen again: nothing is sent twice
    expect(tg.alerts).toHaveLength(1);

    await dispatcher.sendDigest();
    const digest = tg.texts.join('\n');
    expect(digest).toContain('https://example.test/b');
    expect(digest).not.toContain('https://example.test/far');
    await dispatcher.sendDigest(); // the same items never appear in two digests
    expect(tg.texts.at(-1)).toContain('Nothing new today');
  });

  it('waits for the listing page before announcing, and announces anyway if the page stays unreadable', async () => {
    site.results = [great('a', { detailsFetched: false, furnished: null }), ...site.results];
    site.pages.set('a', { furnished: 'yes' } as Listing);
    await check();
    expect(tg.alerts).toHaveLength(1); // page was read in the same run
    expect(tg.alerts[0]!.row.listing.furnished).toBe('yes');

    site.results = [great('b', { detailsFetched: false }), ...site.results];
    site.details = async () => {
      throw new HttpError('HTTP 500', 500, 'x');
    };
    await check();
    expect(tg.alerts).toHaveLength(1); // not yet
    hours(4);
    await check();
    expect(tg.alerts.map((a) => a.row.listing.sourceId)).toEqual(['a', 'b']);
  });

  it('holds alerts during quiet hours and releases them afterwards', async () => {
    at('2026-11-17T02:00:00Z');
    site.results = [great('night'), ...site.results];
    await check();
    expect(tg.alerts).toHaveLength(0);
    at('2026-11-17T07:59:00Z');
    await dispatcher.flushInstant();
    expect(tg.alerts).toHaveLength(0);
    at('2026-11-17T08:01:00Z');
    await dispatcher.flushInstant();
    expect(tg.alerts).toHaveLength(1);
  });

  it('moves alerts beyond the daily cap to the digest', async () => {
    cfg.notifications.maxInstantPerDay = 2;
    site.results = [great('a'), great('b'), great('c'), ...site.results];
    await check();
    expect(tg.alerts).toHaveLength(2);
    await dispatcher.sendDigest();
    expect(tg.texts.join('\n')).toMatch(/New \(2\)[\s\S]*example\.test\/c[\s\S]*Top picks/); // 'c' plus the seed listing
  });

  it('sends nothing while paused', async () => {
    dispatcher.setPaused(true);
    site.results = [great('a'), ...site.results];
    await check();
    expect(tg.alerts).toHaveLength(0);
    expect(await dispatcher.sendDigest()).toBe(false);
    dispatcher.setPaused(false);
    await dispatcher.flushInstant();
    expect(tg.alerts).toHaveLength(1);
  });
});

describe('changes to known listings', () => {
  beforeEach(seed);

  it('alerts on a price drop and records price history', async () => {
    site.results = [great('a', { price: 1000 }), ...site.results];
    await check();
    hours(1);
    site.results = [great('a', { price: 920 }), ...site.results.slice(1)];
    await check();
    expect(tg.alerts).toHaveLength(2);
    expect(tg.alerts[1]!.html).toContain('Price drop €1,000 → €920');
  });

  it('reconsiders a rejected listing when it changes to meet the criteria', async () => {
    site.results = [great('a', { price: 1250 }), ...site.results]; // T2 cap is 1150
    await check();
    expect(store.find('imovirtual', 'a')!.evaluation.verdict).toBe('rejected');
    expect(tg.alerts).toHaveLength(0);
    hours(1);
    site.results = [great('a', { price: 1100 }), ...site.results.slice(1)];
    await check();
    expect(tg.alerts).toHaveLength(1);
    expect(tg.alerts[0]!.html).toContain('Now matches after a change');
  });

  it('never notifies about an ignored listing', async () => {
    site.results = [great('a', { price: 1000 }), ...site.results];
    await check();
    store.setUserState(store.find('imovirtual', 'a')!.id, 'ignored');
    hours(1);
    site.results = [great('a', { price: 800 }), ...site.results.slice(1)];
    await check();
    await dispatcher.sendDigest();
    expect(tg.alerts).toHaveLength(1);
    expect(tg.texts.join('\n')).not.toContain('https://example.test/a');
  });

  it('keeps what it learned from the listing page when the search card is sparser', async () => {
    site.results = [great('a'), ...site.results];
    await check();
    site.results = [item('a', { images: ['https://img.test/1.jpg'], detailsFetched: false }), ...site.results.slice(1)];
    hours(1);
    await check();
    const l = store.find('imovirtual', 'a')!.listing;
    expect(l).toMatchObject({ furnished: 'yes', garage: true, commuteMinutes: 10 });
    expect(l.images).toHaveLength(5);
  });
});

describe('delisting', () => {
  beforeEach(seed);

  it('reports removal only after the listing page is gone twice, and only for listings the user knows', async () => {
    site.results = [great('a'), item('quiet', { price: 1150, commuteMinutes: 49 }), ...site.results];
    await check(); // 'a' alerted; 'quiet' scores below the digest threshold
    site.results = site.results.slice(2); // both drop out of the search
    site.pages.set('a', 'gone');
    site.pages.set('quiet', 'gone');

    hours(1);
    await check();
    expect(store.find('imovirtual', 'a')!.status).toBe('active'); // one "gone" is not enough
    hours(1);
    await check();
    expect(store.find('imovirtual', 'a')!.status).toBe('removed');
    expect(store.find('imovirtual', 'quiet')!.status).toBe('active'); // never shown, so never re-checked

    await dispatcher.sendDigest();
    expect(tg.texts.join('\n')).toMatch(/Removed \(1\)[\s\S]*example\.test\/a/);
  });

  it('does not treat a failing search as removals', async () => {
    site.results = [great('a'), ...site.results];
    await check();
    site.fail = new HttpError('HTTP 403', 403, 'x');
    for (let i = 0; i < 4; i++) {
      hours(1);
      await check();
    }
    expect(store.find('imovirtual', 'a')!.status).toBe('active');
  });
});

describe('health alerts', () => {
  beforeEach(seed);

  it('alerts once when a source refuses requests and once on recovery', async () => {
    site.fail = new HttpError('HTTP 403 for https://example.test/search', 403, 'x');
    for (let i = 0; i < 5; i++) {
      await check();
      hours(1);
    }
    const alerts = tg.texts.filter((t) => t.includes('🚨'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('refusing requests');
    site.fail = null;
    hours(4); // past the rest period
    await check();
    expect(tg.texts.filter((t) => t.includes('working again'))).toHaveLength(1);
  });

  it('rests a source that refused a request, for longer each time, and resumes afterwards', async () => {
    site.fail = new HttpError('HTTP 429', 429, 'x');
    await check();
    const before = site.searches;
    hours(1);
    await check(); // still resting: the site is not contacted
    expect(site.searches).toBe(before);
    expect(monitor.cooldownUntil('imovirtual')).not.toBeNull();
    hours(1.1); // 2 h rest is over; it fails again and now rests 4 h
    await check();
    expect(site.searches).toBe(before + 1);
    hours(3);
    await check();
    expect(site.searches).toBe(before + 1);
    site.fail = null;
    hours(1.1);
    await check();
    expect(site.searches).toBe(before + 2);
    expect(monitor.cooldownUntil('imovirtual')).toBeNull();
  });

  it('alerts after three ordinary failures in a row', async () => {
    site.fail = new Error('connect timeout');
    for (let i = 0; i < 4; i++) {
      await check();
      hours(1);
    }
    expect(tg.texts.filter((t) => t.includes('failed 3 checks in a row'))).toHaveLength(1);
  });

  it('treats an empty result page as a failure', async () => {
    site.results = [];
    const [s] = await check();
    expect(s).toMatchObject({ ok: false, note: expect.stringContaining('no listings found') });
  });
});

describe('/add', () => {
  it('reads a supported link from the site', async () => {
    site.pages.set('x9', great('x9'));
    const { row } = await monitor.addByUrl('https://example.test/x9', '');
    expect(row.evaluation.score).toBe(100);
    await check();
    expect(tg.alerts).toHaveLength(0); // the reply to /add was the announcement
  });

  it('scores an unsupported link from the typed note', async () => {
    const { row } = await monitor.addByUrl('https://www.facebook.com/marketplace/item/123', 'T2 900€ Gaia mobilado com garagem e varanda, com contrato');
    expect(row.listing).toMatchObject({ source: 'manual', price: 900, typology: 2, municipality: 'Vila Nova de Gaia', furnished: 'yes', garage: true, outdoor: true, registration: true });
    expect(row.evaluation.verdict).toBe('match');
  });

  it('rejects things that are not links', async () => {
    await expect(monitor.addByUrl('not a link', '')).rejects.toThrow(/does not look like a link/);
  });
});

describe('quiet hours', () => {
  const q = { start: '23:00', end: '08:00' };
  it.each([
    ['2026-11-16T22:59:00Z', false],
    ['2026-11-16T23:00:00Z', true],
    ['2026-11-17T03:30:00Z', true],
    ['2026-11-17T07:59:00Z', true],
    ['2026-11-17T08:00:00Z', false],
  ])('%s -> %s (Lisbon is on UTC in November)', (iso, want) => expect(inQuietHours(new Date(iso), 'Europe/Lisbon', q)).toBe(want));
  it('uses local time, not UTC, in summer', () => {
    expect(inQuietHours(new Date('2026-07-01T22:30:00Z'), 'Europe/Lisbon', q)).toBe(true); // 23:30 in Lisbon
  });
});
