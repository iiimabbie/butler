import type { ConversationRetainPayload } from './hindsight.js';
import type { StoredMessage } from './store.js';

const CONVERSATION_CONTEXT = "Shared Discord conversation history. Each speaker_id (dc:<ID>) identifies a stable Discord account, and speaker_name provides its observed display name. Use these fields to distinguish speakers and correctly associate statements with the people or subjects they describe. Remember useful conversational information naturally without adding unnecessary disclaimers about personal confirmation or evidence quality. Distinguish statements, opinions, plans, and interpretations without confusing their sources. time records when a message was sent, not necessarily when an event occurred. A turn without channel_id uses document metadata default_channel_id; an explicit channel_id overrides it. For bot turns, messages[].time records each delivered segment. A scheduled_input event represents a scheduled instruction; requested_by identifies its creator, not a speaker at the trigger time. reply_to identifies a referenced message; do not invent missing referenced content. Attachment metadata does not reveal unread attachment contents. A Discord account ID is an account identifier, not verification of a natural person's identity. Distinguish Butler-generated replies as system context from external speakers' own statements; other speaker accounts remain distinct regardless of whether they are human or bot. When a statement is anchored to its message moment, such as \"現在\", \"剛剛\", \"睡到現在\", or \"今天早上\", preserve the exact turn timestamp including time and timezone when relevant; do not reduce it to date-only. A reply locator does not establish the referent of a short reply when the referenced message is absent.";

export function buildConversationPayload(
  operationId: string,
  channelId: string,
  sessionId: string,
  messages: readonly StoredMessage[],
): ConversationRetainPayload {
  const turns = messages.flatMap(message => {
    const source = message.source;
    if (source.sourceKind === 'scheduled_input') return [{
      event: 'scheduled_input',
      ...(source.authorId ? { requested_by: `dc:${source.authorId}` } : {}),
      time: source.eventTime ?? message.createdAt,
      content: message.content,
    }];

    const isButlerMessage = source.sourceKind === 'butler_reply' || source.sourceKind === 'butler_tool_message';
    if (!isButlerMessage) return [externalTurn(message, channelId)];
    if (!message.discordSegments.length) throw new Error(`Butler message ${message.id} has no successfully delivered Discord segments`);

    const byChannel = new Map<string, typeof message.discordSegments>();
    for (const segment of message.discordSegments) {
      const group = byChannel.get(segment.channelId) ?? [];
      group.push(segment);
      byChannel.set(segment.channelId, group);
    }
    return [...byChannel].map(([deliveredChannelId, segments], index) => {
      const turn: Record<string, unknown> = {
        speaker_id: source.authorId ? `dc:${source.authorId}` : undefined,
        ...(source.authorName ? { speaker_name: source.authorName } : {}),
        content: segments.map(segment => segment.content).join('\n'),
        messages: segments.map(({ messageId, eventTime }) => ({ id: messageId, time: eventTime })),
        ...(deliveredChannelId !== channelId ? { channel_id: deliveredChannelId } : {}),
      };
      const replyTo = segments.find(segment => segment.replyToMessageId);
      if (replyTo?.replyToMessageId) turn.reply_to = {
        message_id: replyTo.replyToMessageId,
        ...(replyTo.replyToChannelId ? { channel_id: replyTo.replyToChannelId } : {}),
      };
      const attachments = index === 0 ? attachmentMetadata(message) : [];
      if (attachments.length) turn.attachments = attachments;
      return turn;
    });
  });

  return {
    async: true,
    operation_id: operationId,
    items: [{
      document_id: `butler:discord:${channelId}:${sessionId}`,
      update_mode: 'append',
      timestamp: 'unset',
      context: CONVERSATION_CONTEXT,
      metadata: { document_type: 'discord_conversation', default_channel_id: channelId, session_id: sessionId, format_version: '3' },
      tags: ['butler', 'discord'],
      content: JSON.stringify(turns),
    }],
  };
}

function externalTurn(message: StoredMessage, defaultChannelId: string): Record<string, unknown> {
  const source = message.source;
  return {
    speaker_id: source.authorId ? `dc:${source.authorId}` : undefined,
    ...(source.authorName ? { speaker_name: source.authorName } : {}),
    content: message.content,
    time: source.eventTime ?? message.createdAt,
    ...(source.channelId && source.channelId !== defaultChannelId ? { channel_id: source.channelId } : {}),
    ...(source.discordMessageId ? { message_id: source.discordMessageId } : {}),
    ...(source.replyToMessageId ? { reply_to: { message_id: source.replyToMessageId, ...(source.replyToChannelId ? { channel_id: source.replyToChannelId } : {}) } } : {}),
    ...(attachmentMetadata(message).length ? { attachments: attachmentMetadata(message) } : {}),
  };
}

function attachmentMetadata(message: StoredMessage): Array<{ filename: string; mimeType: string; size: number; status: string }> {
  return message.attachments.map(({ filename, mimeType, size, status }) => ({ filename, mimeType, size, status }));
}
