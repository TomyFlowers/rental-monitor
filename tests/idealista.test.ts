import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { noEnricher } from '../src/enrich/commute.js';
import { silentLogger } from '../src/logger.js';
import { Monitor } from '../src/pipeline/monitor.js';
import { IdealistaAdapter, identify } from '../src/sources/idealista/index.js';
import { Store } from '../src/store/db.js';
import { evaluate } from '../src/core/evaluator.js';
import { emptyListing } from '../src/core/types.js';
import { shippedConfig } from './helpers.js';

/** Text as it might be copied from an Idealista listing page. */
const COPIED = `Apartamento T2 na Rua Conceição Fernandes
Mafamude e Vilar do Paraíso, Vila Nova de Gaia
950 €/mês
75 m² área bruta · 2 quartos · 2.º andar com elevador
Características: Varanda, Lugar de garagem incluído no preço, Mobilado
Disponível a partir de 1 de janeiro de 2027`;

let cfg: Config;
let store: Store;
let monitor: Monitor;
const NOW = new Date('2026-11-18T10:00:00Z');

beforeEach(() => {
  cfg = shippedConfig();
  store = new Store(':memory:');
  monitor = new Monitor(cfg, store, [new IdealistaAdapter()], noEnricher, silentLogger, () => NOW);
});

describe('idealista links', () => {
  it('recognises listing links and nothing else', () => {
    expect(identify('https://www.idealista.pt/imovel/34567890/?xtmc=1_2')).toEqual({ source: 'idealista', sourceId: '34567890', url: 'https://www.idealista.pt/imovel/34567890/' });
    expect(identify('https://m.idealista.pt/imovel/34567890/')).toMatchObject({ sourceId: '34567890' });
    expect(identify('https://www.idealista.pt/arrendar-casas/porto/')).toBeNull();
    expect(identify('https://example.test/imovel/1/')).toBeNull();
  });

  it('never contacts Idealista', async () => {
    const adapter = new IdealistaAdapter();
    await expect(adapter.search()).rejects.toThrow(/cannot be searched/);
    const stub = adapter.stub(new URL('https://www.idealista.pt/imovel/1/'))!;
    expect(await adapter.details(stub)).toEqual({ kind: 'ok', listing: { ...stub, detailsFetched: true } });
  });
});

describe('adding by hand', () => {
  it('reads the details from text copied from the listing', async () => {
    const { row, updated } = await monitor.addByUrl('https://www.idealista.pt/imovel/34567890/', COPIED);
    expect(updated).toBe(false);
    expect(row.listing).toMatchObject({
      source: 'idealista', sourceId: '34567890', url: 'https://www.idealista.pt/imovel/34567890/',
      title: 'Apartamento T2 na Rua Conceição Fernandes', price: 950, typology: 2, areaM2: 75,
      municipality: 'Vila Nova de Gaia', parish: 'Mafamude e Vilar do Paraíso',
      furnished: 'yes', garage: true, outdoor: true, elevator: true, availableFrom: '2027-01-01',
    });
    expect(row.evaluation.verdict).toBe('match');
    expect(row.evaluation.flags).not.toContain('Rent unknown');
  });

  it('reads the bedroom count when no T-number is given', async () => {
    const { row } = await monitor.addByUrl('https://www.idealista.pt/imovel/1/', 'Apartamento na Boavista, Porto\n3 quartos, 1 casa de banho, 1.200 €');
    expect(row.listing).toMatchObject({ typology: 3, price: 1200, municipality: 'Porto', parish: 'Boavista', sharedRoom: null });
  });

  it('adds to a listing when the same link is sent again, keeping the title and what was known', async () => {
    await monitor.addByUrl('https://www.idealista.pt/imovel/555/?utm=share', 'Apartamento T1 no Bonfim, Porto');
    const { row, updated } = await monitor.addByUrl('https://www.idealista.pt/imovel/555/', 'renda 850€, mobilado, com garagem');
    expect(updated).toBe(true);
    expect(store.bySource('idealista')).toHaveLength(1);
    expect(row.listing).toMatchObject({ title: 'Apartamento T1 no Bonfim, Porto', typology: 1, price: 850, municipality: 'Porto', furnished: 'yes', garage: true });
  });

  it('a bare link still works and leaves everything unknown', async () => {
    const { row } = await monitor.addByUrl('https://www.idealista.pt/imovel/777/', '');
    expect(row.listing).toMatchObject({ title: 'Listing on idealista.pt', price: null, typology: null });
    expect(row.evaluation.flags).toEqual(expect.arrayContaining(['Rent unknown', 'Typology unknown']));
  });

  it('keeps a photo sent with the link', async () => {
    const { row } = await monitor.addByUrl('https://www.idealista.pt/imovel/888/', 'T2 900€ Gaia', ['telegram-file-id']);
    expect(row.listing.images).toEqual(['telegram-file-id']);
  });

  it('merges with the same listing arriving from an alert email', async () => {
    const fromEmail = { ...emptyListing('idealista', '34567890', 'https://www.idealista.pt/imovel/34567890/'), title: 'Apartamento T2', price: 980, detailsFetched: true };
    await monitor.process(fromEmail);
    await monitor.addByUrl('https://www.idealista.pt/imovel/34567890/', COPIED);
    expect(store.bySource('idealista')).toHaveLength(1);
    expect(store.find('idealista', '34567890')!.listing).toMatchObject({ price: 950, garage: true });
  });
});

describe('links added by earlier versions', () => {
  it('are filed under their site on startup, unless that would create a duplicate', () => {
    const add = (sourceId: string, url: string) => {
      const l = { ...emptyListing('manual', sourceId, url), title: 'x' };
      return store.insert(l, evaluate(l, cfg), NOW.toISOString());
    };
    const a = add('aaa', 'https://www.idealista.pt/imovel/111/?xtmc=1');
    add('bbb', 'https://www.facebook.com/groups/1/posts/2'); // no site to file it under
    const c = add('ccc', 'https://www.idealista.pt/imovel/222/');
    const l = { ...emptyListing('idealista', '222', 'https://www.idealista.pt/imovel/222/'), title: 'y' };
    store.insert(l, evaluate(l, cfg), NOW.toISOString());

    expect(monitor.adoptManualListings()).toBe(1);
    expect(store.byId(a)!.listing).toMatchObject({ source: 'idealista', sourceId: '111', url: 'https://www.idealista.pt/imovel/111/' });
    expect(store.find('idealista', '111')!.id).toBe(a);
    expect(store.byId(c)!.listing.source).toBe('manual'); // already exists under idealista: left alone
    expect(store.bySource('manual')).toHaveLength(2);
    expect(monitor.adoptManualListings()).toBe(0); // running again changes nothing
  });
});
