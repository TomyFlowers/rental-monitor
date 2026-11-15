import { describe, expect, it } from 'vitest';
import * as imo from '../src/sources/imovirtual/parse.js';
import * as olx from '../src/sources/olx/parse.js';
import { emptyListing } from '../src/core/types.js';

/**
 * These fixtures are built by hand to mirror the shapes the sites embed in
 * their pages (Next.js data on Imovirtual, a prerendered-state string on OLX)
 * and the visible card markup. `pnpm probe <source> --save` captures a real
 * page to compare against.
 */
const NOW = new Date('2026-11-14T12:00:00Z');
const page = (body: string) => `<!doctype html><html><head><title>x</title></head><body>${body}</body></html>`;

const imoItem = (over: Record<string, unknown> = {}) => ({
  id: 19287517,
  title: 'Apartamento T1 Arrendamento em Paranhos, Porto',
  slug: 'apartamento-t1-arrendamento-em-paranhos-porto-ID1iWyZ',
  estate: 'FLAT',
  transaction: 'RENT',
  location: {
    address: { street: null, city: { name: 'Porto' }, province: { name: 'Porto' } },
    reverseGeocoding: { locations: [{ fullName: 'Porto' }, { fullName: 'Porto, Porto' }, { fullName: 'Paranhos, Porto, Porto' }] },
  },
  images: [{ medium: 'https://img.test/1-m.jpg', large: 'https://img.test/1-l.jpg' }, { medium: 'https://img.test/2-m.jpg', large: 'https://img.test/2-l.jpg' }],
  isPrivateOwner: false,
  totalPrice: { value: 830, currency: 'EUR' },
  areaInSquareMeters: 38,
  roomsNumber: 'ONE',
  floorNumber: 'SECOND',
  dateCreated: '2026-11-13 10:00:00',
  shortDescription: 'Excelente apartamento mobilado com varanda.',
  ...over,
});
const imoSearch = (items: unknown[]) =>
  page(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { data: { searchAds: { items, pagination: { totalPages: 33, page: 1 } } } } } })}</script>`);

describe('imovirtual search', () => {
  it('reads listings from the embedded data', () => {
    const res = imo.parseSearch(imoSearch([imoItem(), imoItem({ slug: 'outro-t2-ID9zZ9z', title: 'Moradia renovada', roomsNumber: 'TWO', isPrivateOwner: true, hidePrice: true })]), NOW);
    expect(res.mode).toBe('structured');
    expect(res.totalPages).toBe(33);
    expect(res.listings).toHaveLength(2);
    const a = res.listings[0]!;
    expect(a).toMatchObject({
      source: 'imovirtual', sourceId: 'ID1iWyZ',
      url: 'https://www.imovirtual.com/pt/anuncio/apartamento-t1-arrendamento-em-paranhos-porto-ID1iWyZ',
      price: 830, typology: 1, areaM2: 38, municipality: 'Porto', parish: 'Paranhos',
      advertiser: 'agency', furnished: 'yes', outdoor: true, garage: null, detailsFetched: false,
    });
    expect(a.images).toEqual(['https://img.test/1-l.jpg', 'https://img.test/2-l.jpg']);
    const b = res.listings[1]!;
    expect(b).toMatchObject({ sourceId: 'ID9zZ9z', typology: 2, price: null, advertiser: 'private' });
  });

  it('falls back to the card markup when the embedded data is missing', () => {
    const html = page(`<ul>
      <li><article><a href="/pt/anuncio/apartamento-t2-em-mafamude-ID1j6Oz"><p>Apartamento T2 em Mafamude</p></a>
        <span>950 €</span><p>Rua X, Mafamude, Vila Nova de Gaia, Porto</p><dl><dt>Tipologia</dt><dd>T2</dd><dd>72 m²</dd></dl>
        <img src="https://img.test/a.jpg"><a href="/pt/anuncio/apartamento-t2-em-mafamude-ID1j6Oz">ver</a></article></li>
      <li><article><a href="https://www.imovirtual.com/pt/anuncio/t1-novo-ID1j5tM?x=1">T1 novo a estrear</a><span>1.100 €</span></article></li>
    </ul>`);
    const res = imo.parseSearch(html, NOW);
    expect(res.mode).toBe('html');
    expect(res.listings).toHaveLength(2);
    expect(res.listings[0]).toMatchObject({ sourceId: 'ID1j6Oz', price: 950, typology: 2, areaM2: 72, municipality: 'Vila Nova de Gaia', parish: 'Mafamude' });
    expect(res.listings[1]).toMatchObject({ sourceId: 'ID1j5tM', price: 1100, typology: 1, url: 'https://www.imovirtual.com/pt/anuncio/t1-novo-ID1j5tM' });
  });

  it('returns nothing, without throwing, for an unrelated page', () => {
    expect(imo.parseSearch(page('<h1>Access denied</h1>'), NOW).listings).toEqual([]);
  });
});

describe('imovirtual listing page', () => {
  const base = imo.parseSearch(imoSearch([imoItem({ shortDescription: null })]), NOW).listings[0]!;
  const ad = {
    id: 19287517,
    title: 'Apartamento T1 Arrendamento em Paranhos, Porto',
    description: '<p>Excelente apartamento. <b>Contrato de 1 ano</b>, com recibos.</p>',
    location: { coordinates: { latitude: 41.1712, longitude: -8.6078 } },
    images: [{ large: 'https://img.test/1.jpg' }, { large: 'https://img.test/2.jpg' }, { large: 'https://img.test/3.jpg' }],
    target: { Price: 800 },
    characteristics: [
      { key: 'm', label: 'Área', value: '38', localizedValue: '38 m²' },
      { key: 'rooms_num', label: 'Tipologia', value: '1', localizedValue: 'T1' },
      { key: 'floor_no', label: 'Andar', value: '', localizedValue: 'sem informação' },
      { key: 'lift', label: 'Elevador', value: 'y', localizedValue: 'Sim' },
      { key: 'free_from', label: 'Disponível a partir de', value: '2027-01-01', localizedValue: '01.01.2027' },
      { key: 'advertiser_type', label: 'Tipo de anunciante', value: 'business', localizedValue: 'profissional' },
      { key: 'energy', label: 'Certificado energético', value: 'c', localizedValue: 'C' },
      { key: 'equipment', label: 'Equipamento', value: '', localizedValue: 'máquina de lavar louça, frigorífico, mobiliário' },
      { key: 'extras', label: 'Informações adicionais', value: '', localizedValue: 'garagem, varanda' },
    ],
  };

  it('fills in details from the embedded data', () => {
    const html = page(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { ad } } })}</script>`);
    const l = imo.parseDetail(html, base, NOW);
    expect(l).toMatchObject({
      detailsFetched: true, price: 800, lat: 41.1712, lon: -8.6078, coordsApprox: false, areaM2: 38, typology: 1,
      floor: 'SECOND', elevator: true, availableFrom: '2027-01-01', advertiser: 'agency', energyRating: 'C',
      furnished: 'yes', garage: true, outdoor: true, shortTerm: false, registration: true,
    });
    expect(l !== 'gone' && l.images).toHaveLength(3);
    expect(l !== 'gone' && l.description).toContain('Contrato de 1 ano');
  });

  it('reads labelled values from the markup when there is no embedded data', () => {
    const html = page(`<h1>T2 em Mafamude</h1><div><p>Elevador:</p><p>Sim</p></div><div><p>Disponível a partir de</p><p>15.12.2026</p></div>
      <div><p>Informações adicionais</p><p>garagem, terraço</p></div><div><p>Caução</p><p>sem informação</p></div>`);
    const l = imo.parseDetail(html, emptyListing('imovirtual', 'ID1', 'https://www.imovirtual.com/pt/anuncio/x-ID1'), NOW);
    expect(l).toMatchObject({ title: 'T2 em Mafamude', typology: 2, elevator: true, availableFrom: '2026-12-15', garage: true, outdoor: true, furnished: null });
  });

  it('recognises a page saying the ad is gone', () => {
    expect(imo.parseDetail(page('<h1>Este anúncio já não está disponível</h1>'), base, NOW)).toBe('gone');
  });
});

