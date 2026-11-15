import { emptyListing, type Listing } from '../../core/types.js';
import { HttpError, type HttpClient } from '../../http/client.js';
import type { DetailResult, SearchPage, SourceAdapter } from '../types.js';
import { idFromUrl, parseDetail, parseSearch, SOURCE } from './parse.js';

export class ImovirtualAdapter implements SourceAdapter {
  readonly name = SOURCE;

  constructor(private http: HttpClient) {}

  matches(url: URL): boolean {
    return /(^|\.)imovirtual\.com$/.test(url.hostname);
  }

  stub(url: URL): Listing | null {
    const id = idFromUrl(url.pathname);
    if (!id) return null;
    return emptyListing(SOURCE, id, `${url.origin}${url.pathname}`);
  }

  async search(searchUrl: string, page: number, now: Date): Promise<SearchPage> {
    const url = new URL(searchUrl);
    if (page > 1) url.searchParams.set('page', String(page));
    const res = await this.http.get(url.toString());
    return parseSearch(res.body, now);
  }

  async details(listing: Listing, now: Date): Promise<DetailResult> {
    let res;
    try {
      res = await this.http.get(listing.url);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return { kind: 'gone' };
      throw err;
    }
    // An expired ad redirects to a results page instead of returning 404.
    if (!idFromUrl(new URL(res.finalUrl).pathname)) return { kind: 'gone' };
    const parsed = parseDetail(res.body, listing, now);
    return parsed === 'gone' ? { kind: 'gone' } : { kind: 'ok', listing: parsed };
  }
}
