import { ToolUsageError } from './tool-errors.js';
import type { Store } from './store.js';

export interface TranscriptEntry {
  id: string;
  sessionId: string;
  channelId: string;
  discordMessageId: string;
  authorId: string;
  authorName: string;
  timestamp: string;
  content: string;
  replyToMessageId: string | null;
}

export interface TranscriptPage {
  date: string;
  timezone: string;
  total_messages: number;
  total_length: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  transcript: string;
}

export function validateTranscriptDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ToolUsageError('date must be a valid YYYY-MM-DD date');
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year!, month! - 1, day!);
  if (parsed.toISOString().slice(0, 10) !== value) throw new ToolUsageError('date must be a valid YYYY-MM-DD date');
  return value;
}

export function transcriptCandidateWindow(date: string): { start: string; end: string } {
  const [year, month, day] = date.split('-').map(Number);
  const start = new Date(0);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCFullYear(year!, month! - 1, day! - 1);
  const end = new Date(start.getTime() + 3 * 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function formatTranscript(store: Store, dateValue: unknown, timezone: string, offset: number, limit: number): TranscriptPage {
  const date = validateTranscriptDate(dateValue);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  });
  const { start, end } = transcriptCandidateWindow(date);
  const candidates = store.transcriptCandidates(start, end);
  // Reply targets name who "you" means; Discord replies often carry no mention in the text.
  const authorsByMessage = new Map(candidates.map(entry => [entry.discordMessageId, entry.authorName || entry.authorId]));
  const entries = candidates
    .map((entry, stableOrder) => ({ ...entry, milliseconds: Date.parse(entry.timestamp), stableOrder }))
    .filter(entry => store.memoryWriteAllowed(entry.channelId) && Number.isFinite(entry.milliseconds) && partsDate(formatter, new Date(entry.milliseconds)) === date)
    .sort((a, b) => a.channelId.localeCompare(b.channelId) || a.milliseconds - b.milliseconds || a.stableOrder - b.stableOrder);
  const channelGroups = new Map<string, string[]>();
  for (const entry of entries) {
    const localTime = formatter.formatToParts(new Date(entry.milliseconds));
    const time = `${part(localTime, 'year')}-${part(localTime, 'month')}-${part(localTime, 'day')} ${part(localTime, 'hour')}:${part(localTime, 'minute')}:${part(localTime, 'second')} ${part(localTime, 'timeZoneName')}`;
    const messages = channelGroups.get(entry.channelId) ?? [];
    messages.push(`[${time}] 作者：${entry.authorName || entry.authorId}（${entry.authorId}）｜Discord 訊息：${entry.discordMessageId}${entry.replyToMessageId ? `｜回覆 ${authorsByMessage.get(entry.replyToMessageId) ?? '範圍外'} 的訊息：${entry.replyToMessageId}` : ''}\n${entry.content}`);
    channelGroups.set(entry.channelId, messages);
  }
  const transcript = [...channelGroups]
    .map(([channelId, messages]) => `=== 頻道：${channelId} ===\n${messages.join('\n\n')}`)
    .join('\n\n');
  const pageOffset = Math.min(offset, transcript.length);
  const pageEnd = Math.min(pageOffset + limit, transcript.length);
  return {
    date, timezone, total_messages: entries.length, total_length: transcript.length,
    offset: pageOffset, has_more: pageEnd < transcript.length,
    next_offset: pageEnd < transcript.length ? pageEnd : null,
    transcript: transcript.slice(pageOffset, pageEnd),
  };
}

function partsDate(formatter: Intl.DateTimeFormat, date: Date): string {
  const parts = formatter.formatToParts(date);
  return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find(item => item.type === type)?.value ?? '';
}