const olxAd = (over: Record<string, unknown> = {}) => ({
  id: 661234567,
  title: 'T2 mobilado com garagem em Mafamude',
  description: 'Apartamento <br> com contrato de arrendamento. Disponível a partir de 1 de janeiro.',
  url: 'https://www.olx.pt/d/anuncio/t2-mobilado-com-garagem-IDHabc1.html?reason=x',
  createdTime: '2026-11-14T09:00:00+00:00',
  isBusiness: false,
  params: [
    { key: 'price', name: 'Preço', type: 'price', value: '950 €' },
    { key: 'tipologia', name: 'Tipologia', value: 'T2' },
    { key: 'area_util', name: 'Área útil (m²)', value: '80' },
    { key: 'certificado_energetico', name: 'Certificado Energético', value: 'B' },
  ],
  price: { regularPrice: { value: 950, currencyCode: 'EUR' }, displayValue: '950 €' },
  location: { cityName: 'Vila Nova de Gaia', districtName: 'Mafamude e Vilar do Paraíso', regionName: 'Porto' },
  map: { lat: 41.12, lon: -8.6, radius: 2 },
  photos: ['https://img.test/olx1.jpg;s=1000x700', 'https://img.test/olx2.jpg;s=1000x700'],
  ...over,
});
const olxSearch = (ads: unknown[]) =>
  page(`<script>window.__PRERENDERED_STATE__= ${JSON.stringify(JSON.stringify({ listing: { listing: { ads, totalPages: 12 } } }))};window.__LANG__="pt";</script>`);

