import type { Store, MessageSource, StoredMessage } from './store.js';

export interface DeploymentResultEventRow {
  id: string; deployment_id: string; parent_session_id: string; channel_id: string; requester_id?: string | null;
  result_json?: string | null; attempts?: number;
}
export interface DeploymentNotificationDependencies {
  ask: (input: StoredMessage, content: string, options: { notificationOnly: true; deploymentId: string; readDeploymentStatus: () => unknown; onResponseReady: (text: string) => Promise<void> }) => Promise<void>;
  send: (channelId: string, content: string, onAttempt?: () => void) => Promise<{ messageId: string; sent?: unknown }>;
  recordOutgoing?: (sessionId: string, content: string, sent: unknown) => void;
  logSupplementError?: (error: unknown) => void;
  now?: () => number;
}

export async function processDeploymentResultEvent(store: Store, event: DeploymentResultEventRow, dependencies: DeploymentNotificationDependencies): Promise<boolean> {
  const eventId = String(event.id), deploymentId = String(event.deployment_id);
  if (!store.claimDeploymentEvent(eventId)) return false;
  const session = String(event.parent_session_id), channel = String(event.channel_id);
  let sendAttempted = false, delivered = false, messageId: string | undefined;
  try {
    const latest = store.deploymentResultEvidence(deploymentId);
    if (!latest) throw new Error('Deployment result record is unavailable');
    const evidence = latest.result_json ? JSON.parse(latest.result_json) as Record<string, unknown> : { status: latest.status };
    const content = `Internal deployment-result notice for deployment_id=${deploymentId}. Read the persistent result below and produce a natural, concise Traditional Chinese notification of the recorded outcome. If necessary, first use deployment_result_status to verify this deployment's latest persistent status. Do not claim that completion proves current service health. Do not deploy, modify files, or perform unrelated actions. If the evidence is insufficient, say so accurately. Persistent result: ${JSON.stringify(evidence)}`;
    const input = store.deploymentEventInput(eventId, session, content, { sourceKind: 'deployment_result', channelId: channel, authorId: typeof event.requester_id === 'string' ? event.requester_id : undefined } satisfies MessageSource);
    await dependencies.ask(input, content, {
      notificationOnly: true,
      deploymentId,
      readDeploymentStatus: () => {
        const current = store.deploymentResultEvidence(deploymentId);
        if (!current) throw new Error('Bound deployment result is unavailable');
        return current;
      },
      onResponseReady: async text => {
        if (!text || text.includes('[no_reply]')) throw new Error('Deployment event produced no user notification');
        const sent = await dependencies.send(channel, text, () => { sendAttempted = true; });
        messageId = sent.messageId;
        if (!messageId) throw new Error('Discord send result did not return a message ID');
        store.setDeploymentEvent(eventId, 'delivered', undefined, messageId);
        delivered = true;
        try { dependencies.recordOutgoing?.(session, text, sent.sent); }
        catch (error) { dependencies.logSupplementError?.(error); }
      },
    });
    if (!delivered) throw new Error('Deployment event produced no deliverable assistant response');
    return true;
  } catch (error) {
    if (delivered) {
      dependencies.logSupplementError?.(error);
      return true;
    }
    const attempts = Number(event.attempts ?? 0) + 1;
    const ambiguous = sendAttempted;
    const retryable = !ambiguous && attempts < 5;
    store.setDeploymentEvent(eventId, ambiguous || !retryable ? 'needs_reconciliation' : 'failed_unknown', undefined, messageId,
      retryable ? new Date((dependencies.now?.() ?? Date.now()) + Math.min(3600000, 5000 * 2 ** Math.min(attempts, 9))).toISOString() : undefined);
    throw error;
  }
}
