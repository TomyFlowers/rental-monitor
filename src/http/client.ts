import robotsParserModule from 'robots-parser';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

interface Robots {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}
// The package is CommonJS (module.exports = function); its typings do not say so under NodeNext.
const robotsParser = robotsParserModule as unknown as (url: string, contents: string) => Robots;

export interface HttpResponse {
  status: number;
  body: string;
  /** URL after redirects. */
  finalUrl: string;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
    /** Seconds the site asked us to wait (Retry-After), when it said. */
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
  /** The site refused us rather than failing: worth telling the user about. */
  get blocked(): boolean {
    return this.status === 403 || this.status === 429 || this.status === 401;
  }
}

export interface HttpClient {
  get(url: string, opts?: { headers?: Record<string, string>; accept?: number[] }): Promise<HttpResponse>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Small polite HTTP client: one request at a time per host with a random
 * pause between them, a timeout, limited retries with backoff, and a
 * robots.txt check.
 */
export class PoliteHttpClient implements HttpClient {
  private queues = new Map<string, Promise<unknown>>();
  private lastRequest = new Map<string, number>();
  private robots = new Map<string, Robots | null>();
  private warned = new Set<string>();

  constructor(
    private cfg: Config['http'],
    private log: Logger,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get(url: string, opts: { headers?: Record<string, string>; accept?: number[] } = {}): Promise<HttpResponse> {
    const host = new URL(url).host;
    const prev = this.queues.get(host) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.run(url, host, opts));
    this.queues.set(host, next);
    return next;
  }

  private async run(url: string, host: string, opts: { headers?: Record<string, string>; accept?: number[] }): Promise<HttpResponse> {
    await this.checkRobots(url, host);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      await this.pace(host, attempt);
      try {
        const res = await this.fetchImpl(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
          headers: {
            'user-agent': this.cfg.userAgent,
            accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'accept-language': 'pt-PT,pt;q=0.9,en;q=0.6',
            ...opts.headers,
          },
        });
        const body = await res.text();
        if (res.ok || opts.accept?.includes(res.status)) return { status: res.status, body, finalUrl: res.url || url };
        const wait = Number(res.headers.get('retry-after'));
        const err = new HttpError(`HTTP ${res.status} for ${url}`, res.status, url, Number.isFinite(wait) && wait > 0 ? wait : null);
        // Retrying a refusal or a rate limit only makes things worse; server errors may be transient.
        if (res.status < 500) throw err;
        lastErr = err;
      } catch (err) {
        if (err instanceof HttpError && err.status !== null && err.status < 500) throw err;
        lastErr = err;
      }
      this.log.debug({ url, attempt, err: String(lastErr) }, 'request failed, will retry');
    }
    if (lastErr instanceof HttpError) throw lastErr;
    throw new HttpError(`Request failed for ${url}: ${String(lastErr)}`, null, url);
  }

  private async pace(host: string, attempt: number): Promise<void> {
    const { minDelayMs, maxDelayMs } = this.cfg;
    const gap = minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs) + attempt * attempt * 5000;
    const last = this.lastRequest.get(host);
    if (last !== undefined) {
      const wait = last + gap - Date.now();
      if (wait > 0) await sleep(wait);
    }
    this.lastRequest.set(host, Date.now());
  }

  private async checkRobots(url: string, host: string): Promise<void> {
    if (this.cfg.robotsTxt === 'off') return;
    if (!this.robots.has(host)) {
      const robotsUrl = `${new URL(url).origin}/robots.txt`;
      try {
        const res = await this.fetchImpl(robotsUrl, {
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
          headers: { 'user-agent': this.cfg.userAgent },
        });
        this.robots.set(host, res.ok ? robotsParser(robotsUrl, await res.text()) : null);
      } catch {
        this.robots.set(host, null);
      }
      this.lastRequest.set(host, Date.now());
    }
    const rules = this.robots.get(host);
    if (!rules || rules.isAllowed(url, this.cfg.userAgent) !== false) return;
    if (this.cfg.robotsTxt === 'enforce') throw new HttpError(`Disallowed by robots.txt: ${url}`, null, url);
    const key = `${host}${new URL(url).pathname.split('/').slice(0, 3).join('/')}`;
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.log.warn({ url }, 'robots.txt disallows this path (http.robotsTxt is "warn", continuing)');
    }
  }
}
