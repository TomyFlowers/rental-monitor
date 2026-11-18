import { emptyListing, type Listing } from '../../core/types.js';
import type { DetailResult, ListingRef, SearchPage, SourceAdapter } from '../types.js';

export const SOURCE = 'idealista';

/** "https://www.idealista.pt/imovel/34567890/?xtmc=1" -> listing 34567890. */
export function identify(href: string): ListingRef | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!/(^|\.)idealista\.(pt|com)$/.test(u.hostname)) return null;
  const id = /\/(?:imovel|inmueble|immobile)\/(\d+)/.exec(u.pathname)?.[1];
  return id ? { source: SOURCE, sourceId: id, url: `https://www.idealista.pt/imovel/${id}/` } : null;
}

/**
 * Idealista refuses automated requests, so this adapter never contacts it.
 * It recognises Idealista links, so a listing is filed under its Idealista
 * number (shared with the alert emails, and re-sending the same link updates
 * it), and the details come from the text sent with the link.
 */
export class IdealistaAdapter implements SourceAdapter {
  readonly name = SOURCE;

  matches(url: URL): boolean {
    return /(^|\.)idealista\.(pt|com)$/.test(url.hostname);
  }

  stub(url: URL): Listing | null {
    const ref = identify(url.toString());
    return ref ? emptyListing(SOURCE, ref.sourceId, ref.url) : null;
  }

  async search(): Promise<SearchPage> {
    throw new Error('Idealista cannot be searched automatically: remove it from `sources:` and use alert emails or pasted links');
  }

  async details(listing: Listing): Promise<DetailResult> {
    return { kind: 'ok', listing: { ...listing, detailsFetched: true } };
  }
}
