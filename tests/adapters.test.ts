import { describe, expect, it } from 'vitest';
import { CommuteEnricher } from '../src/enrich/commute.js';
import { PoliteHttpClient } from '../src/http/client.js';
import { silentLogger } from '../src/logger.js';
import { ImovirtualAdapter } from '../src/sources/imovirtual/index.js';
import { OlxAdapter } from '../src/sources/olx/index.js';
import { Store } from '../src/store/db.js';
import { listing, shippedConfig } from './helpers.js';

const cfg = shippedConfig();
const NOW = new Date('2026-11-14T12:00:00Z');

/** A fake internet: maps URL prefixes to responses and records every request. */
function web(routes: Record<string, { status?: number; body?: string; redirect?: string }>) {
  const calls: string[] = [];
  const fake = (async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const r = key ? routes[key]! : { status: 404 };
    const res = new Response(r.body ?? '', { status: r.status ?? 200 });
    Object.defineProperty(res, 'url', { value: r.redirect ?? url });
    return res;
  }) as unknown as typeof fetch;
  const http = new PoliteHttpClient({ ...cfg.http, minDelayMs: 0, maxDelayMs: 0, retries: 0, robotsTxt: 'off' }, silentLogger, fake);
  return { http, calls };
}

describe('adapters over HTTP', () => {
  it('imovirtual asks for the right page and detects expired listings', async () => {
    const { http, calls } = web({
      'https://www.imovirtual.com/pt/resultados': { body: '<html><body></body></html>' },
      'https://www.imovirtual.com/pt/anuncio/expired-ID1': { body: '<html></html>', redirect: 'https://www.imovirtual.com/pt/resultados/arrendar/apartamento/porto' },
      'https://www.imovirtual.com/pt/anuncio/missing-ID2': { status: 410 },
    });
    const a = new ImovirtualAdapter(http);
    await a.search(cfg.sources.imovirtual!.searches[0]!, 3, NOW);
    expect(calls[0]).toMatch(/priceMax=1300.*[?&]page=3$/);
    const stub = (slug: string) => a.stub(new URL(`https://www.imovirtual.com/pt/anuncio/${slug}`))!;
    expect((await a.details(stub('expired-ID1'), NOW)).kind).toBe('gone');
    expect((await a.details(stub('missing-ID2'), NOW)).kind).toBe('gone');
    expect(a.stub(new URL('https://www.imovirtual.com/pt/resultados/arrendar'))).toBeNull();
  });

  it('olx keeps the search filters when paging and detects deactivated ads', async () => {
    const { http, calls } = web({
      'https://www.olx.pt/imoveis': { body: '<html></html>' },
      'https://www.olx.pt/d/anuncio/gone-IDa.html': { body: '<html></html>', redirect: 'https://www.olx.pt/imoveis/apartamentos-arrenda/' },
    });
    const a = new OlxAdapter(http);
    await a.search(cfg.sources.olx!.searches[0]!, 2, NOW);
    expect(calls[0]).toContain('filter_float_price%3Ato%5D=1350');
    expect(calls[0]).toMatch(/[?&]page=2$/);
    expect((await a.details(a.stub(new URL('https://www.olx.pt/d/anuncio/gone-IDa.html'))!, NOW)).kind).toBe('gone');
  });
});

describe('commute enrichment', () => {
  const osrm = { body: JSON.stringify({ routes: [{ duration: 900 }] }) }; // 15 min free-flow
  it('uses listing coordinates, applies the traffic factor and caches the route', async () => {
    const { http, calls } = web({ 'https://router.project-osrm.org': osrm });
    const store = new Store(':memory:');
    const e = new CommuteEnricher(cfg.commute, http, store, silentLogger);
    const out = await e.enrich(listing({ lat: 41.15, lon: -8.61 }));
    expect(out.commuteMinutes).toBe(19.5); // 15 x 1.3
    expect(out.coordsApprox).toBe(false);
    expect(calls[0]).toContain('/route/v1/driving/-8.61,41.15;-8.5932,41.1066');
    await e.enrich(listing({ sourceId: 'b', lat: 41.1501, lon: -8.6101 })); // same block: served from cache
    expect(calls).toHaveLength(1);
  });

  it('geocodes the parish when there are no coordinates and marks the result approximate', async () => {
    const { http, calls } = web({
      'https://nominatim.openstreetmap.org': { body: JSON.stringify([{ lat: '41.12', lon: '-8.60' }]) },
      'https://router.project-osrm.org': osrm,
    });
    const e = new CommuteEnricher(cfg.commute, http, new Store(':memory:'), silentLogger);
    const out = await e.enrich(listing());
    expect(out).toMatchObject({ lat: 41.12, lon: -8.6, coordsApprox: true, commuteMinutes: 19.5 });
    expect(decodeURIComponent(calls[0]!)).toContain('q=Mafamude, Vila Nova de Gaia, Portugal');
  });

  it('leaves the commute unknown when the services fail, instead of failing the listing', async () => {
    const { http } = web({ 'https://router.project-osrm.org': { status: 500 } });
    const e = new CommuteEnricher(cfg.commute, http, new Store(':memory:'), silentLogger);
    expect((await e.enrich(listing({ lat: 41.15, lon: -8.61 }))).commuteMinutes).toBeNull();
  });
});
