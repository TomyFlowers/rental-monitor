import { DatabaseSync } from 'node:sqlite';
import type { Delivery, Evaluation, EventType, Listing } from '../core/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  url           TEXT NOT NULL,
  data          TEXT NOT NULL,
  price         REAL,
  status        TEXT NOT NULL DEFAULT 'active',
  verdict       TEXT NOT NULL,
  score         REAL NOT NULL,
  evaluation    TEXT NOT NULL,
  user_state    TEXT NOT NULL DEFAULT 'none',
  notified      INTEGER NOT NULL DEFAULT 0,
  announced     INTEGER NOT NULL DEFAULT 0,
  gone_count    INTEGER NOT NULL DEFAULT 0,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  last_checked  TEXT NOT NULL,
  UNIQUE (source, source_id)
);
CREATE TABLE IF NOT EXISTS price_history (
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  price      REAL,
  at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  delivery   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at    TEXT
);
CREATE INDEX IF NOT EXISTS events_pending ON events (delivery, sent_at);
CREATE TABLE IF NOT EXISTS source_runs (
  id         INTEGER PRIMARY KEY,
  source     TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  found      INTEGER NOT NULL,
  fresh      INTEGER NOT NULL,
  note       TEXT
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS geocache (query TEXT PRIMARY KEY, lat REAL, lon REAL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS commutecache (key TEXT PRIMARY KEY, minutes REAL, at TEXT NOT NULL);
`;

export type UserState = 'none' | 'favorite' | 'ignored';

export interface ListingRow {
  id: number;
  listing: Listing;
  evaluation: Evaluation;
  status: 'active' | 'removed';
  userState: UserState;
  notified: boolean;
  /** A "new match" event has been created for this listing. */
  announced: boolean;
  goneCount: number;
  firstSeen: string;
  lastSeen: string;
}

export interface EventRow {
  id: number;
  type: EventType;
  payload: Record<string, unknown>;
  delivery: Delivery;
  createdAt: string;
  row: ListingRow;
}

export interface RunRow {
  source: string;
  startedAt: string;
  ok: boolean;
  found: number;
  fresh: number;
  note: string | null;
}

type Raw = Record<string, unknown>;

function toRow(r: Raw): ListingRow {
  return {
    id: Number(r.id),
    listing: JSON.parse(String(r.data)) as Listing,
    evaluation: JSON.parse(String(r.evaluation)) as Evaluation,
    status: r.status as ListingRow['status'],
    userState: r.user_state as UserState,
    notified: Number(r.notified) === 1,
    announced: Number(r.announced) === 1,
    goneCount: Number(r.gone_count),
    firstSeen: String(r.first_seen),
    lastSeen: String(r.last_seen),
  };
}

const L_COLS = 'l.id, l.data, l.evaluation, l.status, l.user_state, l.notified, l.announced, l.gone_count, l.first_seen, l.last_seen';

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- listings ------------------------------------------------------------

  find(source: string, sourceId: string): ListingRow | null {
    const r = this.db.prepare(`SELECT ${L_COLS} FROM listings l WHERE l.source = ? AND l.source_id = ?`).get(source, sourceId);
    return r ? toRow(r as Raw) : null;
  }

  byId(id: number): ListingRow | null {
    const r = this.db.prepare(`SELECT ${L_COLS} FROM listings l WHERE l.id = ?`).get(id);
    return r ? toRow(r as Raw) : null;
  }

  insert(l: Listing, e: Evaluation, now: string): number {
    const res = this.db
      .prepare(
        `INSERT INTO listings (source, source_id, url, data, price, verdict, score, evaluation, first_seen, last_seen, last_checked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(l.source, l.sourceId, l.url, JSON.stringify(l), l.price, e.verdict, e.score, JSON.stringify(e), now, now, now);
    const id = Number(res.lastInsertRowid);
    this.addPrice(id, l.price, now);
    return id;
  }

  /** Saves new data for a listing that was seen again and marks it active. */
  update(id: number, l: Listing, e: Evaluation, now: string): void {
    this.db
      .prepare(
        `UPDATE listings SET url = ?, data = ?, price = ?, verdict = ?, score = ?, evaluation = ?,
           status = 'active', gone_count = 0, last_seen = ?, last_checked = ? WHERE id = ?`,
      )
      .run(l.url, JSON.stringify(l), l.price, e.verdict, e.score, JSON.stringify(e), now, now, id);
  }

  addPrice(id: number, price: number | null, at: string): void {
    this.db.prepare('INSERT INTO price_history (listing_id, price, at) VALUES (?, ?, ?)').run(id, price, at);
  }

  setUserState(id: number, state: UserState): void {
    this.db.prepare('UPDATE listings SET user_state = ? WHERE id = ?').run(state, id);
  }

  markNotified(id: number): void {
    this.db.prepare('UPDATE listings SET notified = 1 WHERE id = ?').run(id);
  }

  markAnnounced(id: number): void {
    this.db.prepare('UPDATE listings SET announced = 1 WHERE id = ?').run(id);
  }

  /**
   * Matches not yet announced that are ready: their page has been read, or
   * they have waited since before `cutoff` (so a blocked detail page cannot
   * hold a listing back forever).
   */
  readyToAnnounce(cutoff: string): ListingRow[] {
    return this.db
      .prepare(
        `SELECT ${L_COLS} FROM listings l
         WHERE l.status = 'active' AND l.verdict = 'match' AND l.announced = 0 AND l.user_state != 'ignored'
           AND (json_extract(l.data, '$.detailsFetched') = 1 OR l.first_seen < ?)
         ORDER BY l.score DESC`,
      )
      .all(cutoff)
      .map((r) => toRow(r as Raw));
  }

  /** Records a "page is gone" result; returns the new consecutive count. */
  bumpGone(id: number, now: string): number {
    this.db.prepare('UPDATE listings SET gone_count = gone_count + 1, last_checked = ? WHERE id = ?').run(now, id);
    return Number((this.db.prepare('SELECT gone_count c FROM listings WHERE id = ?').get(id) as Raw).c);
  }

  markChecked(id: number, now: string): void {
    this.db.prepare('UPDATE listings SET gone_count = 0, last_checked = ? WHERE id = ?').run(now, id);
  }

  markRemoved(id: number): void {
    this.db.prepare("UPDATE listings SET status = 'removed' WHERE id = ?").run(id);
  }

  /** Matching listings whose own page has not been read yet, best first. */
  needingDetails(source: string, limit: number, firstSeenSince: string): ListingRow[] {
    return this.db
      .prepare(
        `SELECT ${L_COLS} FROM listings l
         WHERE l.source = ? AND l.status = 'active' AND l.verdict = 'match' AND l.user_state != 'ignored'
           AND json_extract(l.data, '$.detailsFetched') = 0 AND l.first_seen >= ?
         ORDER BY l.score DESC LIMIT ?`,
      )
      .all(source, firstSeenSince, limit)
      .map((r) => toRow(r as Raw));
  }

  /** Listings the user was told about or starred, least recently checked first. */
  delistCandidates(source: string, limit: number, seenBefore: string): ListingRow[] {
    return this.db
      .prepare(
        `SELECT ${L_COLS} FROM listings l
         WHERE l.source = ? AND l.status = 'active' AND l.user_state != 'ignored'
           AND (l.notified = 1 OR l.user_state = 'favorite') AND l.last_checked < ?
         ORDER BY l.last_checked ASC LIMIT ?`,
      )
      .all(source, seenBefore, limit)
      .map((r) => toRow(r as Raw));
  }

  topPicks(limit: number): ListingRow[] {
    return this.db
      .prepare(
        `SELECT ${L_COLS} FROM listings l
         WHERE l.status = 'active' AND l.verdict = 'match' AND l.user_state != 'ignored'
         ORDER BY l.score DESC, l.first_seen DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => toRow(r as Raw));
  }

  favorites(): ListingRow[] {
    return this.db
      .prepare(`SELECT ${L_COLS} FROM listings l WHERE l.user_state = 'favorite' ORDER BY l.status ASC, l.score DESC`)
      .all()
      .map((r) => toRow(r as Raw));
  }

  counts(): { active: number; matches: number; favorites: number; ignored: number; removed: number } {
    const r = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(status = 'active'), 0) active,
           COALESCE(SUM(status = 'active' AND verdict = 'match'), 0) matches,
           COALESCE(SUM(user_state = 'favorite'), 0) favorites,
           COALESCE(SUM(user_state = 'ignored'), 0) ignored,
           COALESCE(SUM(status = 'removed'), 0) removed
         FROM listings`,
      )
      .get() as Raw;
    return {
      active: Number(r.active),
      matches: Number(r.matches),
      favorites: Number(r.favorites),
      ignored: Number(r.ignored),
      removed: Number(r.removed),
    };
  }

  // --- events --------------------------------------------------------------

  addEvent(listingId: number, type: EventType, payload: Record<string, unknown>, delivery: Delivery, now: string): number {
    const res = this.db
      .prepare('INSERT INTO events (listing_id, type, payload, delivery, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(listingId, type, JSON.stringify(payload), delivery, now, delivery === 'none' ? now : null);
    return Number(res.lastInsertRowid);
  }

  pendingEvents(delivery: Exclude<Delivery, 'none'>): EventRow[] {
    return this.db
      .prepare(
        `SELECT e.id eid, e.type, e.payload, e.delivery, e.created_at, ${L_COLS}
         FROM events e JOIN listings l ON l.id = e.listing_id
         WHERE e.delivery = ? AND e.sent_at IS NULL ORDER BY l.score DESC, e.id ASC`,
      )
      .all(delivery)
      .map((r) => {
        const raw = r as Raw;
        return {
          id: Number(raw.eid),
          type: raw.type as EventType,
          payload: JSON.parse(String(raw.payload)) as Record<string, unknown>,
          delivery: raw.delivery as Delivery,
          createdAt: String(raw.created_at),
          row: toRow(raw),
        };
      });
  }

  markEventSent(id: number, now: string): void {
    this.db.prepare('UPDATE events SET sent_at = ? WHERE id = ?').run(now, id);
  }

  moveEventToDigest(id: number): void {
    this.db.prepare("UPDATE events SET delivery = 'digest' WHERE id = ?").run(id);
  }

  instantSentSince(since: string): number {
    const r = this.db.prepare("SELECT COUNT(*) c FROM events WHERE delivery = 'instant' AND sent_at >= ?").get(since) as Raw;
    return Number(r.c);
  }

  // --- source runs ---------------------------------------------------------

  recordRun(run: RunRow): void {
    this.db
      .prepare('INSERT INTO source_runs (source, started_at, ok, found, fresh, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(run.source, run.startedAt, run.ok ? 1 : 0, run.found, run.fresh, run.note);
    // Keep the table small: a few weeks of hourly runs per source is plenty.
    this.db
      .prepare('DELETE FROM source_runs WHERE source = ? AND id NOT IN (SELECT id FROM source_runs WHERE source = ? ORDER BY id DESC LIMIT 500)')
      .run(run.source, run.source);
  }

  recentRuns(source: string, limit: number): RunRow[] {
    return this.db
      .prepare('SELECT source, started_at, ok, found, fresh, note FROM source_runs WHERE source = ? ORDER BY id DESC LIMIT ?')
      .all(source, limit)
      .map((r) => {
        const raw = r as Raw;
        return {
          source: String(raw.source),
          startedAt: String(raw.started_at),
          ok: Number(raw.ok) === 1,
          found: Number(raw.found),
          fresh: Number(raw.fresh),
          note: raw.note === null ? null : String(raw.note),
        };
      });
  }

  hasSuccessfulRun(source: string): boolean {
    return this.db.prepare('SELECT 1 FROM source_runs WHERE source = ? AND ok = 1 LIMIT 1').get(source) !== undefined;
  }

  // --- key/value and caches ------------------------------------------------

  get(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Raw | undefined;
    return r ? String(r.value) : null;
  }

  set(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  geoGet(query: string): { lat: number; lon: number } | null | undefined {
    const r = this.db.prepare('SELECT lat, lon FROM geocache WHERE query = ?').get(query) as Raw | undefined;
    if (!r) return undefined; // never looked up
    return r.lat === null ? null : { lat: Number(r.lat), lon: Number(r.lon) };
  }

  geoSet(query: string, coords: { lat: number; lon: number } | null, now: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO geocache (query, lat, lon, at) VALUES (?, ?, ?, ?)')
      .run(query, coords?.lat ?? null, coords?.lon ?? null, now);
  }

  commuteGet(key: string): number | undefined {
    const r = this.db.prepare('SELECT minutes FROM commutecache WHERE key = ?').get(key) as Raw | undefined;
    return r ? Number(r.minutes) : undefined;
  }

  commuteSet(key: string, minutes: number, now: string): void {
    this.db.prepare('INSERT OR REPLACE INTO commutecache (key, minutes, at) VALUES (?, ?, ?)').run(key, minutes, now);
  }
}
