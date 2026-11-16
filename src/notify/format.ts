import type { EventRow, ListingRow, RunRow } from '../store/db.js';

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SOURCE_NAMES: Record<string, string> = { imovirtual: 'Imovirtual', olx: 'OLX', casasapo: 'Casa Sapo', idealista: 'Idealista', email: 'Email alerts', manual: 'added by hand' };
const sourceName = (s: string) => SOURCE_NAMES[s] ?? s;
const euro = (n: number) => `€${Math.round(n).toLocaleString('en-US')}`;
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function place(row: ListingRow): string {
  const l = row.listing;
  return [l.parish, l.municipality].filter(Boolean).join(', ') || l.locationText || 'location unknown';
}

function headline(ev: Pick<EventRow, 'type' | 'payload' | 'row'>): string {
  const score = `${Math.round(ev.row.evaluation.score)}/100`;
  const p = ev.payload;
  switch (ev.type) {
    case 'new':
      return p.reconsidered ? `♻️ <b>Now matches after a change · ${score}</b>` : `🏠 <b>New match · ${score}</b>`;
    case 'price_drop':
      return `📉 <b>Price drop ${euro(Number(p.from))} → ${euro(Number(p.to))} · ${score}</b>`;
    case 'price_up':
      return `📈 <b>Price up ${euro(Number(p.from))} → ${euro(Number(p.to))} · ${score}</b>`;
    case 'relisted':
      return `🔁 <b>Back online · ${score}</b>`;
    case 'removed':
      return '❌ <b>No longer available</b>';
    default:
      return `✏️ <b>Listing updated · ${score}</b>`;
  }
}

/** The message that accompanies an instant alert (HTML, Telegram subset). */
export function alertHtml(ev: Pick<EventRow, 'type' | 'payload' | 'row'>, destination: string): string {
  const { listing: l, evaluation: e } = ev.row;
  const lines: string[] = [headline(ev)];

  const facts = [l.typology === null ? null : `T${l.typology}`, l.price === null ? null : `${euro(l.price)}/month`, l.areaM2 === null ? null : `${Math.round(l.areaM2)} m²`];
  lines.push(`<b>${esc(facts.filter(Boolean).join(' · ') || 'Details not stated')}</b>`);
  lines.push(`📍 ${esc(place(ev.row))}`);
  if (l.commuteMinutes !== null) lines.push(`🚗 about ${Math.round(l.commuteMinutes)} min to ${esc(destination)}${l.coordsApprox ? ' (from area centre)' : ''}`);

  const good: string[] = [];
  if (l.furnished === 'yes') good.push('Furnished');
  if (l.furnished === 'partial') good.push('Partly furnished');
  if (l.garage === true) good.push('Garage');
  if (l.outdoor === true) good.push('Outdoor space');
  if (l.elevator === true) good.push('Elevator');
  if (l.registration === true) good.push('Contract');
  if (good.length) lines.push(`✅ ${good.join(' · ')}`);

  const bad: string[] = [];
  if (l.furnished === 'no') bad.push('Unfurnished');
  if (l.garage === false) bad.push('No garage');
  if (l.outdoor === false) bad.push('No outdoor space');
  if (l.registration === false) bad.push('No contract/receipts');
  if (bad.length) lines.push(`➖ ${bad.join(' · ')}`);

  if (l.availableFrom) lines.push(`📅 Available from ${l.availableFrom}`);
  const who = l.advertiser === 'private' ? 'Private landlord' : l.advertiser === 'agency' ? 'Agency' : null;
  lines.push(`👤 ${[who, `via ${sourceName(l.source)}`].filter(Boolean).join(' · ')}`);

  if (Array.isArray(ev.payload.changes)) {
    for (const c of ev.payload.changes as Array<{ field: string; from: unknown; to: unknown }>) lines.push(`✏️ ${esc(c.field)}: ${esc(String(c.from))} → ${esc(String(c.to))}`);
  }
  if (Array.isArray(ev.payload.nowRejected)) lines.push(`⛔ No longer matches: ${esc((ev.payload.nowRejected as string[]).join('; '))}`);
  if (e.verdict === 'rejected' && !ev.payload.nowRejected) lines.push(`⛔ Does not match: ${esc(e.reasons.join('; '))}`);
  if (e.flags.length) lines.push(`⚠️ ${esc(e.flags.join(' · '))}`);

  lines.push(`<a href="${esc(l.url)}">${esc(trim(l.title || 'Open listing', 90))}</a>`);
  return lines.join('\n');
}

