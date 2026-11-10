import { ImapFlow } from 'imapflow';
import type { ButlerConfig } from '../config.js';
import type { Store } from '../store.js';
import type { GoogleAuth } from '../tools/google-auth.js';
import { errorMessage } from '../tools/tool-errors.js';
import { logError, logInfo, logWarn } from '../log.js';

export class MailWatcher {
  private readonly abort = new AbortController();
  private readonly clients = new Set<ImapFlow>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly loops: Promise<void>[];

  constructor(accounts: NonNullable<ButlerConfig['mail']>['accounts'], private readonly auth: GoogleAuth, private readonly store: Store, private readonly trigger: () => void) {
    this.loops = accounts.map(account => this.watch(account));
  }

  private notify(delaySeconds: number): void {
    if (this.abort.signal.aborted) return;
    const run = () => { try { this.trigger(); } catch (error) { logError('Mail notification trigger failed', errorMessage(error)); } };
    if (!delaySeconds) { run(); return; }
    const timer = setTimeout(() => { this.timers.delete(timer); run(); }, delaySeconds * 1000);
    this.timers.add(timer);
  }

  private async wait(ms: number): Promise<void> {
    if (this.abort.signal.aborted) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener('abort', done, { once: true });
    });
  }

  private async watch(account: { email: string; delaySeconds?: number }): Promise<void> {
    const { email } = account;
    let retry = 5000;
    let warned = false;
    while (!this.abort.signal.aborted) {
      let client: ImapFlow | undefined;
      try {
        const info = (await this.auth.accounts()).find(item => item.email === email);
        if (this.abort.signal.aborted) break;
        if (!info || info.status !== 'connected' || !info.mail) {
          if (!warned) logWarn('Mail account is not connected or lacks IMAP authorization', undefined, { account: email });
          warned = true;
          await this.wait(600_000);
          continue;
        }
        warned = false;
        const accessToken = await this.auth.accessToken(email);
        if (this.abort.signal.aborted) break;
        client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: email, accessToken }, logger: false });
        this.clients.add(client);
        let disconnected = false;
        let dirty = true;
        let wake: (() => void) | undefined;
        client.on('exists', () => { dirty = true; wake?.(); });
        client.on('close', () => { disconnected = true; wake?.(); });
        client.on('error', error => { if (!this.abort.signal.aborted) logWarn('Mail connection error', errorMessage(error), { account: email }); });
        await client.connect();
        const mailbox = await client.mailboxOpen('INBOX');
        const validity = mailbox.uidValidity.toString();
        const state = this.store.mailWatchState(email);
        if (!state || state.uid_validity !== validity) {
          if (state) logWarn('Mail UID validity changed; existing inbox messages will be skipped', undefined, { account: email });
          this.store.setMailWatchState(email, validity, mailbox.uidNext - 1);
        }
        retry = 5000;
        logInfo('Mail inbox connected', { account: email });
        while (!disconnected && !this.abort.signal.aborted) {
          if (!dirty) {
            await new Promise<void>(resolve => { wake = resolve; });
            wake = undefined;
            continue;
          }
          dirty = false;
          const lastUid = this.store.mailWatchState(email)!.last_uid;
          let accepted = false;
          try {
            const messages = await client.fetchAll(`${lastUid + 1}:*`, { uid: true, envelope: true, internalDate: true, emailId: true, headers: ['Authentication-Results'] }, { uid: true });
            for (const message of messages.sort((a, b) => a.uid - b.uid)) {
              if (message.uid <= lastUid) continue;
              if (!message.emailId || !/^\d+$/.test(message.emailId) || !message.internalDate) throw new Error(`Incomplete Gmail message data for UID ${message.uid}`);
              const hexId = BigInt(message.emailId).toString(16);
              const from = message.envelope?.from?.map(item => item.name ? `${item.name} <${item.address ?? ''}>` : item.address ?? '').join(', ') || 'unknown';
              const header = message.headers?.toString('utf8').replace(/\r?\n[ \t]+/g, ' ') ?? '';
              const auth = ['spf', 'dkim', 'dmarc'].map(method => `${method}=${header.match(new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`, 'i'))?.[1]?.toLowerCase() ?? 'unknown'}`).join(' ');
              this.store.acceptNotification({ id: `gmail:${hexId}`, source: `gmail:${email}`, title: message.envelope?.subject || '(無主旨)', body: `From: ${from}\nGmail message ID: ${hexId}\nAuthentication: ${auth}`, occurred_at: new Date(message.internalDate).toISOString() });
              this.store.setMailWatchState(email, validity, message.uid);
              accepted = true;
            }
          } finally { if (accepted) this.notify(account.delaySeconds ?? 0); }
        }
        if (!this.abort.signal.aborted) logInfo('Mail connection closed; reconnecting', { account: email });
      } catch (error) {
        if (!this.abort.signal.aborted) logError('Mail watcher failed', errorMessage(error), { fields: { account: email } });
      } finally {
        if (client) { client.close(); this.clients.delete(client); }
      }
      if (!this.abort.signal.aborted) { await this.wait(retry); retry = Math.min(retry * 2, 300_000); }
    }
  }

  async close(): Promise<void> {
    this.abort.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const client of this.clients) client.close();
    await Promise.all(this.loops);
  }
}
