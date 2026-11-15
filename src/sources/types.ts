import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Furnished, Listing, Tri } from '../core/types.js';
import { extractFeatures, norm } from '../core/text.js';

export interface SearchPage {
  listings: Listing[];
  /** 'structured' = the adapter's normal path worked; 'html' = it fell back to a less detailed reading of the markup. */
  mode: 'structured' | 'html';
  totalPages: number | null;
}

export type DetailResult = { kind: 'ok'; listing: Listing } | { kind: 'gone' };

/** One per website. Everything site-specific lives behind this interface. */
export interface SourceAdapter {
  readonly name: string;
  /** Whether a listing URL belongs to this site (used by /add). */
  matches(url: URL): boolean;
  /** An empty listing for a listing-page URL of this site, or null if the URL is not one. */
  stub(url: URL): Listing | null;
  search(searchUrl: string, page: number, now: Date): Promise<SearchPage>;
  /** Reads the listing's own page and returns the listing with details filled in. */
  details(listing: Listing, now: Date): Promise<DetailResult>;
}

/** Walks any JSON value and returns the first node the predicate accepts. */
export function deepFind<T>(root: unknown, pred: (node: unknown) => node is T, maxDepth = 12): T | null {
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (pred(node)) return node;
    if (depth >= maxDepth || node === null || typeof node !== 'object') continue;
    const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], depth + 1]);
  }
  return null;
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
export const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Sites write "sem informação" for blanks: treat that as unknown. */
export function known(value: string | null | undefined): string | null {
  const n = norm(value);
  return !n || n === 'sem informacao' || n === '-' || n === 'n/a' ? null : (value ?? '').trim();
}

export function yesNo(value: string | null | undefined): Tri {
  const n = norm(value);
  if (/^(sim|yes|true|1)\b/.test(n)) return true;
  if (/^(nao|no|false|0)\b/.test(n)) return false;
  return null;
}

/**
 * Turns labelled facts ("Mobilado: Sim", "Equipamento: varanda, garagem")
 * into plain phrases the text extractor understands.
 */
export function factsToText(facts: Map<string, string>): string {
  const out: string[] = [];
  for (const [label, value] of facts) {
    const yn = yesNo(value);
    if (yn === true) out.push(label);
    else if (yn === false) out.push(`sem ${label}`);
    else out.push(`${label}: ${value}`);
  }
  return out.join(' . ');
}

/**
 * Fills the yes/no facts of a listing from its title, description and any
 * labelled facts. Values the text is silent about keep what was there before.
 */
export function applyText(l: Listing, extraText: string, now: Date): Listing {
  const f = extractFeatures(l.title, `${l.description ?? ''} . ${extraText}`, now);
  const pick = <T>(fresh: T | null, old: T | null): T | null => (fresh !== null ? fresh : old);
  return {
    ...l,
    furnished: pick<Exclude<Furnished, null>>(f.furnished, l.furnished),
    garage: pick(f.garage, l.garage),
    outdoor: pick(f.outdoor, l.outdoor),
    elevator: pick(f.elevator, l.elevator),
    shortTerm: pick(f.shortTerm, l.shortTerm),
    sharedRoom: pick(f.sharedRoom, l.sharedRoom),
    registration: pick(f.registration, l.registration),
    availableFrom: l.availableFrom ?? f.availableFrom,
  };
}

const GONE_TEXT = /anuncio (?:ja )?nao (?:esta|se encontra) (?:mais )?disponivel|anuncio (?:foi )?(?:removido|desativado|desactivado|expirou|expirado|arquivado)|ja nao esta disponivel|pagina nao (?:foi )?encontrada/;

export function looksGone(pageText: string): boolean {
  return GONE_TEXT.test(norm(pageText).slice(0, 20000));
}

/**
 * Text of an element with a space between every text node. Plain .text()
 * glues neighbouring elements together ("T2" + "72 m²" reads as "T272 m²").
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function spacedText($: CheerioAPI, root: Cheerio<any>): string {
  const out: string[] = [];
  root
    .find('*')
    .addBack()
    .contents()
    .each((_, node) => {
      if (node.type !== 'text') return;
      const parent = (node.parent as { name?: string } | null)?.name;
      if (parent === 'script' || parent === 'style' || parent === 'noscript') return;
      const t = $(node).text().trim();
      if (t) out.push(t);
    });
  return out.join(' ');
}

export interface ListingRef {
  source: string;
  sourceId: string;
  url: string;
}

/**
 * Groups a page's links by the listing they point to and finds each listing's
 * "card": the largest element that contains links to that listing and to no
 * other. Works without knowing the site's class names, so it survives
 * restyling, and it is how alert emails (nested tables) are read too.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cardsByListing($: CheerioAPI, identify: (href: string) => ListingRef | null): Array<{ ref: ListingRef; card: Cheerio<any>; anchors: Cheerio<any> }> {
  const keyOf = new Map<unknown, string>();
  const refs = new Map<string, ListingRef>();
  $('a[href]').each((_, a) => {
    const ref = identify($(a).attr('href') ?? '');
    if (!ref) return;
    const key = `${ref.source}:${ref.sourceId}`;
    keyOf.set(a, key);
    if (!refs.has(key)) refs.set(key, ref);
  });
  const out: Array<{ ref: ListingRef; card: Cheerio<any>; anchors: Cheerio<any> }> = [];
  const done = new Set<string>();
  $('a[href]').each((_, a) => {
    const key = keyOf.get(a);
    if (!key || done.has(key)) return;
    done.add(key);
    let card = $(a);
    for (;;) {
      const parent = card.parent();
      if (!parent.length || parent.is('body, html')) break;
      const foreign = parent
        .find('a[href]')
        .toArray()
        .some((el) => keyOf.has(el) && keyOf.get(el) !== key);
      if (foreign) break;
      card = parent;
    }
    const anchors = card.find('a[href]').addBack('a[href]').filter((_i, el) => keyOf.get(el) === key);
    out.push({ ref: refs.get(key)!, card, anchors });
  });
  return out;
}