/** One compact line per listing. /show_<n> is tappable in Telegram and opens the card with buttons. */
export function digestLine(row: ListingRow, prefix = ''): string {
  const l = row.listing;
  const bits = [
    `<b>${Math.round(row.evaluation.score)}</b>`,
    l.typology === null ? null : `T${l.typology}`,
    l.price === null ? null : euro(l.price),
    esc(trim(place(row), 40)),
    l.commuteMinutes === null ? null : `🚗${Math.round(l.commuteMinutes)}m`,
    row.userState === 'favorite' ? '⭐' : null,
    `/show_${row.id}`,
  ];
  return `${prefix}${bits.filter(Boolean).join(' · ')}\n   <a href="${esc(l.url)}">${esc(trim(l.title || 'Open listing', 60))}</a>`;
}

const SHORT_TOWNS: Record<string, string> = { 'Vila Nova de Gaia': 'Gaia' };

/**
 * A roomier entry for the favourites and ignored lists: status, typology,
 * rent and area on one line, the title and its /show link on the next. The
 * score and driving time are left out here; they are on the card.
 */
export function listEntry(row: ListingRow, icon = row.status === 'removed' ? '❌' : row.userState === 'ignored' ? '🚫' : '⭐'): string {
  const l = row.listing;
  const facts = [l.typology === null ? null : `T${l.typology}`, l.price === null ? null : euro(l.price)].filter(Boolean).join(' · ') || 'Details not stated';
  const town = l.municipality ? (SHORT_TOWNS[l.municipality] ?? l.municipality) : null;
  const where = [l.parish ? trim(l.parish, 28) : null, town].filter(Boolean).join(', ') || 'location unknown';
  return `${icon} <b>${esc(facts)}</b> · ${esc(where)}\n<a href="${esc(l.url)}">${esc(trim(l.title || 'Open listing', 55))}</a> · /show_${row.id}`;
}

export interface DigestInput {
  date: string;
  fresh: EventRow[];
  changed: EventRow[];
  removed: EventRow[];
  topPicks: ListingRow[];
  hidden: number;
  sources: Array<{ name: string; last: RunRow | null }>;
}

/** Builds the digest as one or more messages, each within Telegram's size limit. */
export function digestHtml(d: DigestInput): string[] {
  const blocks: string[] = [`🗞 <b>Daily digest · ${d.date}</b>`];
  const section = (title: string, lines: string[]) => {
    if (lines.length) blocks.push(`\n<b>${title}</b>`, ...lines);
  };
  section(`New (${d.fresh.length + d.hidden})`, d.fresh.map((ev) => digestLine(ev.row, ev.payload.reconsidered ? '♻️ ' : '')));
  if (d.hidden > 0) blocks.push(`   …and ${d.hidden} lower-scored more (see /top)`);
  section(
    `Changed (${d.changed.length})`,
    d.changed.map((ev) => {
      const p = ev.payload;
      const what =
        ev.type === 'price_drop' || ev.type === 'price_up'
          ? `${ev.type === 'price_drop' ? '📉' : '📈'} ${euro(Number(p.from))} → ${euro(Number(p.to))}\n   `
          : ev.type === 'relisted'
            ? '🔁 back online\n   '
            : Array.isArray(p.nowRejected)
              ? `⛔ ${esc((p.nowRejected as string[]).join('; '))}\n   `
              : `✏️ ${esc((p.changes as Array<{ field: string; from: unknown; to: unknown }> | undefined)?.map((c) => `${c.field}: ${String(c.from)} → ${String(c.to)}`).join(', ') ?? 'updated')}\n   `;
      return digestLine(ev.row, what);
    }),
  );
  section(`Removed (${d.removed.length})`, d.removed.map((ev) => digestLine(ev.row, '❌ ')));
  section('Top picks right now', d.topPicks.map((row, i) => digestLine(row, `${i + 1}. `)));
  if (d.fresh.length + d.changed.length + d.removed.length + d.hidden === 0) blocks.splice(1, 0, 'Nothing new today.');
  const health = d.sources.map((s) => `${sourceName(s.name)} ${s.last === null ? '–' : s.last.ok ? '✅' : '⚠️'}`).join(' · ');
  if (health) blocks.push(`\n<i>Sources: ${health}</i>`);

  // Split on block boundaries so no HTML tag is ever cut in half.
  const messages: string[] = [];
  let current = '';
  for (const b of blocks) {
    if (current.length + b.length + 1 > 3800) {
      messages.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + b;
  }
  if (current.trim()) messages.push(current);
  return messages;
}
