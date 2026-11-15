import type { Furnished, Tri } from './types.js';

/** Lower-case, strip accents, collapse whitespace. All matching runs on this form. */
export function norm(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a);
  return x.length > 0 && x === norm(b);
}

/** "830 €/mês", "1.200 €", "1 250€", "€1,300" -> number. Returns null when no amount is found. */
export function parsePrice(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /(\d{1,3}(?:[.\s ,]\d{3})+|\d+)(?:[.,](\d{1,2}))?/.exec(text);
  if (!m || !m[1]) return null;
  const whole = Number(m[1].replace(/[.\s ,]/g, ''));
  if (!Number.isFinite(whole) || whole <= 0) return null;
  return m[2] ? whole + Number(`0.${m[2]}`) : whole;
}

/**
 * Finds the first euro amount in running text ("T2 900€ Gaia" -> 900). The
 * digit of a typology such as "T2" is never taken as thousands.
 */
export function findEuroAmount(text: string | null | undefined): number | null {
  const t = text ?? '';
  const m = /(?<![\dTt.,])(\d{1,3}(?:[.\s\u00a0]\d{3})+|\d+)(?:,\d{1,2})?\s*(?:€|eur\b)/i.exec(t) ?? /(?:€|eur)\s*(\d{1,3}(?:[.,\s\u00a0]\d{3})+|\d+)/i.exec(t);
  return m ? parsePrice(m[1]) : null;
}

/** "T2", "t 3", "T2+1", "estúdio" -> bedrooms. */
export function parseTypology(text: string | null | undefined): number | null {
  const t = norm(text);
  const m = /(?:^|[^a-z0-9])t\s?(\d)(?!\d)/.exec(t);
  if (m?.[1]) return Number(m[1]);
  if (/\b(estudio|studio)\b/.test(t)) return 0;
  return null;
}

