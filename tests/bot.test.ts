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

async function reply(text: string, cardButtons: string[], from = ME) {
  const reply_to_message = { message_id: 7, date: 0, chat: chat(from), text: 'card', reply_markup: { inline_keyboard: [cardButtons.map((d) => ({ text: 'x', callback_data: d }))] } };
  await tg.bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 0, chat: chat(from), from: user(from), text, reply_to_message } } as any);
}
const editedButtons = () => buttons(sent('editMessageReplyMarkup').at(-1)!.payload);

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
    expect(buttons(lastCard())).toEqual([`u:${a}`, `c:${a}`, `i:${a}`, 'https://example.test/a']);

    await press(`i:${a}`); // contacted, but already rented
    expect(store.byId(a)!.userState).toBe('ignored');
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

describe('contact tracking', () => {
  it('moves a favourite through contacted and visit booked, and back', async () => {
    const a = add('a');
    store.setUserState(a, 'favorite');

    await press(`c:${a}`);
    expect(store.byId(a)).toMatchObject({ stage: 'contacted', userState: 'favorite' });
    expect(store.byId(a)!.contactedAt).not.toBeNull();
    expect(editedButtons()).toEqual([`x:${a}`, `v:${a}`, `i:${a}`, 'https://example.test/a']);

    await press(`v:${a}`);
    expect(store.byId(a)!.stage).toBe('visit');
    expect(editedButtons()).toEqual([`y:${a}`, `w:${a}`, `i:${a}`, 'https://example.test/a']);

    await press(`w:${a}`);
    expect(store.byId(a)!.stage).toBe('visited');
    expect(editedButtons()).toEqual([`z:${a}`, `i:${a}`, 'https://example.test/a']);
    await say('/contacted');
    expect(lastCard().text).toContain('visited today, not decided');
    await say(`/show_${a}`);
    expect(lastCard().text).toContain('👀 visited, not decided today');

    await press(`z:${a}`);
    expect(store.byId(a)!.stage).toBe('visit');
    await press(`y:${a}`);
    expect(store.byId(a)!.stage).toBe('contacted');
    await press(`x:${a}`);
    expect(store.byId(a)).toMatchObject({ stage: 'none', contactedAt: null, userState: 'favorite' });
  });

  it('groups the favourites list by stage, furthest along first', async () => {
    const plain = add('plain');
    const called = add('called');
    const visit = add('visit');
    const seen = add('seen');
    store.setUserState(plain, 'favorite');
    store.setStage(called, 'contacted', '2026-11-14T10:00:00Z');
    store.setStage(visit, 'visit', '2026-11-15T10:00:00Z');
    store.setStage(seen, 'visited', '2026-11-16T10:00:00Z');
    await say('/favorites');
    const text: string = lastCard().text;
    expect(text).toMatch(/👀 Visited, not decided \(1\)[\s\S]*example\.test\/seen[\s\S]*📅 Visit booked \(1\)[\s\S]*example\.test\/visit[\s\S]*📞 Contacted \(1\)[\s\S]*example\.test\/called[\s\S]*⭐ Not contacted yet \(1\)[\s\S]*example\.test\/plain/);
    expect(text).toContain('📞 <b>T2 · €900</b> · Mafamude, Gaia');
  });

  it('stars a listing when it is marked contacted, and clears the stage when un-starred', async () => {
    const a = add('a');
    await press(`c:${a}`);
    expect(store.byId(a)).toMatchObject({ stage: 'contacted', userState: 'favorite' });
    await press(`u:${a}`);
    expect(store.byId(a)).toMatchObject({ stage: 'none', userState: 'none' });
  });

  it('saves notes from a reply to a card or from /note, and shows them', async () => {
    const a = add('a');
    await press(`c:${a}`);
    await reply('Ligou, volta a ligar quinta <b>', [`x:${a}`, `v:${a}`]);
    expect(lastCard().text).toContain(`Note saved on /show_${a}`);
    await say(`/note ${a} visita sábado 11h`);
    expect(store.notes(a).map((n) => n.text)).toEqual(['visita sábado 11h', 'Ligou, volta a ligar quinta <b>']);

    await say('/contacted');
    expect(lastCard().text).toContain('Contacted (1)');
    expect(lastCard().text).toContain('contacted today · 📝 visita sábado 11h');

    await say(`/show_${a}`);
    expect(lastCard().text).toContain('📞 Contacted today');
    expect(lastCard().text).toContain('Ligou, volta a ligar quinta &lt;b&gt;'); // escaped

    await reply('nota solta', []); // a reply to something that is not a listing card
    expect(lastCard().text).toContain('reply to a listing card');
    await say('/note abc');
    expect(lastCard().text).toContain('Usage: /note');
  });

  it('reminds in the digest about contacted listings with no update for 3 days, until something happens', async () => {
    const a = add('a');
    const b = add('b');
    store.setStage(a, 'contacted', '2026-11-10T10:00:00Z');
    store.setStage(b, 'contacted', '2026-11-10T10:00:00Z');
    store.addNote(b, 'u', 'respondeu ontem', '2026-11-14T09:00:00Z'); // recent activity: no reminder
    const texts: string[] = [];
    const d = new Dispatcher(cfg, store, { sendAlert: async () => undefined, sendText: async (t) => void texts.push(t) }, silentLogger, () => new Date('2026-11-15T19:00:00Z'));
    await d.sendDigest();
    const digest = texts.join('\n');
    expect(digest).toMatch(/Contacted, no update since[\s\S]*5 days ago · [\s\S]*example\.test\/a/);
    expect(digest.split('Contacted, no update since')[1]).not.toContain('example.test/b');
  });
});


describe('links inside a message', () => {
  it('finds the link anywhere in shared text and reads the details around it', async () => {
    await say('Vê este anúncio: Apartamento T2 em Canidelo, Vila Nova de Gaia, 1.050 €/mês https://www.idealista.pt/imovel/123/?xtmc=share. Tem garagem');
    const row = store.topPicks(1)[0]!;
    expect(row.listing).toMatchObject({ source: 'manual', price: 1050, typology: 2, municipality: 'Vila Nova de Gaia', garage: true });
    expect(row.listing.url).toBe('https://www.idealista.pt/imovel/123/?xtmc=share');
    expect(lastCard().text).toContain('Added by hand');
  });

  it('suggests sending the text when the link alone gave nothing', async () => {
    await say('https://www.facebook.com/groups/1984259601822354/posts/9');
    expect(lastCard().text).toContain('Missing details?');
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