describe('olx search', () => {
  it('reads listings from the embedded state', () => {
    const res = olx.parseSearch(olxSearch([olxAd()]), NOW);
    expect(res.mode).toBe('structured');
    expect(res.totalPages).toBe(12);
    expect(res.listings[0]).toMatchObject({
      source: 'olx', sourceId: '661234567', url: 'https://www.olx.pt/d/anuncio/t2-mobilado-com-garagem-IDHabc1.html',
      price: 950, typology: 2, areaM2: 80, municipality: 'Vila Nova de Gaia', parish: 'Mafamude e Vilar do Paraíso',
      lat: 41.12, lon: -8.6, coordsApprox: true, advertiser: 'private', energyRating: 'B',
      furnished: 'yes', garage: true, registration: true, availableFrom: '2027-01-01', detailsFetched: true,
    });
  });

  it('also accepts the JSON API shape', () => {
    const api = {
      id: 5, title: 'T3 Boavista', url: 'https://www.olx.pt/d/anuncio/t3-boavista-IDx.html', description: 'x', created_time: '2026-11-01T00:00:00Z', business: true,
      params: [{ key: 'price', name: 'Preço', value: { value: 1250, label: '1.250 €' } }, { key: 'tipologia', name: 'Tipologia', value: { key: 't3', label: 'T3' } }, { key: 'mobilado', name: 'Mobilado', value: { key: 'nao', label: 'Não' } }],
      location: { city: { name: 'Porto' }, district: { name: 'Ramalde' }, region: { name: 'Porto' } },
      photos: [{ link: 'https://img.test/p/image;s={width}x{height}' }],
    };
    expect(olx.fromAd(api, NOW)).toMatchObject({ price: 1250, typology: 3, municipality: 'Porto', parish: 'Ramalde', advertiser: 'agency', furnished: 'no', images: ['https://img.test/p/image;s=1024x768'] });
  });

  it('files Imovirtual cross-posts under the Imovirtual id', () => {
    const cross = olxAd({ id: 777, url: 'https://www.imovirtual.com/pt/anuncio/apartamento-t1-arrendamento-em-paranhos-porto-ID1iWyZ.html' });
    const fromOlx = olx.parseSearch(olxSearch([cross]), NOW).listings[0]!;
    const fromImo = imo.parseSearch(imoSearch([imoItem()]), NOW).listings[0]!;
    expect([fromOlx.source, fromOlx.sourceId]).toEqual([fromImo.source, fromImo.sourceId]);
    expect(fromOlx.detailsFetched).toBe(false);
  });

  it('falls back to the card markup', () => {
    const html = page(`<div data-cy="l-card" id="661"><a href="/d/anuncio/t2-centro-IDq1.html"><h4>T2 no centro</h4></a>
      <p data-testid="ad-price">1.000 €</p><p data-testid="location-date">Porto, Bonfim - Hoje às 10:21</p><span>65 m²</span><img src="https://img.test/c.jpg"></div>
      <div data-cy="l-card" id="662"><a href="https://www.imovirtual.com/pt/anuncio/t1-novo-ID1j5tM.html"><h4>T1 novo</h4></a><p data-testid="ad-price">900 €</p></div>`);
    const res = olx.parseSearch(html, NOW);
    expect(res.mode).toBe('html');
    expect(res.listings[0]).toMatchObject({ source: 'olx', sourceId: '661', price: 1000, typology: 2, areaM2: 65, municipality: 'Porto', parish: 'Bonfim' });
    expect(res.listings[1]).toMatchObject({ source: 'imovirtual', sourceId: 'ID1j5tM', price: 900 });
  });
});
