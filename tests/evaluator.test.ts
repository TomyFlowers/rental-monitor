import { describe, expect, it } from 'vitest';
import { evaluate, linearDecay } from '../src/core/evaluator.js';
import { listing, shippedConfig } from './helpers.js';

const cfg = shippedConfig();

describe('hard requirements', () => {
  it('accepts a listing inside every limit', () => {
    expect(evaluate(listing(), cfg).verdict).toBe('match');
  });
  it('rejects other municipalities, ignoring accents and case', () => {
    expect(evaluate(listing({ municipality: 'Matosinhos' }), cfg).reasons[0]).toMatch(/Outside target area/);
    expect(evaluate(listing({ municipality: 'vila nova de gaia' }), cfg).verdict).toBe('match');
  });
  it('applies the rent cap of the listing typology', () => {
    expect(evaluate(listing({ typology: 1, price: 1050 }), cfg).verdict).toBe('rejected'); // T1 cap 1000
    expect(evaluate(listing({ typology: 2, price: 1150 }), cfg).verdict).toBe('match'); // T2 cap 1150
    expect(evaluate(listing({ typology: 2, price: 1151 }), cfg).verdict).toBe('rejected');
    expect(evaluate(listing({ typology: 3, price: 1300 }), cfg).verdict).toBe('match'); // T3 cap 1300
    expect(evaluate(listing({ typology: null, price: 1300 }), cfg).verdict).toBe('match'); // default cap
  });
  it('rejects typologies outside T1-T3', () => {
    expect(evaluate(listing({ typology: 0 }), cfg).verdict).toBe('rejected');
    expect(evaluate(listing({ typology: 4 }), cfg).verdict).toBe('rejected');
  });
  it('rejects deal-breakers', () => {
    expect(evaluate(listing({ shortTerm: true }), cfg).reasons).toContain('Short-term or seasonal rental');
    expect(evaluate(listing({ sharedRoom: true }), cfg).reasons).toContain('Room or shared accommodation');
  });
});

describe('unknown values', () => {
  it('keeps and flags a listing with unknown hard-requirement values', () => {
    const e = evaluate(listing({ municipality: null, price: null, typology: null }), cfg);
    expect(e.verdict).toBe('match');
    expect(e.flags).toEqual(expect.arrayContaining(['Municipality unknown', 'Rent unknown', 'Typology unknown']));
  });
  it('excludes instead when the config says so', () => {
    const strict = { ...cfg, criteria: { ...cfg.criteria, unknown: { ...cfg.criteria.unknown, price: 'exclude' as const } } };
    const e = evaluate(listing({ price: null }), strict);
    expect(e.verdict).toBe('rejected');
    expect(e.reasons).toContain('Rent not stated');
  });
  it('gives unknown soft preferences the neutral share and flags them', () => {
    const e = evaluate(listing(), cfg);
    const garage = e.parts.find((p) => p.key === 'garage')!;
    expect(garage.fraction).toBeNull();
    expect(garage.points).toBe(4); // 8 x 0.5
    expect(e.flags).toContain('Garage unknown');
  });
});

describe('scoring', () => {
  it('decays linearly', () => {
    expect(linearDecay(30, 30, 50)).toBe(1);
    expect(linearDecay(40, 30, 50)).toBe(0.5);
    expect(linearDecay(60, 30, 50)).toBe(0);
  });
  it('scores a perfect listing 100 and a poor one low', () => {
    const perfect = listing({ commuteMinutes: 12, registration: true, furnished: 'yes', garage: true, outdoor: true, availableFrom: '2027-01-05' });
    expect(evaluate(perfect, cfg).score).toBe(100);
    const poor = listing({ typology: 3, price: 1300, commuteMinutes: 55, registration: false, furnished: 'no', garage: false, outdoor: false, availableFrom: '2027-08-01' });
    expect(evaluate(poor, cfg).score).toBe(5); // only T3 at half weight: 10 x 0.5 / 100
  });
  it('computes the documented example', () => {
    // commute 40 min -> 0.5 x 25; rent 1150 -> 0.5 x 20; T2 -> 10; rest unknown -> 45 x 0.5
    const e = evaluate(listing({ price: 1150, commuteMinutes: 40 }), cfg);
    expect(e.score).toBe(55);
  });
  it('rewards move-in dates near the window', () => {
    const at = (d: string) => evaluate(listing({ availableFrom: d }), cfg).parts.find((p) => p.key === 'moveIn')!.fraction;
    expect(at('2027-01-01')).toBe(1);
    expect(at('2026-11-15')).toBe(0.5); // 30 days early, 60-day grace
    expect(at('2027-06-01')).toBe(0);
  });
  it('still scores rejected listings so they can be reconsidered', () => {
    expect(evaluate(listing({ municipality: 'Maia' }), cfg).score).toBeGreaterThan(0);
  });
});
