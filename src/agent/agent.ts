import { isRecord } from '../tools/tool-schema.js';
import { logTrace, requestTurn, responseText, isFunctionCall, traceTextMetadata, type FunctionCall } from './model-request.js';
import { buildEmptyAssistantTextDiagnostic } from './empty-assistant-text-diagnostic.js';
import { IncompleteTurnRecovery, MAX_REASONING_ONLY_CONTINUATIONS, unfinishedDelegateStatus } from './incomplete-turn-recovery.js';
import type { Store } from '../store.js';
import type { DiscordToolRuntime } from '../discord/discord-tools.js';
import type { GoogleToolRuntime } from '../tools/google-tools.js';
import type { LocalToolRuntime } from '../tools/local-tools.js';
import type { WebToolRuntime } from '../tools/web-tools.js';
import type { WeatherToolRuntime } from '../tools/weather-tools.js';
import type { SkillsToolRuntime } from '../tools/skills.js';
import type { ScheduleToolRuntime } from '../tools/schedule-tools.js';
import type { ImageToolRuntime } from '../tools/image-tools.js';
import type { HledgerRuntime } from '../tools/hledger-tools.js';
import type { ProgressEvent } from './progress.js';
import type { ReasoningEffort, StoredMessage, SessionOpeningContext } from '../store.js';
import type { Hindsight } from '../memory/hindsight.js';
import { logError } from '../log.js';
import { readOnlyTools } from '../subagent/code-mode.js';
import type { SubagentCoordinator } from '../subagent/subagent-coordinator.js';
import { prepareAsk } from './ask-transcript.js';
import { fitContext } from './context-pressure.js';
import { executeCall, hasToolError } from './tool-execution.js';

export interface AgentConfig {
  baseUrl: string;
  apiKey?: string;
  transcriptTimezone?: string;
  model: string;
  maxContextTokens?: number;
  modelContextTokens?: Record<string, number>;
  timeoutMs: number;
  askId?: string; traceId?: string;
  consumeSteer?: () => StoredMessage | undefined | Promise<StoredMessage | undefined>;
  attachmentDir?: string;
  transcription?: import('../attachments/audio-transcription.js').AudioTranscriptionConfig;
  onSteerPersisted?: (storedMessageId: string) => void;
  onAskFinishing?: () => void;
  storedInput?: StoredMessage;
  consumedSteerMessageIds?: ReadonlySet<string>;
  openingContext?: SessionOpeningContext;
  hindsight?: Hindsight;
  memoryWriteAllowed?: () => boolean;
  discordTools?: DiscordToolRuntime;
  googleTools?: GoogleToolRuntime;
  localTools?: LocalToolRuntime;
  webTools?: WebToolRuntime;
  weatherTools?: WeatherToolRuntime;
  skillsTools?: SkillsToolRuntime;
  scheduleTools?: ScheduleToolRuntime;
  imageTools?: ImageToolRuntime;
  hledgerTools?: HledgerRuntime;
  reasoningEffort?: ReasoningEffort;
  onProgress?: (event: ProgressEvent) => void;
  onResponseReady?: (text: string) => Promise<void>;
  discordContext?: { channelId: string; messageId?: string; requesterId?: string };
  workspaceDirectory?: string;
  subagent?: import('../config.js').ButlerConfig['subagent'];
  subagentCoordinator?: SubagentCoordinator;
  subagentOrigin?: { channelId: string; outputChannelId: string; entryKind: 'normal' | 'scheduled' | 'notification'; requesterId?: string; triggerInputId?: string };
  subagentEvent?: boolean;
}

