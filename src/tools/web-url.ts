import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { ToolUsageError } from './tool-errors.js';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],
  ['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],
  ['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) blocked.addSubnet(address, prefix, 'ipv6');
function isPublicWebAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

/** Preflight for external services only. This is NOT a rebinding-safe direct HTTP client. */
export async function assertPublicWebUrl(value: string, signal: AbortSignal): Promise<void> {
  const reject = () => new ToolUsageError('Only public HTTP(S) URLs without credentials or sensitive tokens may be sent to web providers');
  let url: URL;
  try { url = new URL(value); } catch { throw reject(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw reject();
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test|onion)$/.test(host)) throw reject();
  if ([...url.searchParams.keys()].some(key => /(?:token|secret|password|passwd|signature|credential|authorization|api[-_]?key|x-amz-|x-goog-|^sig$|^key$|^code$|^auth$|^session)/i.test(key))
    || /(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|\/reset-password\/|\/auth\/callback)/i.test(value)) throw reject();
  signal.throwIfAborted();
  const addresses = isIP(host) ? [{ address: host }] : await withWebSignal(lookup(host, { all: true, verbatim: true }), signal);
  if (!addresses.length || addresses.some(item => !isPublicWebAddress(item.address))) throw reject();
}

/** Also enforce deadlines against a stalled body or injected fetcher that ignores AbortSignal. */
export async function withWebSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
