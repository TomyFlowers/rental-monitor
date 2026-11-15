import { describe, expect, it } from 'vitest';
import { loadSecrets, parseConfig } from '../src/config.js';
import { HttpError, PoliteHttpClient } from '../src/http/client.js';
import { silentLogger } from '../src/logger.js';
import { alertHtml, digestHtml } from '../src/notify/format.js';
import { evaluate } from '../src/core/evaluator.js';
import { listing, shippedConfig } from './helpers.js';
import type { ListingRow } from '../src/store/db.js';

describe('config', () => {
  it('accepts the shipped config.yaml', () => {
    const cfg = shippedConfig();
    expect(cfg.criteria.maxRent).toMatchObject({ T1: 1000, T2: 1150, T3: 1300 });
    expect(cfg.schedule.quietHours).toEqual({ start: '23:00', end: '08:00' });
  });
  it('explains what is wrong with a bad config', () => {
    const raw = structuredClone(shippedConfig()) as unknown as Record<string, any>;
    raw.schedule.digestTime = '7pm';
    raw.scoring.weights.garagem = 5;
    expect(() => parseConfig(raw)).toThrow(/schedule\.digestTime[\s\S]*scoring\.weights/);
  });
  it('requires the Telegram secrets and numeric user ids', () => {
    expect(() => loadSecrets({})).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => loadSecrets({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_ALLOWED_USER_IDS: 'me' })).toThrow(/non-numeric/);
    expect(loadSecrets({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_ALLOWED_USER_IDS: '11, 22' }).allowedUserIds).toEqual([11, 22]);
  });
});

describe('http client', () => {
  const http = { ...shippedConfig().http, minDelayMs: 0, maxDelayMs: 0, robotsTxt: 'off' as const, retries: 2 };
  const client = (responses: Array<number | Error>) => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return new Response(`body ${r}`, { status: r ?? 200 });
    }) as unknown as typeof fetch;
    return { c: new PoliteHttpClient(http, silentLogger, fake), calls };
  };

  it('returns the page on success', async () => {
    const { c } = client([200]);
    expect((await c.get('https://a.test/x')).body).toBe('body 200');
  });
  it('does not retry a refusal, and marks it as blocked', async () => {
    const { c, calls } = client([403, 200]);
    const err = await c.get('https://a.test/x').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.blocked).toBe(true);
    expect(calls).toHaveLength(1);
  });
  it('obeys robots.txt when set to enforce', async () => {
    const fake = (async (url: string) => new Response(url.endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /private' : 'ok')) as unknown as typeof fetch;
    const c = new PoliteHttpClient({ ...http, robotsTxt: 'enforce' }, silentLogger, fake);
    expect((await c.get('https://a.test/public')).body).toBe('ok');
    await expect(c.get('https://a.test/private/x')).rejects.toThrow(/robots\.txt/);
  });
});

describe('message formatting', () => {
  const cfg = shippedConfig();
  const row = (over = {}): ListingRow => {
    const l = listing({ title: 'T2 <novo> & "raro"', commuteMinutes: 18, coordsApprox: true, furnished: 'yes', ...over });
    return { id: 1, listing: l, evaluation: evaluate(l, cfg), status: 'active', userState: 'none', notified: false, announced: true, goneCount: 0, firstSeen: '', lastSeen: '' };
  };
  it('escapes listing text and shows facts, flags and the link', () => {
    const html = alertHtml({ type: 'new', payload: {}, row: row() }, 'ULS Gaia/Espinho');
    expect(html).toContain('T2 · €900/month');
    expect(html).toContain('about 18 min to ULS Gaia/Espinho (from area centre)');
    expect(html).toContain('✅ Furnished');
    expect(html).toContain('⚠️');
    expect(html).toContain('T2 &lt;novo&gt; &amp; "raro"');
    expect(html).not.toContain('<novo>');
  });
  it('splits a long digest into messages under the Telegram limit', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: i, type: 'new' as const, payload: {}, delivery: 'digest' as const, createdAt: '', row: row({ sourceId: `x${i}` }) }));
    const messages = digestHtml({ date: '2026-11-16', fresh: many, changed: [], removed: [], topPicks: [], hidden: 3, sources: [] });
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(m.length).toBeLessThanOrEqual(4096);
    expect(messages.join('\n')).toContain('New (63)');
  });
});
