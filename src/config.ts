import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const fraction = z.number().min(0).max(1);
const weight = z.number().min(0);

const sourceSchema = z.strictObject({
  enabled: z.boolean().default(true),
  maxPages: z.number().int().min(1).max(50).default(3),
  firstRunMaxPages: z.number().int().min(1).max(100).default(8),
  searches: z.array(z.url()).min(1),
});

export const configSchema = z.strictObject({
  timezone: z.string().default('Europe/Lisbon'),
  schedule: z.strictObject({
    intervalMinutes: z.number().min(5).default(60),
    jitterMinutes: z.number().min(0).default(10),
    digestTime: hhmm.default('19:00'),
    quietHours: z.strictObject({ start: hhmm, end: hhmm }).nullable().default({ start: '23:00', end: '08:00' }),
  }),
  sources: z.record(z.string(), sourceSchema),
  http: z.strictObject({
    minDelayMs: z.number().int().min(0).default(2500),
    maxDelayMs: z.number().int().min(0).default(6000),
    timeoutMs: z.number().int().min(1000).default(20000),
    retries: z.number().int().min(0).max(5).default(2),
    userAgent: z.string().min(10),
    robotsTxt: z.enum(['warn', 'enforce', 'off']).default('warn'),
  }),
  details: z.strictObject({ maxPerRun: z.number().int().min(0).default(40) }),
  criteria: z.strictObject({
    municipalities: z.array(z.string().min(1)).min(1),
    typology: z.strictObject({ min: z.number().int().min(0), max: z.number().int().min(0) }),
    maxRent: z.record(z.string().regex(/^(T\d+|default)$/), z.number().positive()).refine((r) => 'default' in r, {
      message: 'maxRent needs a "default" entry',
    }),
    dealBreakers: z.strictObject({ shortTerm: z.boolean(), sharedRoom: z.boolean() }),
    unknown: z.strictObject({
      municipality: z.enum(['flag', 'exclude']).default('flag'),
      price: z.enum(['flag', 'exclude']).default('flag'),
      typology: z.enum(['flag', 'exclude']).default('flag'),
    }),
  }),
  scoring: z.strictObject({
    unknownFraction: fraction.default(0.5),
    weights: z.strictObject({
      commute: weight,
      rent: weight,
      registration: weight,
      typology: weight,
      furnished: weight,
      garage: weight,
      outdoor: weight,
      moveIn: weight,
    }),
    commute: z.strictObject({ fullAtMinutes: z.number().positive(), zeroAtMinutes: z.number().positive() }),
    rent: z.strictObject({ fullAt: z.number().positive(), zeroAt: z.number().positive() }),
    typology: z.record(z.string().regex(/^T\d+$/), fraction),
    furnished: z.strictObject({ yes: fraction, partial: fraction, no: fraction }),
    moveIn: z.strictObject({ from: isoDate, to: isoDate, graceDays: z.number().positive() }),
  }),
  commute: z.strictObject({
    enabled: z.boolean().default(true),
    destination: z.strictObject({ name: z.string(), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
    osrmUrl: z.url(),
    nominatimUrl: z.url(),
    trafficFactor: z.number().min(0.5).max(3).default(1.3),
  }),
  notifications: z.strictObject({
    instantMinScore: z.number().min(0).max(100),
    digestMinScore: z.number().min(0).max(100),
    maxInstantPerDay: z.number().int().min(0),
    maxDigestItems: z.number().int().min(1),
    topPicks: z.number().int().min(0),
    photos: z.number().int().min(0).max(10),
    firstRun: z.enum(['digest', 'instant']).default('digest'),
    delistCheck: z.strictObject({
      perRun: z.number().int().min(0),
      confirmations: z.number().int().min(1),
    }),
  }),
  health: z.strictObject({ failureThreshold: z.number().int().min(1).default(3) }),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const cfg = result.data;
  if (cfg.criteria.typology.min > cfg.criteria.typology.max) throw new Error('Invalid configuration: criteria.typology.min > max');
  if (cfg.scoring.commute.zeroAtMinutes <= cfg.scoring.commute.fullAtMinutes)
    throw new Error('Invalid configuration: scoring.commute.zeroAtMinutes must be greater than fullAtMinutes');
  if (cfg.scoring.rent.zeroAt <= cfg.scoring.rent.fullAt)
    throw new Error('Invalid configuration: scoring.rent.zeroAt must be greater than fullAt');
  if (cfg.notifications.digestMinScore > cfg.notifications.instantMinScore)
    throw new Error('Invalid configuration: notifications.digestMinScore must not exceed instantMinScore');
  return cfg;
}

export function loadConfig(path: string): Config {
  return parseConfig(parseYaml(readFileSync(path, 'utf8')));
}

export interface Secrets {
  botToken: string;
  allowedUserIds: number[];
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const botToken = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const ids = (env.TELEGRAM_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set (see .env.example)');
  if (ids.length === 0) throw new Error('TELEGRAM_ALLOWED_USER_IDS is not set (see .env.example)');
  const allowedUserIds = ids.map((s) => {
    if (!/^\d+$/.test(s)) throw new Error(`TELEGRAM_ALLOWED_USER_IDS contains a non-numeric value: "${s}"`);
    return Number(s);
  });
  return { botToken, allowedUserIds };
}
