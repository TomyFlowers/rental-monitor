import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import type { Config } from '../../config.js';

export interface AlertMail {
  uid: number;
  from: string;
  subject: string;
  html: string;
  raw: Buffer;
}

export interface Mailbox {
  /** Unread messages, oldest first. */
  unread(limit: number): Promise<AlertMail[]>;
  markRead(uids: number[]): Promise<void>;
}

/** Opens the mailbox for one operation and closes it again; nothing stays connected between checks. */
export class ImapMailbox implements Mailbox {
  constructor(
    private cfg: Config['email'],
    private auth: { user: string; password: string },
  ) {}

  private async withFolder<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({ host: this.cfg.host, port: this.cfg.port, secure: true, auth: { user: this.auth.user, pass: this.auth.password }, logger: false });
    client.on('error', () => undefined); // surfaced through the awaited calls below
    await client.connect();
    try {
      const lock = await client.getMailboxLock(this.cfg.folder);
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async unread(limit: number): Promise<AlertMail[]> {
    return this.withFolder(async (client) => {
      const found = await client.search({ seen: false }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).sort((a, b) => a - b).slice(0, limit);
      if (uids.length === 0) return [];
      const out: AlertMail[] = [];
      for (const msg of await client.fetchAll(uids, { uid: true, source: true }, { uid: true })) {
        if (!msg.source) continue;
        const mail = await PostalMime.parse(msg.source);
        out.push({ uid: msg.uid, from: (mail.from?.address ?? '').toLowerCase(), subject: mail.subject ?? '', html: mail.html ?? (mail.text ? `<pre>${mail.text.replace(/</g, '&lt;')}</pre>` : ''), raw: msg.source });
      }
      return out.sort((a, b) => a.uid - b.uid);
    });
  }

  async markRead(uids: number[]): Promise<void> {
    if (uids.length === 0) return;
    await this.withFolder(async (client) => {
      await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
    });
  }
}
