import * as cheerio from 'cheerio';
import { emptyListing, type Listing } from '../../core/types.js';
import { findEuroAmount, norm, parseArea, parseDateValue, parsePrice, parseTypology } from '../../core/text.js';
import { applyText, deepFind, factsToText, isObj, known, looksGone, num, spacedText, str, yesNo, type SearchPage } from '../types.js';

export const SOURCE = 'imovirtual';
const ORIGIN = 'https://www.imovirtual.com';
const ROOMS: Record<string, number> = { ZERO: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10 };

/** "…-em-paranhos-porto-ID1iWyZ" -> "ID1iWyZ". This id is shared with OLX cross-posts. */
export function idFromUrl(url: string): string | null {
  return /-(ID[0-9A-Za-z]+)(?:\.html)?(?:[?#].*)?$/.exec(url)?.[1] ?? null;
}

function nextData(html: string): unknown {
  const $ = cheerio.load(html);
  const raw = $('script#__NEXT_DATA__').first().text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** "Rua X, Bairro, Paranhos, Porto, Porto" -> parish "Paranhos", municipality "Porto". */
export function splitLocation(text: string | null): { municipality: string | null; parish: string | null } {
  const parts = (text ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { municipality: parts[0] ?? null, parish: null };
  // Last part is the district, the one before it the municipality.
  return { municipality: parts[parts.length - 2] ?? null, parish: parts.length >= 3 ? (parts[parts.length - 3] ?? null) : null };
}

function isSearchItems(node: unknown): node is Record<string, unknown>[] {
  return (
    Array.isArray(node) &&
    node.length > 0 &&
    node.every((it) => isObj(it) && typeof it.slug === 'string' && typeof it.title === 'string' && ('totalPrice' in it || 'location' in it))
  );
}

function fromSearchItem(it: Record<string, unknown>, now: Date): Listing | null {
  const slug = str(it.slug);
  if (!slug) return null;
  const url = `${ORIGIN}/pt/anuncio/${slug}`;
  const l = emptyListing(SOURCE, idFromUrl(slug) ?? str(it.id) ?? slug, url);
  l.title = str(it.title) ?? '';
  l.description = str(it.shortDescription);

  const price = isObj(it.totalPrice) ? num(it.totalPrice.value) : isObj(it.rentPrice) ? num(it.rentPrice.value) : null;
  l.price = it.hidePrice === true ? null : price;
  l.typology = parseTypology(l.title) ?? ROOMS[String(it.roomsNumber)] ?? null;
  l.areaM2 = num(it.areaInSquareMeters);
  l.floor = known(str(it.floorNumber));

  const loc = isObj(it.location) ? it.location : {};
  const address = isObj(loc.address) ? loc.address : {};
  const city = isObj(address.city) ? str(address.city.name) : null;
  const rg = isObj(loc.reverseGeocoding) && Array.isArray(loc.reverseGeocoding.locations) ? loc.reverseGeocoding.locations : [];
  const fullNames = rg.map((x) => (isObj(x) ? str(x.fullName) : null)).filter((x): x is string => !!x);
  // The most specific entry has the most comma-separated parts.
  const full = fullNames.sort((a, b) => b.split(',').length - a.split(',').length)[0] ?? null;
  const street = isObj(address.street) ? str(address.street.name) : null;
  l.locationText = [street, full].filter(Boolean).join(', ') || null;
  const split = splitLocation(full);
  l.municipality = city ?? split.municipality;
  l.parish = split.parish;

  l.images = (Array.isArray(it.images) ? it.images : [])
    .map((im) => (isObj(im) ? (str(im.large) ?? str(im.medium)) : str(im)))
    .filter((x): x is string => !!x);
  if (typeof it.isPrivateOwner === 'boolean') l.advertiser = it.isPrivateOwner ? 'private' : 'agency';
  l.publishedAt = str(it.dateCreatedFirst) ?? str(it.dateCreated);
  return applyText(l, '', now);
}

function searchFromHtml(html: string, now: Date): Listing[] {
  const $ = cheerio.load(html);
  const seen = new Map<string, Listing>();
  $('a[href*="/pt/anuncio/"]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const url = new URL(href, ORIGIN);
    url.search = '';
    url.hash = '';
    const id = idFromUrl(url.pathname);
    if (!id || seen.has(id)) return;
    const card = $(a).closest('article, li, section');
    const scope = card.length ? card : $(a).parent();
    const text = spacedText($, scope);
    const l = emptyListing(SOURCE, id, url.toString());
    l.title = ($(a).text().trim() || scope.find('h2, h3, [data-cy="listing-item-title"]').first().text().trim()).replace(/\s+/g, ' ');
    l.price = findEuroAmount(text);
    l.typology = parseTypology(l.title) ?? parseTypology(text);
    l.areaM2 = parseArea(text);
    const locText = scope
      .find('p, span')
      .map((_i, el) => $(el).text().trim())
      .get()
      .filter((t) => t.split(',').length >= 3 && t.length < 160)
      .sort((x, y) => x.length - y.length)[0];
    if (locText) {
      l.locationText = locText;
      Object.assign(l, splitLocation(locText));
    }
    l.images = scope
      .find('img[src^="http"]')
      .map((_i, el) => $(el).attr('src'))
      .get()
      .slice(0, 6);
    if (/oferta privada/i.test(text)) l.advertiser = 'private';
    seen.set(id, applyText(l, '', now));
  });
  return [...seen.values()];
}

export function parseSearch(html: string, now: Date): SearchPage {
  const data = nextData(html);
  if (data) {
    const items = deepFind(data, isSearchItems);
    if (items) {
      const pagination = deepFind(data, (n): n is Record<string, unknown> => isObj(n) && typeof n.totalPages === 'number');
      const listings = items.map((it) => fromSearchItem(it, now)).filter((l): l is Listing => l !== null);
      return { listings, mode: 'structured', totalPages: pagination ? num(pagination.totalPages) : null };
    }
  }
  return { listings: searchFromHtml(html, now), mode: 'html', totalPages: null };
}

const DETAIL_LABELS = [
  'area', 'tipologia', 'andar', 'elevador', 'certificado energetico', 'disponivel a partir de', 'tipo de anunciante',
  'equipamento', 'informacoes adicionais', 'mobilado', 'mobiliario', 'caucao', 'aquecimento', 'espaco exterior',
  'estacionamento', 'seguranca', 'media', 'despesas adicionais', 'fase de acabamento', 'tipo de imovel',
];

/** Collects "label -> value" pairs from structured data and, failing that, from the markup. */
function collectFacts(html: string, ad: Record<string, unknown> | null): Map<string, string> {
  const facts = new Map<string, string>();
  const put = (label: string | null, value: string | null) => {
    const k = norm(label).replace(/:$/, '').trim();
    const v = known(value);
    if (k && v && !facts.has(k)) facts.set(k, v);
  };
  if (ad) {
    for (const c of Array.isArray(ad.characteristics) ? ad.characteristics : []) {
      if (isObj(c)) put(str(c.label), str(c.localizedValue) ?? str(c.value));
    }
    const lists: string[] = [];
    if (Array.isArray(ad.features)) lists.push(...ad.features.map((f) => str(f) ?? '').filter(Boolean));
    for (const cat of Array.isArray(ad.featuresByCategory) ? ad.featuresByCategory : []) {
      if (isObj(cat) && Array.isArray(cat.values)) lists.push(...cat.values.map((f) => str(f) ?? '').filter(Boolean));
    }
    if (lists.length) put('equipamento', lists.join(', '));
  }
  // Markup fallback: an element whose whole text is a known label, followed by its value.
  const $ = cheerio.load(html);
  $('p, span, div, dt, th, li').each((_, el) => {
    const node = $(el);
    if (node.children().length > 0) return;
    const label = norm(node.text()).replace(/:$/, '').trim();
    if (!DETAIL_LABELS.includes(label) || facts.has(label)) return;
    const value = node.next().text().trim() || node.parent().next().text().trim();
    if (value && value.length < 300) put(label, value);
  });
  return facts;
}

function isAd(node: unknown): node is Record<string, unknown> {
  return isObj(node) && typeof node.title === 'string' && ('characteristics' in node || ('description' in node && 'images' in node));
}

/** Reads a listing page. Returns 'gone' when the page says the ad is no longer available. */
export function parseDetail(html: string, base: Listing, now: Date): Listing | 'gone' {
  const data = nextData(html);
  const ad = data ? deepFind(data, isAd) : null;
  const $ = cheerio.load(html);
  const pageText = spacedText($, $('body'));
  if (!ad && looksGone(pageText)) return 'gone';

  let l: Listing = { ...base, detailsFetched: true };
  const facts = collectFacts(html, ad);

  if (ad) {
    l.title = str(ad.title) ?? l.title;
    const desc = str(ad.description);
    if (desc) l.description = cheerio.load(desc).text().replace(/\s+/g, ' ').trim();
    const coords = deepFind(ad, (n): n is Record<string, unknown> => isObj(n) && typeof n.latitude === 'number' && typeof n.longitude === 'number');
    if (coords) {
      l.lat = coords.latitude as number;
      l.lon = coords.longitude as number;
      l.coordsApprox = false;
    }
    const imgs = (Array.isArray(ad.images) ? ad.images : [])
      .map((im) => (isObj(im) ? (str(im.large) ?? str(im.medium) ?? str(im.url)) : str(im)))
      .filter((x): x is string => !!x);
    if (imgs.length) l.images = imgs;
    l.publishedAt = l.publishedAt ?? str(ad.createdAt);
    // Keeps the price current when a tracked listing is re-read.
    const target = isObj(ad.target) ? ad.target : {};
    const price = num(target.Price) ?? parsePrice(facts.get('preco') ?? facts.get('renda'));
    if (price !== null) l.price = price;
  } else {
    l.title = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content')?.trim() || l.title;
    l.description = l.description ?? $('meta[name="description"]').attr('content')?.trim() ?? null;
    const price = findEuroAmount(pageText);
    if (price !== null && l.price === null) l.price = price;
  }

  l.areaM2 = parseArea(facts.get('area')) ?? num(facts.get('area')) ?? l.areaM2;
  l.typology = parseTypology(facts.get('tipologia')) ?? l.typology ?? parseTypology(l.title);
  l.floor = facts.get('andar') ?? l.floor;
  l.energyRating = facts.get('certificado energetico') ?? l.energyRating;
  l.elevator = yesNo(facts.get('elevador')) ?? l.elevator;
  l.availableFrom = parseDateValue(facts.get('disponivel a partir de'), now) ?? l.availableFrom;
  const adv = norm(facts.get('tipo de anunciante'));
  if (adv) l.advertiser = /particular|privad/.test(adv) ? 'private' : 'agency';
  const furnished = yesNo(facts.get('mobilado') ?? facts.get('mobiliario'));
  if (furnished !== null) l.furnished = furnished ? 'yes' : 'no';

  // Free-text facts go through the same extractor as the description.
  const textFacts = new Map([...facts].filter(([k]) => ['equipamento', 'informacoes adicionais', 'espaco exterior', 'estacionamento', 'seguranca'].includes(k)));
  l = applyText(l, factsToText(textFacts), now);
  return l;
}
