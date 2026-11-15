import type { Config } from '../config.js';
import { esc } from '../notify/format.js';
import type { RunSummary } from '../pipeline/monitor.js';
import type { Store } from '../store/db.js';

/**
 * Watches the outcome of each source check and tells the user, once, when a
 * source keeps failing, and again when it recovers.
 */
export class HealthMonitor {
  constructor(
    private cfg: Config['health'],
    private store: Store,
    private send: (html: string) => Promise<void>,
  ) {}

  async report(summaries: RunSummary[]): Promise<void> {
    for (const s of summaries) {
      const downKey = `health:down:${s.source}`;
      const degradedKey = `health:degraded:${s.source}`;
      const wasDown = this.store.get(downKey) === '1';

      if (s.ok) {
        if (wasDown) {
          this.store.set(downKey, '0');
          await this.send(`✅ <b>${esc(s.source)}</b> is working again (${s.found} listings read).`);
        }
        const degraded = s.mode === 'html';
        if (degraded && this.store.get(degradedKey) !== '1') {
          this.store.set(degradedKey, '1');
          await this.send(
            `⚠️ <b>${esc(s.source)}</b> changed its page format. Listings are still being read, but with less detail, so more values will show as unknown. The adapter needs an update.`,
          );
        } else if (!degraded && this.store.get(degradedKey) === '1') {
          this.store.set(degradedKey, '0');
        }
        continue;
      }

      const recent = this.store.recentRuns(s.source, this.cfg.failureThreshold);
      const failing = recent.length >= this.cfg.failureThreshold && recent.every((r) => !r.ok);
      if (failing && !wasDown) {
        this.store.set(downKey, '1');
        const why = s.blocked ? 'The site is refusing requests (blocked or rate-limited).' : 'The site may be down or may have changed its layout.';
        await this.send(
          `🚨 <b>${esc(s.source)}</b> has failed ${recent.length} checks in a row. ${why}\nLast error: <code>${esc((s.note ?? 'unknown').slice(0, 300))}</code>\nYou will get one message when it recovers.`,
        );
      }
    }
  }
}
