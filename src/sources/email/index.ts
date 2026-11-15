import type { Config } from '../../config.js';
import type { Listing } from '../../core/types.js';
import type { ListingFeed } from '../../pipeline/monitor.js';
import type { Mailbox } from './imap.js';
import { extractListings } from './parse.js';

export function fromAllowedSender(from: string, senders: string[]): boolean {
  const domain = from.split('@').pop() ?? '';
  return senders.some((s) => domain === s.toLowerCase() || domain.endsWith(`.${s.toLowerCase()}`));
}

/**
 * Turns saved-search alert emails into listings. Used for sites that refuse
 * automated page requests (OLX, Idealista): the site sends the alert itself,
 * and this only reads the mailbox it was sent to.
 */
export class EmailAlertFeed implements ListingFeed {
  readonly name = 'email';

  constructor(
    private cfg: Config['email'],
    private municipalities: string[],
    private mailbox: Mailbox,
  ) {}

  async fetch(now: Date): Promise<{ listings: Listing[]; note: string | null }> {
    const mails = await this.mailbox.unread(this.cfg.maxMessagesPerRun);
    const relevant = mails.filter((m) => fromAllowedSender(m.from, this.cfg.senders));
    const seen = new Map<string, Listing>();
    let empty = 0;
    for (const mail of relevant) {
      const { listings } = extractListings(mail.html, this.municipalities, now);
      if (listings.length === 0) empty++;
      for (const l of listings) seen.set(`${l.source}:${l.sourceId}`, l);
    }
    // Mail from anyone else is left untouched and unread.
    if (this.cfg.markRead) await this.mailbox.markRead(relevant.map((m) => m.uid));
    const note = relevant.length === 0 ? null : `${relevant.length} alert email(s)${empty ? `, ${empty} with no recognisable listing links` : ''}`;
    return { listings: [...seen.values()], note };
  }
}
