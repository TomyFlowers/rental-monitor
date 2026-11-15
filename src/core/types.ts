/** true / false when the listing states it, null when it says nothing. */
export type Tri = boolean | null;
export type Furnished = 'yes' | 'partial' | 'no' | null;

/** A listing normalised to one shape regardless of which site it came from. */
export interface Listing {
  source: string;
  /** Stable id within the source (survives title/price edits). */
  sourceId: string;
  url: string;
  title: string;
  description: string | null;
  price: number | null;
  /** Bedrooms: 0 = T0/studio, 1 = T1, ... */
  typology: number | null;
  areaM2: number | null;
  floor: string | null;
  municipality: string | null;
  parish: string | null;
  locationText: string | null;
  lat: number | null;
  lon: number | null;
  /** true when lat/lon came from geocoding an area name, not the listing itself. */
  coordsApprox: boolean;
  furnished: Furnished;
  garage: Tri;
  outdoor: Tri;
  elevator: Tri;
  energyRating: string | null;
  advertiser: 'private' | 'agency' | null;
  /** ISO date (YYYY-MM-DD) the flat is available from. */
  availableFrom: string | null;
  shortTerm: Tri;
  sharedRoom: Tri;
  /** Formal contract / tax-address registration possible. */
  registration: Tri;
  images: string[];
  publishedAt: string | null;
  commuteMinutes: number | null;
  /** Whether the listing's own page has been read (search results are sparse). */
  detailsFetched: boolean;
}

export function emptyListing(source: string, sourceId: string, url: string): Listing {
  return {
    source,
    sourceId,
    url,
    title: '',
    description: null,
    price: null,
    typology: null,
    areaM2: null,
    floor: null,
    municipality: null,
    parish: null,
    locationText: null,
    lat: null,
    lon: null,
    coordsApprox: false,
    furnished: null,
    garage: null,
    outdoor: null,
    elevator: null,
    energyRating: null,
    advertiser: null,
    availableFrom: null,
    shortTerm: null,
    sharedRoom: null,
    registration: null,
    images: [],
    publishedAt: null,
    commuteMinutes: null,
    detailsFetched: false,
  };
}

export interface ScorePart {
  key: string;
  weight: number;
  /** 0..1, or null when the value was unknown (neutral share applied). */
  fraction: number | null;
  points: number;
}

export interface Evaluation {
  verdict: 'match' | 'rejected';
  /** Why it was rejected (empty for matches). */
  reasons: string[];
  /** Human-readable warnings about unknown values. */
  flags: string[];
  /** 0-100. */
  score: number;
  parts: ScorePart[];
}

export type EventType = 'new' | 'price_drop' | 'price_up' | 'changed' | 'removed' | 'relisted';
export type Delivery = 'instant' | 'digest' | 'none';
