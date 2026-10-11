import type { ConversationRetainPayload } from './hindsight.js';
import type { MessageSource, StoredMessage } from './store.js';

const CONVERSATION_CONTEXT = "Shared Discord conversation history. speaker_id (raw Discord ID without dc:) is the canonical account identity; speaker_name is its observed, human-readable display name, not a separate identity. Use these fields to distinguish speakers and correctly associate statements with the people or subjects they describe. Remember useful conversational information naturally without adding unnecessary disclaimers about personal confirmation or evidence quality. Distinguish statements, opinions, plans, and interpretations without confusing their sources. time records when a message was sent, not necessarily when an event occurred. Times use Asia/Taipei in YYYY-MM-DD, HH:mm (24-hour, minute precision), independent of host settings. A turn without channel_id uses document metadata default_channel_id; an explicit channel_id overrides it. Each Butler delivered segment is represented separately unless consecutive bot messages reply to the same known target; merged turns preserve the first message_id and minute-level time only. forwarded_by_id/forwarded_by_name identify the forwarder; forwarded_message speaker fields, when available, identify its original source, and missing source fields must not be inferred from the forwarder. A native forward is not a reply. A scheduled_input event represents a scheduled instruction; requested_by identifies its creator, not a speaker at the trigger time. reply_to_message_id identifies a referenced message; do not invent missing referenced content. Attachment metadata does not reveal unread attachment contents. A Discord account ID is an account identifier, not verification of a natural person's identity. Distinguish Butler-generated replies as system context from external speakers' own statements; other speaker accounts remain distinct regardless of whether they are human or bot. A reply locator does not establish the referent of a short reply when the referenced message is absent.";

type Turn = Record<string, unknown> & { _authorId?: string; _actualChannelId?: string; _replyTarget?: string; _bot?: boolean; _mergeable?: boolean };

export function buildConversationPayload(operationId: string, channelId: string, sessionId: string, messages: readonly StoredMessage[]): ConversationRetainPayload {
  const turns: Turn[] = messages.flatMap(message => {
    const source = message.source;
    if (source.sourceKind === 'scheduled_input') return [{ event: 'scheduled_input', ...(source.authorId ? { requested_by: source.authorId } : {}), time: formatTime(source.eventTime ?? message.createdAt), content: message.content }];
    const isButlerMessage = source.sourceKind === 'butler_reply' || source.sourceKind === 'butler_tool_message';
    if (!isButlerMessage) return [externalTurn(message, channelId)];
    if (!message.discordSegments.length) throw new Error(`Butler message ${message.id} has no successfully delivered Discord segments`);
    return message.discordSegments.map((segment, index) => ({
      ...(source.authorId ? { speaker_id: source.authorId } : {}), ...(source.authorName ? { speaker_name: source.authorName } : {}),
      content: segment.content, time: formatTime(segment.eventTime), message_id: segment.messageId,
      ...(segment.channelId !== channelId ? { channel_id: segment.channelId } : {}),
      ...(segment.replyToMessageId && !isBotSource(source) ? { reply_to_message_id: segment.replyToMessageId } : {}),
      ...(index === 0 && message.attachments.length ? { attachments: attachmentMetadata(message) } : {}),
      _authorId: source.authorId, _actualChannelId: segment.channelId,
      _replyTarget: segment.replyToMessageId ?? (source.sourceKind === 'butler_reply' && index > 0 && message.discordSegments[0]?.channelId === segment.channelId ? message.discordSegments[0]?.replyToMessageId : undefined), _bot: true, _mergeable: !source.forwardedMessage,
    }));
  });
  const combined = mergeBotTurns(turns);
  const clean = combined.map(({ _authorId, _actualChannelId, _replyTarget, _bot, _mergeable, ...turn }) => turn);
  return { async: true, operation_id: operationId, items: [{ document_id: `butler:discord:${channelId}:${sessionId}`, update_mode: 'append', timestamp: 'unset', context: CONVERSATION_CONTEXT, metadata: { document_type: 'discord_conversation', default_channel_id: channelId, session_id: sessionId, format_version: '4', timezone: 'Asia/Taipei' }, tags: ['butler', 'discord'], content: JSON.stringify(clean) }] };
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
function attachmentMetadata(message: StoredMessage): Array<{ filename: string; mimeType: string; size: number; status: string; memory_document_id?: string }> { return message.attachments.map(({ filename, mimeType, size, status, memoryDocumentId }) => ({ filename, mimeType, size, status, ...(memoryDocumentId ? { memory_document_id: memoryDocumentId } : {}) })); }
