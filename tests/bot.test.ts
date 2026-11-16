import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { evaluate } from '../src/core/evaluator.js';
import type { Listing } from '../src/core/types.js';
import { noEnricher } from '../src/enrich/commute.js';
import { silentLogger } from '../src/logger.js';
import { Dispatcher } from '../src/notify/dispatcher.js';
import { TelegramBot } from '../src/notify/telegram.js';
import { Monitor, type ListingFeed } from '../src/pipeline/monitor.js';
import type { SourceAdapter } from '../src/sources/types.js';
import { Store } from '../src/store/db.js';
import { listing, shippedConfig } from './helpers.js';

const ME = 42;
const BOT = { id: 1, is_bot: true as const, first_name: 'b', username: 'b_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false };

let cfg: Config;
let store: Store;
let tg: TelegramBot;
let calls: Array<{ method: string; payload: Record<string, any> }>;
let updateId = 0;

const user = (id: number) => ({ id, is_bot: false, first_name: 'u' });
const chat = (id: number) => ({ id, type: 'private' as const, first_name: 'u' });
async function say(text: string, from = ME) {
  const entities = text.startsWith('/') ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }] : undefined;
  await tg.bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 0, chat: chat(from), from: user(from), text, entities } } as any);
}
async function press(data: string, from = ME) {
  await tg.bot.handleUpdate({ update_id: ++updateId, callback_query: { id: String(updateId), chat_instance: 'x', from: user(from), data, message: { message_id: 7, date: 0, chat: chat(from), text: 'card' } } } as any);
}
const sent = (method: string) => calls.filter((c) => c.method === method);
const lastCard = () => sent('sendMessage').at(-1)!.payload;
const buttons = (p: Record<string, any>) => (p.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data ?? b.url);

function add(id: string, over: Partial<Listing> = {}) {
  const l = listing({ source: 'imovirtual', sourceId: id, url: `https://example.test/${id}`, ...over });
  return store.insert(l, evaluate(l, cfg), '2026-11-15T10:00:00Z');
}

beforeEach(async () => {
  cfg = shippedConfig();
  store = new Store(':memory:');
  calls = [];
  tg = new TelegramBot({ botToken: '1:x', allowedUserIds: [ME], email: null }, cfg, store, silentLogger, BOT as any);
  tg.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    return { ok: true, result: true } as any;
  });
  const monitor = new Monitor(cfg, store, [], noEnricher, silentLogger);
  tg.attach({ monitor, dispatcher: new Dispatcher(cfg, store, tg, silentLogger), checkNow: async () => [], nextCheckAt: () => null });
});

describe('/rate', () => {
  it('walks through unrated matches best first, recording each choice', async () => {
    const best = add('best', { commuteMinutes: 10, furnished: 'yes', images: ['https://img.test/1.jpg', 'https://img.test/2.jpg', 'https://img.test/3.jpg', 'https://img.test/4.jpg'] });
    const mid = add('mid', { commuteMinutes: 35 });
    const low = add('low', { commuteMinutes: 48, price: 1150 });
    add('rejected', { municipality: 'Maia' });
    store.setUserState(add('already', { commuteMinutes: 5 }), 'favorite');

    await say('/rate');
    expect(lastCard().text).toContain('To rate · 3 left');
    expect(lastCard().text).toContain('https://example.test/best');
    expect(buttons(lastCard())).toEqual([`rf:${best}`, `ri:${best}`, `rs:${best}`, 'https://example.test/best']);
    expect(sent('sendMediaGroup')[0]!.payload.media).toHaveLength(3); // ratePhotos

    await press(`rf:${best}`);
    expect(store.byId(best)!.userState).toBe('favorite');
    expect(buttons(sent('editMessageReplyMarkup').at(-1)!.payload)).toContain(`u:${best}`); // undo stays possible
    expect(lastCard().text).toContain('To rate · 2 left');
    expect(lastCard().text).toContain('https://example.test/mid');

    await press(`rs:${mid}`); // skip
    expect(store.byId(mid)!.userState).toBe('none');
    expect(lastCard().text).toContain('https://example.test/low');

    await press(`ri:${low}`);
    expect(store.byId(low)!.userState).toBe('ignored');
    expect(lastCard().text).toContain('everything except the 1 you skipped');

    await say('/rate'); // a new round offers the skipped one again
    expect(lastCard().text).toContain('https://example.test/mid');
    await press(`ri:${mid}`);
    expect(lastCard().text).toContain('Nothing left to rate');
    expect(sent('answerCallbackQuery')).toHaveLength(4);
  });

  it('ignores people who are not on the allow list', async () => {
    const id = add('a');
    await say('/rate', 999);
    await press(`rf:${id}`, 999);
    expect(calls).toHaveLength(0);
    expect(store.byId(id)!.userState).toBe('none');
  });
});

