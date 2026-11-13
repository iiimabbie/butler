import { randomUUID } from 'node:crypto';
import { loadWorkspaceContext } from './context.js';
import { logTrace } from './model-request.js';
import { logWarn } from '../log.js';
import { countContextTokens, estimateContextTokens } from './context-budget.js';
import { compactLiveGroups, compactSession } from './compaction.js';
import { emitProgress } from './progress.js';
import { promptPrefix } from './prompt-prefix.js';
import type { prepareAsk } from './ask-transcript.js';
import type { Store } from '../store.js';
import type { AgentConfig } from './agent.js';

const recentCount = 10;

/** Compacts when the predicted request is near the model limit and returns the figures the usage sample is stored with; throws when the request still cannot fit. */
export async function fitContext(store: Store, session: string, config: AgentConfig, prepared: Awaited<ReturnType<typeof prepareAsk>>, turn: number): Promise<{ localEstimate: number; limit: number; limitSource: 'known model limit' | 'configured budget' }> {
  const { transcript, storedHistory, currentIndex } = prepared;
  let localEstimate = 0;
  const knownModelLimit = config.modelContextTokens?.[config.model];
  const limit = knownModelLimit ?? config.maxContextTokens ?? 150000;
  // The last measured usage plus the growth since then; a counted value when this model has no measurement yet.
  const predictInputTokens = async (): Promise<number> => {
    localEstimate = estimateContextTokens(transcript.input, prepared.tools);
    const prior = store.contextUsage(session);
    if (prior && prior.model === config.model && prior.baseUrl === config.baseUrl) return Math.max(0, prior.inputTokens + localEstimate - prior.localCount);
    return countContextTokens({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, input: transcript.input, tools: prepared.tools });
  };
  let predicted = await predictInputTokens();
  let percent = Math.round(predicted / limit * 1000) / 10;
  // Compact history at 65% before the first request, leaving room for this ask's tool output so live compaction stays rare.
  if (percent >= 65 && turn === 0) {
    const safeBoundary = currentIndex > 0 ? storedHistory[currentIndex - 1]?.id : undefined;
    if (safeBoundary) {
      const progress = compactionProgress(config, 'compact_session');
      try {
        const previousCheckpoint = store.compactCheckpoint(session)?.throughMessageId;
        const compactResult = await compactSession(store, session, { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, reasoningEffort: config.reasoningEffort, throughMessageId: safeBoundary, onStart: progress.start });
        const checkpoint = store.compactCheckpoint(session);
        if (checkpoint && checkpoint.throughMessageId !== previousCheckpoint && compactResult.compressedMessages > 0) {
          store.clearContextUsage(session);
          // The checkpoint dropped the workspace snapshot and this request misses the cache anyway, so re-read the files now instead of breaking the cache again next ask.
          const workspace = await loadWorkspaceContext(config.workspaceDirectory);
          store.saveWorkspaceSnapshot(session, workspace);
          transcript.stableInput = [...(await promptPrefix(config, workspace)).input, ...prepared.openingInput, { role: 'user', content: `Prior conversation summary (historical background):\n${checkpoint.summary}` }];
          const checkpointIndex = storedHistory.findIndex(message => message.id === checkpoint.throughMessageId);
          const retained = transcript.liveGroups.filter(group => group.messageId === undefined || storedHistory.findIndex(message => message.id === group.messageId) > checkpointIndex);
          transcript.liveGroups.splice(0, transcript.liveGroups.length, ...retained);
          transcript.rebuild();
          predicted = await predictInputTokens();
          percent = Math.round(predicted / limit * 1000) / 10;
        }
        progress.end('completed');
      } catch (error) {
        logWarn(`Automatic persistent compaction failed session=${session}`, error);
        progress.end('failed');
      }
    }
  }
  // Live compaction rewrites the cached prefix, so it is only an emergency pass near the limit.
  if (percent >= 95) {
    // Keep the normal recent window unless it cannot fit. Emergency passes
    // summarize complete older groups, never protected inputs or the latest group.
    // These are summary-only requests: completed tools are never replayed.
    for (const keepRecent of [recentCount, 5, 2, 1]) {
      if (keepRecent !== recentCount && percent < 100) break;
      const beforeTokens = predicted;
      const beforeGroups = transcript.liveGroups.length;
      const progress = compactionProgress(config, 'compact_live_groups');
      try {
        const compacted = await compactLiveGroups({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, reasoningEffort: config.reasoningEffort, groups: transcript.liveGroups, keepRecent, existingSummary: transcript.liveSummary.content, onStart: progress.start });
        if (compacted.summary) {
          store.clearContextUsage(session);
          transcript.liveSummary.content = `Earlier completed in-memory interaction summary (volatile tool evidence; not a persistent checkpoint):\n${compacted.summary}`;
          transcript.liveGroups.splice(0, transcript.liveGroups.length, ...compacted.retained);
          transcript.rebuild();
          predicted = await predictInputTokens();
          percent = Math.round(predicted / limit * 1000) / 10;
        }
        logTrace('context_live_compaction', { askId: config.askId, traceId: config.traceId, sessionId: session, turn, keepRecent, beforeTokens, afterTokens: predicted, beforeGroups, afterGroups: transcript.liveGroups.length, pressure: percent, budget: limit, summarized: Boolean(compacted.summary) });
        progress.end('completed');
      } catch (error) {
        logWarn(`Automatic live compaction failed session=${session}`, error);
        progress.end('failed');
        // An unknown summary outcome must not trigger an automatic retry.
        break;
      }
    }
  }
  if (percent >= 100) throw new Error(`Context estimate is ${percent}% of the ${knownModelLimit ? 'model limit' : 'configured budget'}; stopping before request.`);
  return { localEstimate, limit, limitSource: knownModelLimit ? 'known model limit' : 'configured budget' };
}

function compactionProgress(config: AgentConfig, toolName: string): { start: () => void; end: (status: 'completed' | 'failed') => void } {
  const callId = randomUUID();
  let started = false;
  // Starts only once the compactor has something to summarize, so a no-op pass leaves no row.
  const start = () => { started = true; emitProgress(config, { type: 'tool_start', callId, toolName }); };
  return { start, end: status => { if (started) emitProgress(config, { type: 'tool_end', callId, toolName, status }); } };
}
