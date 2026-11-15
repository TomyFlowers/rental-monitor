import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

export type { Logger };

/** Console output plus a daily-rotated log file (14 files kept). */
export function createLogger(logDir: string | null, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  if (!logDir) return pino({ level });
  mkdirSync(logDir, { recursive: true });
  const transport = pino.transport({
    targets: [
      { target: 'pino/file', level, options: { destination: 1 } },
      {
        target: 'pino-roll',
        level,
        options: { file: join(logDir, 'rental-monitor'), extension: '.log', frequency: 'daily', dateFormat: 'yyyy-MM-dd', limit: { count: 14 }, mkdir: true },
      },
    ],
  });
  return pino({ level, timestamp: pino.stdTimeFunctions.isoTime }, transport);
}

export const silentLogger: Logger = pino({ level: 'silent' });
