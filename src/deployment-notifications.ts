import type { Store, MessageSource, StoredMessage } from './store.js';

export interface DeploymentResultEventRow {
  id: string; deployment_id: string; parent_session_id: string; channel_id: string; requester_id?: string | null;
  result_json?: string | null; attempts?: number;
}
export interface DeploymentNotificationDependencies {
  ask: (input: StoredMessage, content: string, options: { notificationOnly: true; deploymentId: string; readDeploymentStatus: () => unknown; onResponseReady: (text: string) => Promise<void> }) => Promise<void>;
  send: (channelId: string, content: string, beforeRestSend: () => boolean | Promise<boolean>) => Promise<{ messageId: string; sent?: unknown }>;
  persistSendIntent?: (eventId: string, version: string, attemptId: string) => boolean;
  canSend?: () => boolean;
  recordOutgoing?: (sessionId: string, content: string, sent: unknown) => void;
  logSupplementError?: (error: unknown) => void;
  now?: () => number;
}

const MAX_STALE_REGENERATIONS = 2;
export async function processDeploymentResultEvent(store: Store, event: DeploymentResultEventRow, dependencies: DeploymentNotificationDependencies): Promise<boolean> {
  const eventId = String(event.id), deploymentId = String(event.deployment_id);
  const claim = store.claimDeploymentEvent(eventId);
  if (!claim) return false;
  const session = String(event.parent_session_id), channel = String(event.channel_id);
  let sendAttempted = false, delivered = false, deferredByShutdown = false, messageId: string | undefined;
  try {
    for (let regeneration = 0; regeneration <= MAX_STALE_REGENERATIONS; regeneration++) {
      const latest = store.deploymentResultEvidence(deploymentId);
      if (!latest) throw new Error('Deployment result record is unavailable');
      const version = latest.version;
      const evidence = latest.result_json ? JSON.parse(latest.result_json) as Record<string, unknown> : { status: latest.status };
      const content = `Internal deployment-result notice for deployment_id=${deploymentId}. Read the persistent result below and produce a natural, concise Traditional Chinese notification of the recorded outcome. If necessary, first use deployment_result_status to verify this deployment's latest persistent status. Do not claim that completion proves current service health. Do not deploy, modify files, or perform unrelated actions. If the evidence is insufficient, say so accurately. Persistent result: ${JSON.stringify(evidence)}`;
      const input = store.deploymentEventInput(eventId, session, content, { sourceKind: 'deployment_result', channelId: channel, authorId: typeof event.requester_id === 'string' ? event.requester_id : undefined } satisfies MessageSource, version);
      let stale = false;
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
          if (!store.deploymentResultIsCurrent(eventId, version)) { stale = true; return; }
          if (dependencies.canSend && !dependencies.canSend()) {
            deferredByShutdown = true;
            store.releaseDeploymentEventBeforeSend(eventId, version, claim.attemptId);
            return;
          }
          let intentPersisted = false;
          const sent = await dependencies.send(channel, text, async () => {
            if (dependencies.canSend && !dependencies.canSend()) {
              deferredByShutdown = true;
              store.releaseDeploymentEventBeforeSend(eventId, version, claim.attemptId);
              return false;
            }
            const persisted = dependencies.persistSendIntent?.(eventId, version, claim.attemptId) ?? store.persistDeploymentSendIntent(eventId, version, claim.attemptId);
            if (!persisted) throw new Error('Could not persist deployment send intent');
            intentPersisted = true;
            sendAttempted = true;
            return true;
          });
          if (!intentPersisted) throw new Error('Discord send was not started because notification is draining');
          messageId = sent.messageId;
          if (!messageId) throw new Error('Discord send result did not return a message ID');
          store.finishDeploymentEvent(eventId, version, messageId);
          delivered = true;
          try { dependencies.recordOutgoing?.(session, text, sent.sent); }
          catch (error) { dependencies.logSupplementError?.(error); }
        },
      });
      if (delivered) return true;
      if (deferredByShutdown) return false;
      if (!stale) throw new Error('Deployment event produced no deliverable assistant response');
      if (regeneration === MAX_STALE_REGENERATIONS) throw new Error('Deployment result kept changing before notification could be sent');
    }
    throw new Error('Deployment result notification exhausted stale-result retries');
  } catch (error) {
    if (deferredByShutdown) return false;
    if (delivered) { dependencies.logSupplementError?.(error); return true; }
    const attempts = Number(claim.attempts ?? event.attempts ?? 1);
    const ambiguous = sendAttempted;
    const retryable = !ambiguous && attempts < 5;
    try {
      store.setDeploymentEvent(eventId, ambiguous || !retryable ? 'needs_reconciliation' : 'failed_unknown', undefined, messageId,
        retryable ? new Date((dependencies.now?.() ?? Date.now()) + Math.min(3600000, 5000 * 2 ** Math.min(attempts, 9))).toISOString() : undefined);
    } catch (persistenceError) { dependencies.logSupplementError?.(persistenceError); }
    throw error;
  }
}
