import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { parseConfig, type Config } from '../src/config.js';
import { emptyListing, type Listing } from '../src/core/types.js';

/** The config that ships with the project, so tests exercise the real defaults. */
export function shippedConfig(): Config {
  return parseConfig(parse(readFileSync(new URL('../config/config.yaml', import.meta.url), 'utf8')));
}

/** A T2 in Gaia at €900 with everything else unknown. */
export function listing(over: Partial<Listing> = {}): Listing {
  return {
    ...emptyListing('fake', over.sourceId ?? 'a1', `https://example.test/${over.sourceId ?? 'a1'}`),
    title: 'Apartamento T2',
    price: 900,
    typology: 2,
    municipality: 'Vila Nova de Gaia',
    parish: 'Mafamude',
    detailsFetched: true,
    ...over,
  };
}
