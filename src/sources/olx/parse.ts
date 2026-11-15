import * as cheerio from 'cheerio';
import { emptyListing, type Listing } from '../../core/types.js';
import { norm, parseArea, parsePrice, parseTypology } from '../../core/text.js';
import { idFromUrl as imovirtualId, SOURCE as IMOVIRTUAL } from '../imovirtual/parse.js';
import { applyText, deepFind, factsToText, isObj, known, looksGone, num, spacedText, str, yesNo, type SearchPage } from '../types.js';

export const SOURCE = 'olx';
const ORIGIN = 'https://www.olx.pt';

/** OLX embeds its page data as a JSON string assigned to window.__PRERENDERED_STATE__. */
function prerenderedState(html: string): unknown {
  const m = /__PRERENDERED_STATE__\s*=\s*("(?:[^"\\]|\\.)*")/.exec(html);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(JSON.parse(m[1]) as string);
  } catch {
    return null;
  }
}

function cleanUrl(href: string): URL {
  const u = new URL(href, ORIGIN);
  u.search = '';
  u.hash = '';
  return u;
}

/**
 * OLX re-publishes many Imovirtual ads and links straight to them. Those are
 * filed under the Imovirtual id so the same flat is never stored twice.
 */
export function identify(href: string, olxId: string | null): { source: string; sourceId: string; url: string } | null {
  const u = cleanUrl(href);
  if (/(^|\.)imovirtual\.com$/.test(u.hostname)) {
    const id = imovirtualId(u.pathname);
    return id ? { source: IMOVIRTUAL, sourceId: id, url: u.toString() } : null;
  }
  const id = olxId ?? /-ID([0-9A-Za-z]+)\.html$/.exec(u.pathname)?.[1] ?? null;
  return id ? { source: SOURCE, sourceId: id, url: u.toString() } : null;
}

function isAds(node: unknown): node is Record<string, unknown>[] {
  return (
    Array.isArray(node) &&
    node.length > 0 &&
    node.every((it) => isObj(it) && typeof it.title === 'string' && typeof it.url === 'string' && ('params' in it || 'price' in it || 'location' in it))
  );
}

const labelOf = (v: unknown): string | null => (isObj(v) ? (str(v.label) ?? str(v.value) ?? str(v.key)) : str(v));

/** Accepts both shapes OLX uses: the embedded page state (camelCase) and its JSON API (snake_case). */
export function fromAd(ad: Record<string, unknown>, now: Date): Listing | null {
  const href = str(ad.url);
  if (!href) return null;
  const ident = identify(href, str(ad.id));
  if (!ident) return null;
  let l = emptyListing(ident.source, ident.sourceId, ident.url);
  l.title = str(ad.title) ?? '';
  const desc = str(ad.description);
  if (desc) l.description = cheerio.load(desc).text().replace(/\s+/g, ' ').trim();

  const facts = new Map<string, string>();
  let paramPrice: number | null = null;
  for (const p of Array.isArray(ad.params) ? ad.params : []) {
    if (!isObj(p)) continue;
    const key = norm(str(p.key));
    if (key === 'price') {
      paramPrice = isObj(p.value) ? (num(p.value.value) ?? parsePrice(str(p.value.label))) : parsePrice(str(p.value));
      continue;
    }
    const label = norm(str(p.name) ?? key);
    const value = known(str(p.normalizedValue) && !isObj(p.value) ? str(p.value) : labelOf(p.value));
    if (label && value) facts.set(label, value);
  }

  const price = isObj(ad.price) ? ad.price : {};
  const regular = isObj(price.regularPrice) ? price.regularPrice : {};
  l.price = num(regular.value) ?? num(price.value) ?? paramPrice ?? parsePrice(str(price.displayValue));

  const fact = (re: RegExp) => [...facts].find(([k]) => re.test(k))?.[1] ?? null;
  l.typology = parseTypology(fact(/tipologia/)) ?? parseTypology(l.title);
  const area = fact(/area util/) ?? fact(/area/);
  l.areaM2 = parseArea(area) ?? num(area);
  l.energyRating = fact(/certificado energetico|classe energetica/);
  l.floor = fact(/^andar/);
  const furnished = yesNo(fact(/mobilad/));
  if (furnished !== null) l.furnished = furnished ? 'yes' : 'no';

  const loc = isObj(ad.location) ? ad.location : {};
  const name = (flat: unknown, nested: unknown) => str(flat) ?? (isObj(nested) ? str(nested.name) : null);
  l.municipality = name(loc.cityName, loc.city);
  l.parish = name(loc.districtName, loc.district);
  l.locationText = [l.parish, l.municipality, name(loc.regionName, loc.region)].filter(Boolean).join(', ') || null;
  const map = isObj(ad.map) ? ad.map : {};
  if (num(map.lat) !== null && num(map.lon) !== null) {
    l.lat = num(map.lat);
    l.lon = num(map.lon);
    l.coordsApprox = true; // OLX shows an area on the map, not the exact address
  }

  l.images = (Array.isArray(ad.photos) ? ad.photos : [])
    .map((ph) => (isObj(ph) ? (str(ph.link) ?? str(ph.url)) : str(ph)))
    .filter((x): x is string => !!x)
    .map((u) => u.replace('{width}', '1024').replace('{height}', '768'));
  const business = typeof ad.isBusiness === 'boolean' ? ad.isBusiness : typeof ad.business === 'boolean' ? ad.business : null;
  if (business !== null) l.advertiser = business ? 'agency' : 'private';
  l.publishedAt = str(ad.createdTime) ?? str(ad.created_time);

  l = applyText(l, factsToText(facts), now);
  // The embedded data already carries the full description for OLX-hosted ads.
  // Imovirtual cross-posts still need their own page read.
  l.detailsFetched = l.source === SOURCE && !!l.description;
  return l;
}

