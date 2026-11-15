import * as cheerio from 'cheerio';
import { emptyListing, type Listing } from '../../core/types.js';
import { findEuroAmount, guessMunicipality, parseArea, parseTypology } from '../../core/text.js';
import { identify as casaSapoRef } from '../casasapo/parse.js';
import { idFromUrl as imovirtualId } from '../imovirtual/parse.js';
import { identify as olxRef } from '../olx/parse.js';
import { applyText, cardsByListing, spacedText, type ListingRef } from '../types.js';

/** Recognises a link to a single listing on any site we know, wherever it was found. */
export function identifyListingUrl(href: string): ListingRef | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (/(^|\.)idealista\.(pt|com)$/.test(host)) {
    const id = /\/(?:imovel|inmueble|immobile)\/(\d+)/.exec(u.pathname)?.[1];
    return id ? { source: 'idealista', sourceId: id, url: `https://www.idealista.pt/imovel/${id}/` } : null;
  }
  if (/(^|\.)imovirtual\.com$/.test(host)) {
    const id = imovirtualId(u.pathname);
    return id ? { source: 'imovirtual', sourceId: id, url: `${u.origin}${u.pathname}` } : null;
  }
  if (/(^|\.)olx\.pt$/.test(host)) return /\/anuncio\//.test(u.pathname) ? olxRef(href, null) : null;
  if (host === 'casa.sapo.pt') return casaSapoRef(href);
  return null;
}

/**
 * Alert emails often wrap links in a click tracker that carries the real
 * address as a parameter. Tries the link itself, then any address found
 * inside its parameters. A tracker that hides the address completely cannot
 * be resolved here (it would mean calling the tracker).
 */
export function resolveLink(href: string, depth = 0): ListingRef | null {
  const direct = identifyListingUrl(href);
  if (direct || depth >= 2) return direct;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  for (const value of u.searchParams.values()) {
    if (!/^https?:/i.test(value)) continue;
    const inner = resolveLink(value, depth + 1);
    if (inner) return inner;
  }
  return null;
}

export interface EmailExtract {
  listings: Listing[];
  /** Links in the message, for diagnostics. */
  links: number;
}

/**
 * Reads the listings out of a saved-search alert email. It does not depend on
 * any one site's email layout: every block of the message that links to
 * exactly one listing is treated as that listing's card.
 */
export function extractListings(html: string, municipalities: string[], now: Date): EmailExtract {
  const $ = cheerio.load(html);
  const listings: Listing[] = [];
  for (const { ref, card, anchors } of cardsByListing($, (href) => resolveLink(href))) {
    const text = spacedText($, card);
    const l = emptyListing(ref.source, ref.sourceId, ref.url);
    const titles = anchors.map((_i, a) => $(a).text().replace(/\s+/g, ' ').trim()).get().filter((t) => /[a-zà-ú]{3}/i.test(t) && !/^(ver|abrir|saber|contactar)\b/i.test(t));
    const alt = card.find('img[alt]').map((_i, im) => ($(im).attr('alt') ?? '').trim()).get().find((t) => t.length > 8);
    const slug = decodeURIComponent(new URL(ref.url).pathname.split('/').filter(Boolean).pop() ?? '').replace(/-ID\w+(\.html)?$/, '').replace(/[-_]+/g, ' ');
    l.title = titles.sort((a, b) => b.length - a.length)[0] ?? alt ?? (/[a-z]{3}/i.test(slug) ? slug : '');
    l.price = findEuroAmount(text);
    l.typology = parseTypology(l.title) ?? parseTypology(text);
    l.areaM2 = parseArea(text);
    l.municipality = guessMunicipality(text, municipalities);
    l.locationText = l.municipality;
    l.images = [...new Set(card.find('img[src^="http"]').filter((_i, im) => !/^[01]$/.test($(im).attr('width') ?? '') && !/^[01]$/.test($(im).attr('height') ?? '')).map((_i, im) => $(im).attr('src')).get())]
      .filter((src) => !/logo|icon|pixel|spacer|track/i.test(src))
      .slice(0, 4);
    l.description = text.length > l.title.length + 10 ? text.slice(0, 1500) : null;
    // The email is all we get: these sites refuse direct requests for the listing page.
    l.detailsFetched = true;
    listings.push(applyText(l, '', now));
  }
  return { listings, links: $('a[href]').length };
}
