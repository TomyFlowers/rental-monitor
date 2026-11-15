import * as cheerio from 'cheerio';
import { emptyListing, type Listing } from '../../core/types.js';
import { findEuroAmount, parseArea, parsePrice, parseTypology } from '../../core/text.js';
import { applyText, cardsByListing, looksGone, spacedText, type ListingRef, type SearchPage } from '../types.js';

export const SOURCE = 'casasapo';
const ORIGIN = 'https://casa.sapo.pt';
const UUID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.html$/i;

/**
 * Listing links end in a UUID. Many cards link through a click counter
 * (gespub.casa.sapo.pt/...counter.aspx?...&l=<real url>); the real URL is
 * taken from the `l` parameter so the counter is never called.
 */
export function identify(href: string): ListingRef | null {
  let u: URL;
  try {
    u = new URL(href, ORIGIN);
    const inner = u.searchParams.get('l');
    if (inner && /^https?:\/\//.test(inner)) u = new URL(inner);
  } catch {
    return null;
  }
  if (u.hostname !== 'casa.sapo.pt') return null;
  const id = UUID.exec(u.pathname)?.[1];
  return id ? { source: SOURCE, sourceId: id.toLowerCase(), url: `${ORIGIN}${u.pathname}` } : null;
}

/**
 * Card line: "Apartamento T2 Aldoar, Foz do Douro e Nevogilde, Porto, Distrito do Porto Usado · 90m² ..."
 * The municipality is the last name before "Distrito"; what precedes it is the parish.
 */
export function parseLocation(text: string): { municipality: string | null; parish: string | null; locationText: string | null } {
  const end = text.search(/,\s*Distrito d[eoa]s?\s/i);
  if (end < 0) return { municipality: null, parish: null, locationText: null };
  const head = text.slice(0, end);
  let start = 0;
  for (const m of head.matchAll(/\bT\d(?:\+\d)?(?:\s+(?:Duplex|Triplex))?\s+/g)) start = m.index + m[0].length;
  if (start === 0) return { municipality: null, parish: null, locationText: null };
  const parts = head.slice(start).split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || head.length - start > 200) return { municipality: null, parish: null, locationText: null };
  return { municipality: parts[parts.length - 1]!, parish: parts.slice(0, -1).join(', ') || null, locationText: parts.join(', ') };
}

export function parseSearch(html: string, now: Date): SearchPage {
  const $ = cheerio.load(html);
  const listings: Listing[] = [];
  for (const { ref, card, anchors } of cardsByListing($, identify)) {
    const text = spacedText($, card);
    const l = emptyListing(ref.source, ref.sourceId, ref.url);
    const titles = anchors.map((_i, a) => $(a).text().replace(/\s+/g, ' ').trim()).get().filter((t) => /[a-zà-ú]{3}/i.test(t));
    const attr = (anchors.filter('[title]').first().attr('title') ?? '').replace(/^Ver\s+/i, '').trim();
    l.title = titles.sort((a, b) => b.length - a.length)[0] ?? attr;
    l.price = parsePrice(/\balugar\s+(\d[\d.\s]*)\s*€/i.exec(text)?.[1]) ?? findEuroAmount(text);
    l.typology = parseTypology(text) ?? parseTypology(ref.url.replace(/-/g, ' '));
    l.areaM2 = parseArea(text);
    Object.assign(l, parseLocation(text));
    l.images = [...new Set(card.find('img').map((_i, im) => $(im).attr('src') ?? $(im).attr('data-src') ?? $(im).attr('data-original')).get().filter((s) => /^https?:\/\/media\./.test(s)))].slice(0, 6);
    // The card carries a description excerpt; the yes/no facts are read from it.
    l.description = text.slice(0, 1500);
    l.detailsFetched = true;
    listings.push(applyText(l, '', now));
  }
  const pages = $('a[href*="pn="]').map((_i, a) => Number(/[?&]pn=(\d+)/.exec($(a).attr('href') ?? '')?.[1] ?? 0)).get();
  // Reading the markup is this site's normal path, not a fallback, so it is not reported as degraded.
  return { listings, mode: 'structured', totalPages: pages.length ? Math.max(...pages) : null };
}

/** The listing's own page: used by /add and to confirm a listing is still online. */
export function parseDetail(html: string, base: Listing, now: Date): Listing | 'gone' {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim() || $('meta[property="og:title"]').attr('content')?.trim() || '';
  if (!title && looksGone(spacedText($, $('body')))) return 'gone';
  const meta = ($('meta[property="og:description"]').attr('content') ?? $('meta[name="description"]').attr('content') ?? '').trim();
  const l: Listing = { ...base, detailsFetched: true };
  l.title = l.title || title;
  if (!l.description && meta) l.description = meta;
  const blurb = `${title} . ${meta}`;
  l.price = l.price ?? findEuroAmount(blurb);
  l.typology = l.typology ?? parseTypology(blurb) ?? parseTypology(base.url.replace(/-/g, ' '));
  l.areaM2 = l.areaM2 ?? parseArea(blurb);
  if (l.images.length === 0) {
    const img = $('meta[property="og:image"]').attr('content');
    if (img) l.images = [img];
  }
  return applyText(l, blurb, now);
}
