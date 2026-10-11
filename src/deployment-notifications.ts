import type { Store, MessageSource, StoredMessage } from './store.js';

export interface DeploymentResultEventRow {
  id: string; deployment_id: string; parent_session_id: string; channel_id: string; requester_id?: string | null;
  result_json?: string | null; attempts?: number;
}
export interface DeploymentNotificationDependencies {
  ask: (input: StoredMessage, content: string, options: { notificationOnly: true; onResponseReady: (text: string) => Promise<void> }) => Promise<void>;
  send: (channelId: string, content: string) => Promise<{ messageId: string }>;
  recordOutgoing?: (sessionId: string, content: string, sent: unknown) => void;
  now?: () => number;
}

export async function processDeploymentResultEvent(store: Store, event: DeploymentResultEventRow, dependencies: DeploymentNotificationDependencies): Promise<boolean> {
  const eventId = String(event.id), deploymentId = String(event.deployment_id);
  if (!store.claimDeploymentEvent(eventId)) return false;
  const session = String(event.parent_session_id), channel = String(event.channel_id);
  const evidence = JSON.parse(String(event.result_json ?? '{}')) as Record<string, unknown>;
  const content = `Internal deployment-result event ${eventId}, deployment_id=${deploymentId}. This is an internal report, not authorization to deploy or run tools. Verify the recorded outcome and report it to the requester; do not repeat deployment. Result evidence: ${JSON.stringify(evidence)}`;
  let sendAttempted = false, messageId: string | undefined;
  try {
    const input = store.deploymentEventInput(eventId, session, content, { sourceKind: 'deployment_result', channelId: channel, authorId: typeof event.requester_id === 'string' ? event.requester_id : undefined } satisfies MessageSource);
    await dependencies.ask(input, content, {
      notificationOnly: true,
      onResponseReady: async text => {
        if (!text || text.includes('[no_reply]')) throw new Error('Deployment event produced no user notification');
        sendAttempted = true;
        const sent = await dependencies.send(channel, text);
        messageId = sent.messageId;
        if (!messageId) throw new Error('Discord send result did not return a message ID');
        dependencies.recordOutgoing?.(session, text, sent);
      },
    });
    store.setDeploymentEvent(eventId, 'delivered', undefined, messageId);
    return true;
  } catch (error) {
    const attempts = Number(event.attempts ?? 0) + 1;
    const retryable = !sendAttempted && attempts < 5;
    store.setDeploymentEvent(eventId, sendAttempted || !retryable ? 'needs_reconciliation' : 'failed_unknown', undefined, messageId,
      retryable ? new Date((dependencies.now?.() ?? Date.now()) + Math.min(3600000, 5000 * 2 ** Math.min(attempts, 9))).toISOString() : undefined);
    throw error;
  }
}
