import type { ConversationRetainPayload } from './hindsight.js';
import type { StoredMessage } from './store.js';

const CONVERSATION_CONTEXT = 'Discord conversation. speaker_id is the stable Discord account identifier dc:<ID>, regardless of whether the account is human or bot; it identifies an account, not a verified natural person. speaker_name is a readable observed name, not identity proof; prefer it when referring to a speaker. Distinguish speakers from people they discuss, and direct statements from inference. time is when the message was sent, not when a described event happened. A scheduled_input event records an instruction triggered at its time; requested_by identifies its creator but does not mean that person spoke at that time. reply_to is only a locator; if the referenced message is absent, do not infer its text or the referent of a short reply. Attachment metadata does not reveal unread contents.';

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
    if (!isButlerMessage) return [externalTurn(message)];
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
        time: segments[0]!.eventTime,
        channel_id: deliveredChannelId,
        message_ids: segments.map(segment => segment.messageId),
        message_times: segments.map(segment => segment.eventTime),
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
      metadata: { document_type: 'discord_conversation', channel_id: channelId, session_id: sessionId, format_version: '2' },
      tags: ['butler', 'discord'],
      content: JSON.stringify(turns),
    }],
  };
}

function externalTurn(message: StoredMessage): Record<string, unknown> {
  const source = message.source;
  return {
    speaker_id: source.authorId ? `dc:${source.authorId}` : undefined,
    ...(source.authorName ? { speaker_name: source.authorName } : {}),
    content: message.content,
    time: source.eventTime ?? message.createdAt,
    ...(source.channelId ? { channel_id: source.channelId } : {}),
    ...(source.discordMessageId ? { message_id: source.discordMessageId } : {}),
    ...(source.replyToMessageId ? { reply_to: { message_id: source.replyToMessageId, ...(source.replyToChannelId ? { channel_id: source.replyToChannelId } : {}) } } : {}),
    ...(attachmentMetadata(message).length ? { attachments: attachmentMetadata(message) } : {}),
  };
}

function attachmentMetadata(message: StoredMessage): Array<{ filename: string; mimeType: string; size: number; status: string }> {
  return message.attachments.map(({ filename, mimeType, size, status }) => ({ filename, mimeType, size, status }));
}
