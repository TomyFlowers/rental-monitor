import type { Config } from '../config.js';
import { sameName } from './text.js';
import type { Evaluation, Listing, ScorePart } from './types.js';

type Criteria = Config['criteria'];
type Scoring = Config['scoring'];

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** 1 at or below `fullAt`, falling in a straight line to 0 at `zeroAt`. */
export function linearDecay(value: number, fullAt: number, zeroAt: number): number {
  if (value <= fullAt) return 1;
  if (value >= zeroAt) return 0;
  return clamp01((zeroAt - value) / (zeroAt - fullAt));
}

export function rentCap(criteria: Criteria, typology: number | null): number {
  const key = typology === null ? 'default' : `T${typology}`;
  return criteria.maxRent[key] ?? criteria.maxRent['default']!;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function moveInFraction(date: string, cfg: Scoring['moveIn']): number {
  if (date >= cfg.from && date <= cfg.to) return 1;
  const gap = date < cfg.from ? daysBetween(date, cfg.from) : daysBetween(cfg.to, date);
  return clamp01(1 - gap / cfg.graceDays);
}

/**
 * Applies hard requirements and deal-breakers, then scores soft preferences.
 * A missing value never counts as a violation by itself: it is either flagged
 * or (if configured) excluded explicitly.
 */
export function evaluate(l: Listing, cfg: Pick<Config, 'criteria' | 'scoring'>): Evaluation {
  const { criteria, scoring } = cfg;
  const reasons: string[] = [];
  const flags: string[] = [];

  const unknown = (field: keyof Criteria['unknown'], label: string) => {
    if (criteria.unknown[field] === 'exclude') reasons.push(`${label} not stated`);
    else flags.push(`${label} unknown`);
  };

  // --- Hard requirements -------------------------------------------------
  if (l.municipality === null) unknown('municipality', 'Municipality');
  else if (!criteria.municipalities.some((m) => sameName(m, l.municipality)))
    reasons.push(`Outside target area (${l.municipality})`);

  if (l.typology === null) unknown('typology', 'Typology');
  else if (l.typology < criteria.typology.min || l.typology > criteria.typology.max)
    reasons.push(`T${l.typology} is outside T${criteria.typology.min}-T${criteria.typology.max}`);

  if (l.price === null) unknown('price', 'Rent');
  else {
    const cap = rentCap(criteria, l.typology);
    if (l.price > cap) reasons.push(`Rent €${l.price} is above the €${cap} cap${l.typology === null ? '' : ` for T${l.typology}`}`);
  }

  // --- Deal-breakers -----------------------------------------------------
  if (criteria.dealBreakers.shortTerm && l.shortTerm === true) reasons.push('Short-term or seasonal rental');
  if (criteria.dealBreakers.sharedRoom && l.sharedRoom === true) reasons.push('Room or shared accommodation');

  // --- Soft preferences --------------------------------------------------
  const w = scoring.weights;
  const parts: ScorePart[] = [];
  const add = (key: keyof Scoring['weights'], fraction: number | null, unknownLabel?: string) => {
    const weight = w[key];
    if (weight <= 0) return;
    if (fraction === null && unknownLabel) flags.push(`${unknownLabel} unknown`);
    parts.push({ key, weight, fraction, points: weight * (fraction ?? scoring.unknownFraction) });
  };

  add(
    'commute',
    l.commuteMinutes === null ? null : linearDecay(l.commuteMinutes, scoring.commute.fullAtMinutes, scoring.commute.zeroAtMinutes),
    'Commute time',
  );
  // Unknown rent is already flagged above as a hard-requirement unknown.
  add('rent', l.price === null ? null : linearDecay(l.price, scoring.rent.fullAt, scoring.rent.zeroAt));
  add('registration', l.registration === null ? null : l.registration ? 1 : 0, 'Contract/registration');
  add('typology', l.typology === null ? null : (scoring.typology[`T${l.typology}`] ?? 0));
  add('furnished', l.furnished === null ? null : scoring.furnished[l.furnished], 'Furnishing');
  add('garage', l.garage === null ? null : l.garage ? 1 : 0, 'Garage');
  add('outdoor', l.outdoor === null ? null : l.outdoor ? 1 : 0, 'Outdoor space');
  add('moveIn', l.availableFrom === null ? null : moveInFraction(l.availableFrom, scoring.moveIn), 'Move-in date');

  const total = parts.reduce((s, p) => s + p.weight, 0);
  const earned = parts.reduce((s, p) => s + p.points, 0);
  const score = total > 0 ? Math.round((earned / total) * 1000) / 10 : 0;

  if (l.coordsApprox && l.commuteMinutes !== null) flags.push('Commute estimated from the area, not the exact address');

  return { verdict: reasons.length > 0 ? 'rejected' : 'match', reasons, flags, score, parts };
}