export function parseArea(text: string | null | undefined): number | null {
  const m = /(?<![\d.,])(\d{1,4}(?:[.,]\d+)?)\s*m(?:²|2)(?![a-z0-9])/i.exec(text ?? '');
  if (!m?.[1]) return null;
  const v = Number(m[1].replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const MONTH_RE = Object.keys(MONTHS).join('|');

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Year to assume for a month/day given without a year: the next time it occurs. */
function nextOccurrenceYear(month: number, day: number, now: Date): number {
  const y = now.getUTCFullYear();
  const candidate = Date.UTC(y, month - 1, day);
  // A date up to ~a month in the past still means "this year" (already available).
  return candidate < now.getTime() - 31 * 86_400_000 ? y + 1 : y;
}

/** Parses a bare date value such as "01.01.2027", "1/2/2027", "2027-01-15", "janeiro 2027". */
export function parseDateValue(text: string | null | undefined, now: Date): string | null {
  const t = norm(text);
  if (!t) return null;
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(t);
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  m = new RegExp(`(?:(\\d{1,2})(?:º)? (?:de )?)?(${MONTH_RE})(?: (?:de )?(\\d{4}))?`).exec(t);
  if (m?.[2]) {
    const month = MONTHS[m[2]]!;
    const day = m[1] ? Number(m[1]) : 1;
    const year = m[3] ? Number(m[3]) : nextOccurrenceYear(month, day, now);
    return iso(year, month, day);
  }
  if (/imediat|\bja\b/.test(t)) return now.toISOString().slice(0, 10);
  return null;
}

/** Finds "disponível a partir de ..." style phrases in free text. */
export function parseAvailableFrom(text: string | null | undefined, now: Date): string | null {
  const t = norm(text);
  if (!t) return null;
  if (/(disponi\w+|entrada|ocupacao) (de )?imediat|disponivel ja\b|livre de imediato/.test(t)) {
    return now.toISOString().slice(0, 10);
  }
  const m = /(?:disponi\w+|livre|entrada)\s(?:a partir d[eo]|em|desde|para|no dia|a|d[eo]s?)?\s?(?:o |a |dia |inicio de |meados de |final de |fim de )*([^.;!\n]{3,40})/.exec(t);
  if (!m?.[1]) return null;
  const chunk = m[1];
  if (!new RegExp(`\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}|\\d{4}-\\d{2}-\\d{2}|${MONTH_RE}`).test(chunk)) return null;
  return parseDateValue(chunk, now);
}

export interface TextFeatures {
  furnished: Furnished;
  garage: Tri;
  outdoor: Tri;
  elevator: Tri;
  shortTerm: Tri;
  sharedRoom: Tri;
  registration: Tri;
  availableFrom: string | null;
}

const SHORT_TERM =
  /curta duracao|curto prazo|curtos periodos|temporada|sazonal|arrendamento temporario|alojamento local|short[- ]term|holiday rental|(?:para|de|casa de) ferias|(?:por|\/|ao|a) ?(?:noite|dia|semana)\b|(?:so |apenas |somente )?ate (?:ao )?(?:fim|final|inicio|meados)? ?(?:de |do mes de )?(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)|contrato (?:de |maximo de |max\.? )?(?:[1-9]|1[01]) meses|maximo (?:de )?(?:[1-9]|1[01]) meses|erasmus/;
const LONG_TERM =
  /longa duracao|longo prazo|long[- ]term|contrato (?:de |minimo de |min\.? )?(?:1|um|2|dois|3|tres|5|cinco) anos?|contrato anual|minimo (?:de )?(?:1|um|12) (?:ano|meses)/;
const SHARED_TITLE = /^\W*(?:aluga-?se |arrenda-?se |arrendo |alugo |disponivel )?(?:\d+ )?quartos?\b(?! de banho)/;
const SHARED_TEXT =
  /quarto (?:em|num|numa) (?:apartamento|casa|moradia|t\d)|quartos? para (?:estudante|rapariga|rapaz|senhora|menina|trabalhador|casal)|(?:casa|apartamento|moradia|habitacao) partilhad|partilha de (?:casa|apartamento)|room in (?:a )?shared|co-?living|residencia (?:de estudantes|universitaria)/;

/**
 * Reads Portuguese listing text and extracts yes/no facts. Each fact stays
 * null unless the text actually says something about it, so "not mentioned"
 * is never confused with "no".
 */
export function extractFeatures(title: string | null, body: string | null, now: Date): TextFeatures {
  const t = norm(title);
  const all = norm(`${title ?? ''} . ${body ?? ''}`);

  // Furnishing. "cozinha mobilada/equipada" describes the kitchen only, so it
  // is taken out before looking for a statement about the whole flat.
  const kitchenOnly = /cozinha (?:\w+ )?(?:mobilada|equipada)(?: e (?:mobilada|equipada))?/g;
  const hasKitchen = kitchenOnly.test(all);
  const rest = all.replace(kitchenOnly, ' ');
  let furnished: Furnished = null;
  if (/(?:nao|sem) (?:esta |e |se encontra )?(?:mobilad|mobilia)|desmobilad|por mobilar|unfurnished|sem (?:moveis|mobiliario)/.test(rest)) furnished = 'no';
  else if (/semi[- ]?mobilad|parcialmente mobilad|partly furnished/.test(rest)) furnished = 'partial';
  else if (/mobilad[oa]s?\b|com mobilia|\bmobiliario\b|\bfurnished/.test(rest)) furnished = 'yes';
  else if (hasKitchen) furnished = 'partial';

  let garage: Tri = null;
  if (/sem (?:lugar de )?(?:garagem|estacionamento|parqueamento)|nao (?:tem|possui|inclui) (?:lugar de )?garagem/.test(all)) garage = false;
  else if (/garagem|lugar(?:es)? de (?:estacionamento|parqueamento|aparcamento)|estacionamento (?:privad|privativ|cobert|proprio|subterraneo)|\bbox\b/.test(all)) garage = true;

  let outdoor: Tri = null;
  if (/sem (?:varanda|terraco|espaco exterior)/.test(all)) outdoor = false;
  else if (/varanda|terraco|quintal|\bpatio\b|logradouro|com jardim|jardim (?:privad|privativ|proprio)|balcony|terrace/.test(all)) outdoor = true;

  let elevator: Tri = null;
  if (/sem elevador|nao (?:tem|possui) elevador/.test(all)) elevator = false;
  else if (/elevador|ascensor/.test(all)) elevator = true;

  let shortTerm: Tri = null;
  if (SHORT_TERM.test(all)) shortTerm = true;
  else if (LONG_TERM.test(all)) shortTerm = false;

  const sharedRoom: Tri = SHARED_TITLE.test(t) || SHARED_TEXT.test(all) ? true : null;

  let registration: Tri = null;
  if (/sem (?:contrato|recibos?)|nao (?:se )?(?:passa|passo|emite|emito|faz|faco) (?:recibos?|contrato)|sem (?:possibilidade de )?morada fiscal/.test(all)) registration = false;
  else if (/com contrato|contrato de arrendamento|contrato registado|registado nas financas|recibos? (?:de renda|eletronico|electronico)|com recibos?|passa-?se recibo|morada fiscal/.test(all)) registration = true;

  return { furnished, garage, outdoor, elevator, shortTerm, sharedRoom, registration, availableFrom: parseAvailableFrom(all, now) };
}
