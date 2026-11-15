import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import * as sapo from '../src/sources/casasapo/parse.js';
import { EmailAlertFeed, fromAllowedSender } from '../src/sources/email/index.js';
import type { AlertMail, Mailbox } from '../src/sources/email/imap.js';
import { extractListings, identifyListingUrl, resolveLink } from '../src/sources/email/parse.js';
import { shippedConfig } from './helpers.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const page = (body: string) => `<!doctype html><html><body><header><a href="/alugar-apartamentos/">Alugar</a></header>${body}</body></html>`;
const TOWNS = ['Porto', 'Vila Nova de Gaia'];

/** Mirrors the card layout seen on casa.sapo.pt results: repeated image links, a title link, one text line, an agency link, a description. */
const sapoCard = (o: { href: string; title: string; line: string; desc: string; img: string }) => `
  <div class="property">
    <a href="${o.href}"><img src="${o.img}"></a><a href="${o.href}"><img data-src="${o.img.replace('.jpg', '-2.jpg')}"></a>
    <a href="${o.href}" title="Ver ${o.line.split(' alugar')[0]}"><span>${o.title}</span></a>
    <div><span>${o.line}</span></div>
    <a href="https://casa.sapo.pt/agencia/x/">Veja todos os imóveis do anunciante</a>
    <p>${o.desc}</p><button>Contactar</button>
  </div>`;
const COUNTER = 'https://gespub.casa.sapo.pt/v3/webinterface/client/counter.aspx?c=1&p=1097984&s=0&l=';

describe('casa sapo', () => {
  const html = page(
    sapoCard({
      href: `${COUNTER}https://casa.sapo.pt/alugar-apartamento-t2-porto-aldoar-foz-do-douro-e-nevogilde-9fad9333-cbdf-11f1-9aaf-060000000054.html?g3pid=1097984`,
      title: 'T2 frente ao Parque Cidade',
      line: 'Apartamento T2 Aldoar, Foz do Douro e Nevogilde, Porto, Distrito do Porto Usado · 90m² Com Garagem alugar 1.850 €',
      desc: 'Apartamento mobilado com varanda. Condomínio 50 € incluído.',
      img: 'https://media.casasapo.pt/Z360x270/a.jpg',
    }) +
      sapoCard({
        href: 'https://casa.sapo.pt/alugar-apartamento-t1-vila-nova-de-gaia-mafamude-aeea8e94-d2dd-11f1-b6e5-060000000058.html',
        title: 'Apartamento T1 Duplex',
        line: 'Apartamento T1 Duplex Mafamude, Vila Nova de Gaia, Distrito do Porto Novo · 69m² alugar 950 €',
        desc: 'Contrato de arrendamento de 1 ano.',
        img: 'https://media.casasapo.pt/Z360x270/b.jpg',
      }) +
      '<nav><a href="https://casa.sapo.pt/alugar-apartamentos/porto/?pn=2">2</a><a href="https://casa.sapo.pt/alugar-apartamentos/porto/?pn=16">16</a></nav>',
  );

  it('reads cards, unwrapping the click-counter links', () => {
    const res = sapo.parseSearch(html, NOW);
    expect(res.totalPages).toBe(16);
    expect(res.listings).toHaveLength(2);
    expect(res.listings[0]).toMatchObject({
      source: 'casasapo', sourceId: '9fad9333-cbdf-11f1-9aaf-060000000054',
      url: 'https://casa.sapo.pt/alugar-apartamento-t2-porto-aldoar-foz-do-douro-e-nevogilde-9fad9333-cbdf-11f1-9aaf-060000000054.html',
      title: 'T2 frente ao Parque Cidade', price: 1850, typology: 2, areaM2: 90,
      municipality: 'Porto', parish: 'Aldoar, Foz do Douro e Nevogilde', garage: true, furnished: 'yes', outdoor: true,
    });
    expect(res.listings[0]!.images).toEqual(['https://media.casasapo.pt/Z360x270/a.jpg', 'https://media.casasapo.pt/Z360x270/a-2.jpg']);
    expect(res.listings[1]).toMatchObject({ price: 950, typology: 1, areaM2: 69, municipality: 'Vila Nova de Gaia', parish: 'Mafamude', shortTerm: false, registration: true, garage: null });
  });

  it('leaves the location unknown rather than guessing when the line has no district', () => {
    expect(sapo.parseLocation('Apartamento T2 algures alugar 900 €')).toEqual({ municipality: null, parish: null, locationText: null });
  });

  it('ignores links that are not listings', () => {
    expect(sapo.identify('https://casa.sapo.pt/alugar-apartamentos/porto/?pn=2')).toBeNull();
    expect(sapo.identify(`${COUNTER}https://evil.test/x-9fad9333-cbdf-11f1-9aaf-060000000054.html`)).toBeNull();
  });
});

