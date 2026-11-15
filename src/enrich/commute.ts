import type { Config } from '../config.js';
import { norm } from '../core/text.js';
import type { Listing } from '../core/types.js';
import type { HttpClient } from '../http/client.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/db.js';

/** Nominatim's usage policy asks for a UA that identifies the application. */
const GEO_HEADERS = { 'user-agent': 'rental-monitor/0.1 (personal, low-volume)', accept: 'application/json' };

export interface Enricher {
  /** Returns the listing with coordinates and commute time filled in where possible. */
  enrich(l: Listing): Promise<Listing>;
}

export const noEnricher: Enricher = { enrich: async (l) => l };

/**
 * Adds driving time to the configured destination. Coordinates come from the
 * listing when it has them, otherwise from geocoding its parish/municipality
 * (flagged as approximate). Every lookup is cached in SQLite, so each area is
 * geocoded once and each origin is routed once.
 */
export class CommuteEnricher implements Enricher {
  constructor(
    private cfg: Config['commute'],
    private http: HttpClient,
    private store: Store,
    private log: Logger,
  ) {}

  async enrich(l: Listing): Promise<Listing> {
    if (!this.cfg.enabled || l.commuteMinutes !== null) return l;
    try {
      let out = l;
      if (out.lat === null || out.lon === null) {
        const coords = await this.geocode(out);
        if (!coords) return out;
        out = { ...out, lat: coords.lat, lon: coords.lon, coordsApprox: true };
      }
      const minutes = await this.route(out.lat!, out.lon!);
      return minutes === null ? out : { ...out, commuteMinutes: minutes };
    } catch (err) {
      // An unreachable routing service must never stop a listing from being processed.
      this.log.warn({ err: String(err), listing: l.url }, 'commute lookup failed; value stays unknown');
      return l;
    }
  }

  private async geocode(l: Listing): Promise<{ lat: number; lon: number } | null> {
    const parts = [l.parish, l.municipality].filter(Boolean);
    if (parts.length === 0) return null;
    const query = `${parts.join(', ')}, Portugal`;
    const key = norm(query);
    const cached = this.store.geoGet(key);
    if (cached !== undefined) return cached;
    const url = `${this.cfg.nominatimUrl.replace(/\/$/, '')}/search?format=jsonv2&limit=1&countrycodes=pt&q=${encodeURIComponent(query)}`;
    const res = await this.http.get(url, { headers: GEO_HEADERS });
    const hit = (JSON.parse(res.body) as Array<{ lat?: string; lon?: string }>)[0];
    const coords = hit?.lat && hit.lon ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
    this.store.geoSet(key, coords, new Date().toISOString());
    return coords;
  }

  private async route(lat: number, lon: number): Promise<number | null> {
    const d = this.cfg.destination;
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}>${d.lat.toFixed(4)},${d.lon.toFixed(4)}x${this.cfg.trafficFactor}`;
    const cached = this.store.commuteGet(key);
    if (cached !== undefined) return cached;
    const url = `${this.cfg.osrmUrl.replace(/\/$/, '')}/route/v1/driving/${lon},${lat};${d.lon},${d.lat}?overview=false`;
    const res = await this.http.get(url, { headers: GEO_HEADERS });
    const seconds = (JSON.parse(res.body) as { routes?: Array<{ duration?: number }> }).routes?.[0]?.duration;
    if (typeof seconds !== 'number') return null;
    const minutes = Math.round(((seconds * this.cfg.trafficFactor) / 60) * 10) / 10;
    this.store.commuteSet(key, minutes, new Date().toISOString());
    return minutes;
  }
}