function searchFromHtml(html: string, now: Date): Listing[] {
  const $ = cheerio.load(html);
  const out = new Map<string, Listing>();
  $('[data-cy="l-card"]').each((_, el) => {
    const card = $(el);
    const href = card.find('a[href]').first().attr('href');
    if (!href) return;
    const ident = identify(href, card.attr('id') ?? null);
    if (!ident) return;
    const key = `${ident.source}:${ident.sourceId}`;
    if (out.has(key)) return;
    const l = emptyListing(ident.source, ident.sourceId, ident.url);
    l.title = card.find('h4, h6').first().text().trim();
    l.price = parsePrice(card.find('[data-testid="ad-price"]').first().text());
    const text = spacedText($, card);
    l.typology = parseTypology(l.title);
    l.areaM2 = parseArea(text);
    // "Porto, Paranhos - Hoje às 10:21"
    const where = card.find('[data-testid="location-date"]').first().text().split(' - ')[0]?.trim();
    if (where) {
      const [city, district] = where.split(',').map((s) => s.trim());
      l.municipality = city || null;
      l.parish = district || null;
      l.locationText = where;
    }
    const img = card.find('img[src^="http"]').first().attr('src');
    if (img) l.images = [img];
    out.set(key, applyText(l, '', now));
  });
  return [...out.values()];
}

export function parseSearch(html: string, now: Date): SearchPage {
  const state = prerenderedState(html);
  if (state) {
    const ads = deepFind(state, isAds);
    if (ads) {
      const totalPages = deepFind(state, (n): n is Record<string, unknown> => isObj(n) && typeof n.totalPages === 'number');
      const seen = new Map<string, Listing>();
      for (const ad of ads) {
        const l = fromAd(ad, now);
        if (l && !seen.has(`${l.source}:${l.sourceId}`)) seen.set(`${l.source}:${l.sourceId}`, l);
      }
      return { listings: [...seen.values()], mode: 'structured', totalPages: totalPages ? num(totalPages.totalPages) : null };
    }
  }
  return { listings: searchFromHtml(html, now), mode: 'html', totalPages: null };
}

function isSingleAd(node: unknown): node is Record<string, unknown> {
  return isObj(node) && typeof node.title === 'string' && typeof node.url === 'string' && 'description' in node && ('params' in node || 'photos' in node);
}

export function parseDetail(html: string, base: Listing, now: Date): Listing | 'gone' {
  const state = prerenderedState(html);
  const ad = state ? deepFind(state, isSingleAd) : null;
  if (ad) {
    const fresh = fromAd({ ...ad, url: base.url, id: base.sourceId }, now);
    if (fresh) return { ...fresh, detailsFetched: true };
  }
  const $ = cheerio.load(html);
  const pageText = spacedText($, $('body'));
  if (looksGone(pageText)) return 'gone';
  const l: Listing = { ...base, detailsFetched: true };
  l.title = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content')?.trim() || l.title;
  const desc = $('[data-cy="ad_description"]').text().trim() || $('meta[property="og:description"]').attr('content')?.trim();
  if (desc) l.description = desc.replace(/\s+/g, ' ');
  l.price = parsePrice($('[data-testid="ad-price-container"]').first().text()) ?? l.price;
  l.typology = l.typology ?? parseTypology(l.title);
  return applyText(l, '', now);
}
