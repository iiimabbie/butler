import type { ConversationRetainPayload } from './hindsight.js';
import type { MessageSource, StoredMessage } from './store.js';

const CONVERSATION_CONTEXT = "Event and state records in a JSON array. Records may cover unrelated topics; sharing a document does not establish topic continuity or a reply relationship. speaker_id is the original speaker's stable account ID (without dc:); speaker_name is that account's observed display name, not a separate identity. content is the original speaker's text, including actions, experiences, statements, plans, or quotations; the speaker is not necessarily every action's actor. time is when the record was made, in Asia/Taipei (UTC+08:00), YYYY-MM-DD, HH:mm, with minute precision. message_id identifies the source record. channel_id identifies its source space; when omitted, document metadata default_channel_id applies. reply_to_message_id locates a referenced record, not its contents or a guaranteed addressee; missing referenced contents are unavailable. forwarded_by_id/forwarded_by_name identify the forwarder. forwarded_message contains the original source's speaker_id, speaker_name, content, time, channel_id, message_id, and attachments when available; missing source fields cannot be supplied by the forwarder's identity. A native forward is not a reply. attachments is an array of attachment metadata: filename is the file name, mimeType is the media type, status is the local preparation status, and optional memory_document_id identifies its separate memory document; this metadata does not expose unread file contents. Butler-generated replies provide system-origin records, distinct from external participants' own statements; external accounts remain distinct regardless of whether human or bot. Delivered Butler segments are separate records unless consecutive bot messages reply to the same known target; merged records retain only the first message_id and minute-level time.";

type Turn = Record<string, unknown> & { _authorId?: string; _actualChannelId?: string; _replyTarget?: string; _bot?: boolean; _mergeable?: boolean };

export function buildConversationPayload(operationId: string, channelId: string, sessionId: string, messages: readonly StoredMessage[]): ConversationRetainPayload {
  const turns: Turn[] = messages.flatMap(message => {
    const source = message.source;
    if (source.sourceKind === 'scheduled_input' || source.sourceKind === 'notification' || source.sourceKind === 'session_handoff') return [];
    const isButlerMessage = source.sourceKind === 'butler_reply' || source.sourceKind === 'butler_tool_message';
    if (!isButlerMessage) return [externalTurn(message, channelId)];
    if (!message.discordSegments.length) throw new Error(`Butler message ${message.id} has no successfully delivered Discord segments`);
    return message.discordSegments.map((segment, index) => ({
      ...(source.authorId ? { speaker_id: source.authorId } : {}), ...(source.authorName ? { speaker_name: source.authorName } : {}),
      content: segment.content, time: formatTime(segment.eventTime), message_id: segment.messageId,
      ...(segment.channelId !== channelId ? { channel_id: segment.channelId } : {}),
      ...(index === 0 && message.attachments.length ? { attachments: attachmentMetadata(message) } : {}),
      _authorId: source.authorId, _actualChannelId: segment.channelId,
      _replyTarget: segment.replyToMessageId ?? (source.sourceKind === 'butler_reply' && index > 0 && message.discordSegments[0]?.channelId === segment.channelId ? message.discordSegments[0]?.replyToMessageId : undefined), _bot: true, _mergeable: !source.forwardedMessage,
    }));
  });
  const combined = mergeBotTurns(turns);
  const clean = combined.map(({ _authorId, _actualChannelId, _replyTarget, _bot, _mergeable, ...turn }) => turn);
  return { async: true, operation_id: operationId, items: [{ document_id: `butler:discord:${channelId}:${sessionId}`, update_mode: 'append', timestamp: 'unset', context: CONVERSATION_CONTEXT, metadata: { document_type: 'discord_conversation', default_channel_id: channelId, session_id: sessionId, format_version: '4', timezone: 'Asia/Taipei' }, tags: ['butler', 'discord'], observation_scopes: 'shared', content: JSON.stringify(clean) }] };
}

function externalTurn(message: StoredMessage, defaultChannelId: string): Turn {
  const source = message.source;
  const attachments = attachmentMetadata(message);
  const forwarded = source.forwardedMessage;
  const base: Turn = {
    ...(source.authorId ? { speaker_id: source.authorId } : {}), ...(source.authorName ? { speaker_name: source.authorName } : {}),
    content: message.content, time: formatTime(source.eventTime ?? message.createdAt),
    ...(source.channelId && source.channelId !== defaultChannelId ? { channel_id: source.channelId } : {}),
    ...(source.discordMessageId ? { message_id: source.discordMessageId } : {}),
    ...(source.replyToMessageId && !isBotSource(source) ? { reply_to_message_id: source.replyToMessageId } : {}),
    ...(attachments.length ? { attachments } : {}),
    _authorId: source.authorId, _actualChannelId: source.channelId ?? defaultChannelId, _replyTarget: source.replyToMessageId, _bot: isBotSource(source), _mergeable: !forwarded,
  };
  if (!forwarded) return base;
  const { speaker_id: _speakerId, speaker_name: _speakerName, content: _content, attachments: _attachments, ...forwardBase } = base;
  return { ...forwardBase, ...(source.authorId ? { forwarded_by_id: source.authorId } : {}), ...(source.authorName ? { forwarded_by_name: source.authorName } : {}), _mergeable: false,
    forwarded_message: { ...(forwarded.authorId ? { speaker_id: forwarded.authorId } : {}), ...(forwarded.authorName ? { speaker_name: forwarded.authorName } : {}), ...(forwarded.channelId ? { channel_id: forwarded.channelId } : {}), ...(forwarded.discordMessageId ? { message_id: forwarded.discordMessageId } : {}), ...(forwarded.eventTime ? { time: formatTime(forwarded.eventTime) } : {}), ...(forwarded.content ? { content: forwarded.content } : {}), ...(attachments.length ? { attachments } : {}) } };
}

function mergeBotTurns(turns: Turn[]): Turn[] {
  const result: Turn[] = [];
  for (const current of turns) {
    const previous = result.at(-1);
    if (previous && current._authorId && previous._authorId && current._bot && previous._bot && current._mergeable && previous._mergeable && current._authorId === previous._authorId && current._actualChannelId === previous._actualChannelId && current._replyTarget && current._replyTarget === previous._replyTarget) {
      previous.content = `${String(previous.content)}\n${String(current.content)}`;
      if (Array.isArray(current.attachments)) previous.attachments = [...(Array.isArray(previous.attachments) ? previous.attachments : []), ...current.attachments];
    } else result.push(current);
  }
  return result;
}
function isBotSource(source: MessageSource): boolean { return source.isBot === true || source.sourceKind === 'butler_reply' || source.sourceKind === 'butler_tool_message'; }
function formatTime(value: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}, ${part('hour')}:${part('minute')}`;
}
function attachmentMetadata(message: StoredMessage): Array<{ filename: string; mimeType: string; status: string; memory_document_id?: string }> { return message.attachments.map(({ filename, mimeType, status, memoryDocumentId }) => ({ filename, mimeType, status, ...(memoryDocumentId ? { memory_document_id: memoryDocumentId } : {}) })); }
