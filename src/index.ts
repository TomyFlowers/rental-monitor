import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Cron } from 'croner';
import { loadConfig, loadSecrets } from './config.js';
import { CommuteEnricher } from './enrich/commute.js';
import { HealthMonitor } from './health/monitor.js';
import { PoliteHttpClient } from './http/client.js';
import { createLogger } from './logger.js';
import { Dispatcher } from './notify/dispatcher.js';
import { TelegramBot } from './notify/telegram.js';
import { Monitor } from './pipeline/monitor.js';
import { createAdapters } from './sources/registry.js';
import { Store } from './store/db.js';

async function main(): Promise<void> {
  const configPath = resolve(process.env.CONFIG_PATH ?? 'config/config.yaml');
  const dataDir = resolve(process.env.DATA_DIR ?? 'data');
  const logDir = resolve(process.env.LOG_DIR ?? 'logs');

  // Fail fast, with a readable message, before anything starts.
  const cfg = loadConfig(configPath);
  const secrets = loadSecrets();
  const log = createLogger(logDir);
  mkdirSync(dataDir, { recursive: true });

  const store = new Store(join(dataDir, 'rental-monitor.sqlite'));
  const http = new PoliteHttpClient(cfg.http, log);
  const adapters = createAdapters(http);
  for (const name of Object.keys(cfg.sources)) {
    if (!adapters.some((a) => a.name === name)) throw new Error(`config: unknown source "${name}" (known: ${adapters.map((a) => a.name).join(', ')})`);
  }
  const monitor = new Monitor(cfg, store, adapters, new CommuteEnricher(cfg.commute, http, store, log), log);
  const telegram = new TelegramBot(secrets, cfg, store, log);
  const dispatcher = new Dispatcher(cfg, store, telegram, log);
  const health = new HealthMonitor(cfg.health, store, (html) => dispatcher.system(html));

  const check = async () => {
    const summaries = await monitor.runAll();
    if (summaries) {
      await health.report(summaries).catch((err) => log.warn({ err: String(err) }, 'health report failed'));
      await dispatcher.flushInstant();
    }
    return summaries;
  };

  // Self-rescheduling timer: every interval, shifted by a random jitter, so
  // requests do not land on the sites at the same second every hour.
  let nextCheckAt: Date | null = null;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (first = false) => {
    const { intervalMinutes, jitterMinutes } = cfg.schedule;
    const delayMin = first ? 0.1 : Math.max(1, intervalMinutes + (Math.random() * 2 - 1) * jitterMinutes);
    nextCheckAt = new Date(Date.now() + delayMin * 60_000);
    timer = setTimeout(async () => {
      try {
        if (!dispatcher.paused) await check();
      } catch (err) {
        log.error({ err: String(err) }, 'scheduled check failed');
      } finally {
        schedule();
      }
    }, delayMin * 60_000);
  };

  telegram.attach({ monitor, dispatcher, checkNow: check, nextCheckAt: () => nextCheckAt });
  await telegram.start();

  // Queued alerts go out within a minute of quiet hours ending.
  const flusher = setInterval(() => void dispatcher.flushInstant().catch((err) => log.warn({ err: String(err) }, 'flush failed')), 60_000);
  const [h, m] = cfg.schedule.digestTime.split(':');
  const digest = new Cron(`${Number(m)} ${Number(h)} * * *`, { timezone: cfg.timezone }, () => {
    void dispatcher.sendDigest().catch((err) => log.error({ err: String(err) }, 'digest failed'));
  });
  schedule(true);
  log.info({ sources: Object.keys(cfg.sources), interval: cfg.schedule.intervalMinutes, digest: cfg.schedule.digestTime }, 'rental monitor running');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    clearTimeout(timer);
    clearInterval(flusher);
    digest.stop();
    await telegram.stop().catch(() => undefined);
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
