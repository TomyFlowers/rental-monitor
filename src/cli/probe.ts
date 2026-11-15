/**
 * Reads one page from a source and prints what the adapter understood, without
 * touching the database or Telegram. Use it to check an adapter against the
 * live site:
 *
 *   pnpm probe imovirtual            first search URL from the config
 *   pnpm probe olx --save            also saves the raw page under data/probe/
 *   pnpm probe imovirtual <listing-url>   reads a single listing page
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { evaluate } from '../core/evaluator.js';
import { PoliteHttpClient, type HttpClient } from '../http/client.js';
import { createLogger } from '../logger.js';
import { createAdapters } from '../sources/registry.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const save = args.includes('--save');
  const [name, target] = args.filter((a) => !a.startsWith('--'));
  const cfg = loadConfig(resolve(process.env.CONFIG_PATH ?? 'config/config.yaml'));
  const log = createLogger(null, 'warn');
  const base = new PoliteHttpClient(cfg.http, log);
  const http: HttpClient = {
    async get(url, opts) {
      const res = await base.get(url, opts);
      if (save) {
        const dir = resolve(process.env.DATA_DIR ?? 'data', 'probe');
        mkdirSync(dir, { recursive: true });
        const file = `${dir}/${name}-${Date.now()}.html`;
        writeFileSync(file, res.body);
        console.log(`saved ${file} (${res.body.length} bytes, HTTP ${res.status})`);
      }
      return res;
    },
  };
  const adapter = createAdapters(http).find((a) => a.name === name);
  if (!adapter) throw new Error(`Usage: pnpm probe <${createAdapters(http).map((a) => a.name).join('|')}> [listing-url] [--save]`);
  const now = new Date();

  if (target) {
    const stub = adapter.stub(new URL(target));
    if (!stub) throw new Error('That URL is not a listing page of this source.');
    const res = await adapter.details(stub, now);
    if (res.kind === 'gone') return console.log('The site says this listing is gone.');
    console.log(JSON.stringify({ ...res.listing, description: res.listing.description?.slice(0, 200) }, null, 2));
    console.log(JSON.stringify(evaluate(res.listing, cfg), null, 2));
    return;
  }

  const url = cfg.sources[adapter.name]?.searches[0];
  if (!url) throw new Error(`No search URL configured for ${adapter.name}`);
  const page = await adapter.search(url, 1, now);
  console.log(`mode: ${page.mode}   listings: ${page.listings.length}   totalPages: ${page.totalPages ?? 'unknown'}`);
  if (page.mode === 'html') console.log('NOTE: embedded data was not found; the markup fallback was used.');
  console.table(
    page.listings.slice(0, 40).map((l) => {
      const e = evaluate(l, cfg);
      return { source: l.source, id: l.sourceId, T: l.typology, price: l.price, m2: l.areaM2, municipality: l.municipality, parish: l.parish, photos: l.images.length, verdict: e.verdict, score: e.score, why: e.reasons[0] ?? '' };
    }),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