describe('lists and editing', () => {
  it('shows favourites as one list and opens a single listing for editing', async () => {
    const a = add('a');
    const b = add('b');
    store.setUserState(a, 'favorite');
    store.setUserState(b, 'favorite');

    await say('/favorites');
    expect(sent('sendMessage')).toHaveLength(1); // one message, not one per listing
    expect(lastCard().text).toContain('Favourites (2)');
    expect(lastCard().text).toContain('⭐ <b>T2 · €900</b> · Mafamude, Gaia\n'); // short town name, no score or driving time
    expect(lastCard().text).not.toContain('🚗');
    expect(lastCard().text).toContain(`/show_${a}`);
    expect(lastCard().text).toContain(`/show_${b}`);

    await say(`/show_${a}`);
    expect(lastCard().text).toContain(`Listing ${a} · ⭐ favourite`);
    expect(buttons(lastCard())).toEqual([`u:${a}`, `i:${a}`, 'https://example.test/a']);

    await press(`i:${a}`); // contacted, but already rented
    expect(store.byId(a)!.userState).toBe('ignored');
    expect(sent('answerCallbackQuery').at(-1)!.payload.text).toBe('Moved from favourites to ignored');
    expect(store.favorites().map((r) => r.id)).toEqual([b]);

    await say('/ignored');
    expect(lastCard().text).toContain('Ignored (1)');
    await press(`u:${a}`);
    expect(store.byId(a)!.userState).toBe('none');

    await say('/show_9999');
    expect(lastCard().text).toContain('no listing with that number');
  });

  it('says so when there are none', async () => {
    await say('/favorites');
    expect(lastCard().text).toContain('No favourites yet');
  });
});

describe('pasted links', () => {
  it('treats a bare link with notes like /add', async () => {
    await say('https://www.facebook.com/groups/1984259601822354/posts/1 T2 900€ Gaia mobilado com garagem');
    const row = store.topPicks(1)[0]!;
    expect(row.listing).toMatchObject({ source: 'manual', price: 900, typology: 2, municipality: 'Vila Nova de Gaia', garage: true });
    expect(lastCard().text).toContain('Added by hand');
    expect(buttons(lastCard())[0]).toBe(`f:${row.id}`);
  });
});

describe('monitor with feeds and disabled sources', () => {
  it('stores listings from a feed and reports a feed failure without stopping', async () => {
    let fail = false;
    const feed: ListingFeed = {
      name: 'email',
      fetch: async () => {
        if (fail) throw new Error('IMAP login failed');
        return { listings: [listing({ source: 'idealista', sourceId: '111', url: 'https://www.idealista.pt/imovel/111/' })], note: '1 alert email(s)' };
      },
    };
    const m = new Monitor({ ...cfg, sources: {} }, store, [], noEnricher, silentLogger, undefined, [feed]);
    expect(await m.runAll()).toMatchObject([{ source: 'email', ok: true, found: 1, fresh: 1 }]);
    expect(store.find('idealista', '111')).not.toBeNull();
    fail = true;
    expect(await m.runAll()).toMatchObject([{ source: 'email', ok: false, note: 'IMAP login failed' }]);
  });

  it('makes no requests at all for a disabled source', async () => {
    let requests = 0;
    const olx = { name: 'olx', matches: () => false, stub: () => null, search: async () => (requests++, { listings: [], mode: 'structured', totalPages: 1 }), details: async () => (requests++, { kind: 'gone' }) } as unknown as SourceAdapter;
    const id = add('x', { source: 'olx', detailsFetched: false });
    store.markNotified(id);
    const m = new Monitor({ ...cfg, sources: { olx: { enabled: false, maxPages: 1, firstRunMaxPages: 1, searches: ['https://www.olx.pt/x'] } } }, store, [olx], noEnricher, silentLogger);
    await m.runAll();
    expect(requests).toBe(0);
  });
});