export async function ask(store: Store, session: string, config: AgentConfig): Promise<string> {
  if (!store.hasSession(session)) throw new Error(`Unknown session: ${session}`);
  if (!config.storedInput) throw new Error('ask requires an already persisted input message');
  try {
    const prepared = await prepareAsk(store, session, config);
    const { transcript, storedInput, tools: availableTools, googleRuntime, initialAskContext } = prepared;
    const { input } = transcript;
    const availableToolNames: ReadonlySet<string> = new Set(availableTools.map(tool => String(tool.name)));
    // Tool calls and outputs are replayed after the message that triggered them, so later asks keep what this ask read and did.
    const toolWork = new Map<string, unknown[]>([[storedInput.id, initialAskContext]]);
    let toolOwnerId = storedInput.id;
    let forceImageSave = false;
    let imageSaveRequiredAttempted = false;
    let imageSaveSucceeded = false;
    const recovery = new IncompleteTurnRecovery();
    const recoveryReminders = new Set<unknown>();
    const resumeToolUse = (): void => {
      recovery.resumeToolUse();
      for (const reminder of recoveryReminders) transcript.removeReminder(reminder);
      recoveryReminders.clear();
    };
    const acceptSteer = async (steer: StoredMessage, turn: number, status: 'consumed' | 'consumed_late'): Promise<void> => {
      logTrace('steer_consume', { askId: config.askId, traceId: config.traceId, sessionId: session, turn, inputMessageId: steer.source.discordMessageId ?? steer.id, status });
      await transcript.appendSteer(steer);
      config.onSteerPersisted?.(steer.id);
      toolOwnerId = steer.id;
    };
    for (let turn = 0; ; turn++) {
      const steered = await config.consumeSteer?.();
      if (steered) { resumeToolUse(); await acceptSteer(steered, turn, 'consumed'); }
      const toolChoice: 'none' | { type: 'function'; name: string } | undefined = forceImageSave ? { type: 'function', name: 'image_save' } : recovery.finalTextOnly ? 'none' : undefined;
      if (forceImageSave) imageSaveRequiredAttempted = true;
      forceImageSave = false;
      const budget = await fitContext(store, session, config, prepared, turn);
      const { body, raw, requestId, httpStatus } = await requestTurn(store, session, config, { turn, input, tools: availableTools, toolChoice, hasReadyAttachments: transcript.contextMessages.some(message => message.attachments.some(file => file.status === 'ready')), localEstimate: budget.localEstimate, contextLimit: budget.limit, limitSource: budget.limitSource });
      const calls = body.output.filter(isFunctionCall);
      const nativeImages = body.output.filter(item => isRecord(item) && item.type === 'image_generation_call');
      const nativeImageNotices: unknown[] = [];
      if (nativeImages.length) {
        if (!config.imageTools) {
          throw new Error('Native image output cannot be accepted: image generation and image_save must be available; generation was not retried');
        }
        if (toolChoice !== undefined) throw new Error('Native image output arrived while tool use was restricted; it was not accepted and generation was not retried');
        for (const nativeImage of nativeImages) {
          const image = await config.imageTools.acceptNativeImage(nativeImage);
          recovery.recordToolResult('image_generate', image);
          nativeImageNotices.push({ role: 'user', content: `[Butler runtime notice] An upstream native image has already been generated and accepted: ${JSON.stringify(image)}. Do not generate it again. Call image_save with this exact temporary path and a readable semantic filename before replying. No identity reference use is established by this result.` });
        }
        // Require image_save once on the next turn; a reply without it then gets the pending reminder and fails on a second miss.
        forceImageSave = true;
      }
      const responseInputStart = input.length;
      const responseCandidate = responseText(body);
      logTrace('model_candidate', { askId: config.askId, traceId: config.traceId, sessionId: session, requestId, turn, ...traceTextMetadata(responseCandidate), disposition: calls.length ? 'context_only_not_delivered' : 'candidate_for_selection', reason: calls.length ? 'tool_calls_present' : 'no_tool_calls' });
      // OpenAI re-renders an earlier reasoning item once a newer one follows, which breaks the prompt cache
      // from that point, so its reasoning is not sent back; tool calls and outputs carry the work forward.
      // Claude requires its thinking to be returned unchanged within a tool loop.
      input.push(...body.output.filter(item => !(isRecord(item) && (item.type === 'image_generation_call' || (item.type === 'reasoning' && !config.model.startsWith('claude'))))));
      if (calls.length === 0) {
        transcript.liveGroups.push({ items: input.slice(responseInputStart), protected: false });
        const text = responseCandidate;
        const pendingImages = config.imageTools?.pendingImages() ?? [];
        if (pendingImages.length) {
          if (recovery.finalTextOnly) throw new Error('Final-text recovery cannot execute image_save while tools are disabled');
          if (imageSaveRequiredAttempted) throw new Error(`Image generation was not saved; image_save was required for ${pendingImages.map(image => image.path).join(', ')}`);
          const reminder = { role: 'user', content: `[Butler runtime notice] Save every generated image before replying. Call image_save now using this exact generated path and a readable semantic filename: ${pendingImages.map(image => image.path).join(', ')}` }; transcript.addReminder(reminder);
          forceImageSave = true;
          continue;
        }
        const lateSteer = await config.consumeSteer?.();
        if (lateSteer) {
          resumeToolUse();
          // The draft stays in context as already said, so deliver it before answering the steer.
          if (text.trim()) {
            logTrace('response_selected', { askId: config.askId, traceId: config.traceId, sessionId: session, requestId, turn, ...traceTextMetadata(text), decision: isNoReply(text) ? 'not_delivered' : 'selected', reason: 'draft_before_late_steer' });
            await config.onResponseReady?.(text);
          }
          await acceptSteer(lateSteer, turn, 'consumed_late');
          continue;
        }
        const emptyCompletedAfterSave = imageSaveSucceeded && isRecord(raw) && raw.status === 'completed' && !text.trim();
        if (!text.trim()) {
          const diagnostic = buildEmptyAssistantTextDiagnostic({ requestId, session, model: config.model, httpStatus, raw });
          logError('llm_empty_assistant_text', undefined, { notify: false, fields: diagnostic });
          const reasoningOnly = body.output.length > 0 && body.output.every(item => isRecord(item) && item.type === 'reasoning');
          if (reasoningOnly || emptyCompletedAfterSave) {
            const delegates = config.subagentCoordinator?.list(session, 0, Number.MAX_SAFE_INTEGER) ?? [];
            const next = recovery.continueAfterEmptyText({ reasoningOnly, afterImageSave: emptyCompletedAfterSave, hasUnfinishedDelegate: delegates.some(item => unfinishedDelegateStatus(item.status)), toolsDisabled: toolChoice === 'none' });
            const reminder = { role: 'user', content: next.finalTextOnly
              ? '[Butler runtime notice] The previous response did not provide a visible final answer. Tools have already run and their recorded results are in context. Provide only the final text using those results. Do not call tools, repeat actions, restart the task, or present reasoning as the answer. State any incomplete work or queued operation accurately; do not claim it completed.'
              : '[Butler runtime notice] The previous response contained only reasoning, with no assistant text or tool calls. Continue the current task from the existing context and completed read-only tool results. If more work is needed, issue the actual tool calls; otherwise provide the final answer. Do not repeat completed actions or present reasoning as the answer.' };
            recoveryReminders.add(reminder); transcript.addReminder(reminder);
            logTrace('model_reasoning_only_continuation', { askId: config.askId, traceId: config.traceId, sessionId: session, requestId, turn, attempt: next.attempt, limit: MAX_REASONING_ONLY_CONTINUATIONS, mode: next.finalTextOnly ? 'finalize' : 'continue' });
            continue;
          }
          throw new Error('LLM response has no assistant text');
        }
        const noReply = isNoReply(text);
        // The LLM draft is not a delivered conversation turn; outgoing delivery owns persistence.
        logTrace('response_selected', { askId: config.askId, traceId: config.traceId, sessionId: session, requestId, turn, ...traceTextMetadata(text), decision: noReply ? 'not_delivered' : 'selected', reason: noReply ? 'no_reply_marker' : 'final_text' });
        for (const [messageId, items] of toolWork) if (messageId !== storedInput.id || items !== initialAskContext) store.saveAskContext(messageId, items);
        config.onAskFinishing?.();
        await config.onResponseReady?.(text);
        return text;
      }
      if (toolChoice === 'none' && calls.length) throw new Error('LLM returned a tool call when final text was required; tools were not executed');
      if (typeof toolChoice === 'object' && calls.some(call => call.name !== 'image_save')) throw new Error('LLM returned a non-image_save tool call when image_save was required; tools were not executed');
      const runCall = async (call: FunctionCall) => {
        const toolTrace = { askId: config.askId, traceId: config.traceId, sessionId: session, requestId, turn, callId: call.call_id };
        logTrace('model_tool_start', toolTrace);
        let returned = false;
        try {
          const output = await executeCall(store, session, call, config, googleRuntime, availableToolNames, item => transcript.pendingLocalInput.push(item));
          returned = true;
          return output;
        } finally {
          logTrace('model_tool_end', { ...toolTrace, returned });
        }
      };
      const appendOutput = async (call: FunctionCall, output: unknown) => {
        recovery.recordToolResult(call.name, output);
        const failed = hasToolError(output);
        const serialized = boundedToolOutput(output);
        if (call.name === 'image_save' && isRecord(output) && !failed) imageSaveSucceeded = true;
        input.push({ type: 'function_call_output', call_id: call.call_id, output: serialized });
        logTrace('model_tool_output_appended', { askId: config.askId, traceId: config.traceId, sessionId: session, requestId, turn, callId: call.call_id, status: failed ? 'tool_error' : 'returned' });
        await transcript.appendToolInput(false);
      };
      // Read-only batches run concurrently; a batch with any other tool keeps the model's order.
      if (calls.length > 1 && calls.every(call => readOnlyTools.has(call.name))) {
        const outputs = await Promise.all(calls.map(runCall));
        for (const [index, call] of calls.entries()) await appendOutput(call, outputs[index]);
      } else for (const call of calls) await appendOutput(call, await runCall(call));
      // After every call output, so toolWork replays in sent order; a reply without calls gets the pending image_save reminder instead.
      input.push(...nativeImageNotices);
      const toolGroup = input.slice(responseInputStart);
      transcript.liveGroups.push({ items: toolGroup, protected: false });
      toolWork.set(toolOwnerId, [...toolWork.get(toolOwnerId) ?? [], ...toolGroup]);
    }
  } finally {
    config.onAskFinishing?.();
    // Conversation handoff is owned by the persistent memory drain, not ask lifecycle.
  }
}

// Above every ordinary result so far; one larger output cannot fit the request and would end the turn.
const MAX_TOOL_OUTPUT_CHARS = 500_000;
const TOOL_OUTPUT_PREVIEW_CHARS = 20_000;

/** The serialized tool output; an oversized one is replaced by a preview and its stored record ID, which history_get pages through. */
function boundedToolOutput(output: unknown): string {
  const serialized = JSON.stringify(output);
  if (serialized.length <= MAX_TOOL_OUTPUT_CHARS) return serialized;
  const id = isRecord(output) ? output.tool_history_id : undefined;
  return JSON.stringify({ tool_history_id: id, output_truncated: true, total_length: serialized.length, notice: `This result is ${serialized.length} characters, over the ${MAX_TOOL_OUTPUT_CHARS}-character limit for one tool output. Only the first ${TOOL_OUTPUT_PREVIEW_CHARS} characters are shown; read the rest with history_get (id=tool_history_id, offset, limit) or narrow the request.`, preview: serialized.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) });
}

/** A reply carrying the [no_reply] marker outside inline code is not delivered. */
export function isNoReply(text: string): boolean {
  return text.replace(/`\[no_reply\]`/g, '').includes('[no_reply]');
}