describe('listing links in emails', () => {
  it('recognises each site', () => {
    expect(identifyListingUrl('https://www.idealista.pt/imovel/34567890/?xtmc=1')).toEqual({ source: 'idealista', sourceId: '34567890', url: 'https://www.idealista.pt/imovel/34567890/' });
    expect(identifyListingUrl('https://www.olx.pt/d/anuncio/t2-centro-IDHabc1.html?utm=x')).toMatchObject({ source: 'olx', sourceId: 'Habc1' });
    expect(identifyListingUrl('https://www.imovirtual.com/pt/anuncio/t1-novo-ID1j5tM')).toMatchObject({ source: 'imovirtual', sourceId: 'ID1j5tM' });
    expect(identifyListingUrl('https://www.idealista.pt/arrendar-casas/porto/')).toBeNull();
    expect(identifyListingUrl('https://www.olx.pt/imoveis/')).toBeNull();
  });
  it('finds the real address inside a tracking link', () => {
    const tracked = `https://click.mail.test/c?u=${encodeURIComponent('https://www.idealista.pt/imovel/111/')}&id=9`;
    expect(resolveLink(tracked)).toMatchObject({ source: 'idealista', sourceId: '111' });
    expect(resolveLink('https://click.mail.test/c/abc123')).toBeNull();
  });
});

const alertEmail = `<html><body><table>
  <tr><td><a href="https://www.idealista.pt/"><img src="https://st.test/logo.png" alt="idealista"></a> 2 novos anúncios no Porto</td></tr>
  <tr><td><table><tr>
    <td><a href="https://www.idealista.pt/imovel/111/?xtor=a"><img src="https://img.test/111.jpg" alt="Apartamento T2 na Rua de Cedofeita"></a></td>
    <td><a href="https://www.idealista.pt/imovel/111/?xtor=b">Apartamento T2 na Rua de Cedofeita, Porto</a><br><b>950 €/mês</b><br>T2 · 75 m² · 2º andar com elevador<br>Mobilado, com varanda.</td>
  </tr></table></td></tr>
  <tr><td><table><tr>
    <td><a href="https://click.mail.test/c?u=${encodeURIComponent('https://www.olx.pt/d/anuncio/t3-com-garagem-em-gaia-IDK9x2.html')}">T3 com garagem em Gaia</a> 1.200 € <img src="https://img.test/pixel.gif" width="1" height="1"></td>
  </tr></table></td></tr>
  <tr><td><a href="https://www.idealista.pt/unsubscribe">Cancelar alertas</a> Preços desde 500 €</td></tr>
</table></body></html>`;

describe('alert emails', () => {
  it('reads one listing per block, ignoring header and footer links', () => {
    const { listings } = extractListings(alertEmail, TOWNS, NOW);
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({
      source: 'idealista', sourceId: '111', url: 'https://www.idealista.pt/imovel/111/', title: 'Apartamento T2 na Rua de Cedofeita, Porto',
      price: 950, typology: 2, areaM2: 75, municipality: 'Porto', furnished: 'yes', outdoor: true, elevator: true, images: ['https://img.test/111.jpg'], detailsFetched: true,
    });
    expect(listings[1]).toMatchObject({ source: 'olx', sourceId: 'K9x2', price: 1200, typology: 3, municipality: 'Vila Nova de Gaia', garage: true, images: [] });
  });

  it('keeps a listing whose block has only a bare link, with unknowns left unknown', () => {
    const { listings } = extractListings('<p><a href="https://www.idealista.pt/imovel/222/">Ver anúncio</a></p><p><a href="https://www.idealista.pt/imovel/333/">Ver anúncio</a></p>', TOWNS, NOW);
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({ sourceId: '222', price: null, typology: null, municipality: null });
  });

  class FakeMailbox implements Mailbox {
    read: number[] = [];
    constructor(private mails: AlertMail[]) {}
    async unread() {
      return this.mails;
    }
    async markRead(uids: number[]) {
      this.read.push(...uids);
    }
  }
  const mail = (uid: number, from: string, html: string): AlertMail => ({ uid, from, subject: 's', html, raw: Buffer.from('') });

  it('reads only mail from the listed senders and marks only that as read', async () => {
    const box = new FakeMailbox([mail(1, 'alertas@idealista.pt', alertEmail), mail(2, 'friend@example.org', alertEmail), mail(3, 'no-reply@mail.olx.pt', '<p>Bem-vindo</p>')]);
    const feed = new EmailAlertFeed(shippedConfig().email, TOWNS, box);
    const res = await feed.fetch(NOW);
    expect(res.listings).toHaveLength(2);
    expect(res.note).toBe('2 alert email(s), 1 with no recognisable listing links');
    expect(box.read).toEqual([1, 3]);
  });

  it('matches sender domains exactly or as subdomains', () => {
    expect(fromAllowedSender('a@mail.olx.pt', ['olx.pt'])).toBe(true);
    expect(fromAllowedSender('a@notolx.pt', ['olx.pt'])).toBe(false);
  });
});

describe('config compatibility', () => {
  it('accepts a config written before email and ratePhotos existed', () => {
    const raw = structuredClone(shippedConfig()) as unknown as Record<string, any>;
    delete raw.email;
    delete raw.notifications.ratePhotos;
    const cfg = parseConfig(raw);
    expect(cfg.email).toMatchObject({ enabled: false, host: 'imap.gmail.com', port: 993 });
    expect(cfg.notifications.ratePhotos).toBe(3);
  });
});
