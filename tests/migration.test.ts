import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { evaluate } from '../src/core/evaluator.js';
import { Store } from '../src/store/db.js';
import { listing, shippedConfig } from './helpers.js';

it('upgrades a database created by an earlier version, keeping its data', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rm-')), 'old.sqlite');
  const l = listing();
  // The listings table exactly as v0.1-v0.3 created it (no stage columns, no notes table).
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE listings (id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, url TEXT NOT NULL, data TEXT NOT NULL, price REAL,
    status TEXT NOT NULL DEFAULT 'active', verdict TEXT NOT NULL, score REAL NOT NULL, evaluation TEXT NOT NULL, user_state TEXT NOT NULL DEFAULT 'none',
    notified INTEGER NOT NULL DEFAULT 0, announced INTEGER NOT NULL DEFAULT 0, gone_count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, last_checked TEXT NOT NULL, UNIQUE (source, source_id))`);
  old.prepare("INSERT INTO listings (source, source_id, url, data, price, verdict, score, evaluation, user_state, first_seen, last_seen, last_checked) VALUES (?, ?, ?, ?, ?, 'match', 60, ?, 'favorite', 'x', 'x', 'x')")
    .run(l.source, l.sourceId, l.url, JSON.stringify(l), l.price, JSON.stringify(evaluate(l, shippedConfig())));
  old.close();

  const store = new Store(path);
  const row = store.find(l.source, l.sourceId)!;
  expect(row).toMatchObject({ userState: 'favorite', stage: 'none', contactedAt: null });
  store.setStage(row.id, 'contacted', '2026-11-15T00:00:00Z');
  store.addNote(row.id, 'u', 'ok', '2026-11-15T00:00:00Z');
  store.close();
  expect(new Store(path).inProgress()).toHaveLength(1); // reopening does not try to add the columns twice
});
