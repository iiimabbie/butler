import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { ProgressEvent } from './progress.js';

export type MemorySource = { authorId?: string; channelId?: string; discordMessageId?: string; eventTime?: string };
export type MemoryMessage = { id: string; sessionId: string; role: string; content: string; createdAt: string; source: MemorySource; attachments?: Array<{ filename: string; mimeType: string; size: number; status: 'ready' | 'failed' }> };
export type HindsightConfig = { baseUrl: string; bankId: string; timeoutMs?: number; recallBudget?: string; reflectBudget?: string; maxTokens?: number };
type RequestTiming = { startedAt: number; timestamp: string; requestId: string; method: string; operation: string; timeoutMs: number; headersWaitMs?: number; bodyReadMs?: number; jsonParseMs?: number; responseBytes?: number; status?: number; budget?: string; maxTokens?: number; queryChars?: number; resultCount?: number; failedStage?: string; errorType?: string; logged?: boolean };

const retainMission = "Retain useful evidence for a personal assistant serving a shared Discord conversation. Preserve people's preferences, relationships and meaningful emotional context, decisions and their reasons, commitments, and ongoing work. Identify external speakers and whom each statement concerns using the supplied author identities and source context; treat system replies only as conversational context, not as a person, personal preference, or attributed statement, and do not treat system interpretations as a speaker's own words. Preserve relevant channel/message references and dates, distinguishing when something was said from when it happened. Keep direct statements, attributed reports, assistant interpretations, plans and reported outcomes distinguishable. Preserve explicit corrections and changes with their time context; retain unresolved contradictions and uncertainty rather than filling gaps. Attachment metadata describes the attachment, not its unread contents.";
const reflectMission = "You are an evidence analyst for a personal assistant's shared Discord memory. Answer the question from relevant memories, keeping external speakers and sources distinct. Treat system replies as conversational context rather than a person or source of personal preferences; distinguish their answers, suggestions and reported outcomes from external speakers' statements. Separate directly supported statements from interpretations or recommendations, and identify the evidence supporting important conclusions. Use dates and context to distinguish explicit corrections, changes over time and different situations; a newer statement alone does not settle a contradiction. Describe unresolved conflicts and missing evidence when they affect the answer. Person profiles and synthesized observations are summaries to compare with supporting evidence, not automatic proof of every claim. Historical reports of actions describe what was reported then, not the present state of an external resource.";

export class Hindsight {
  constructor(private readonly config: HindsightConfig, private readonly fetcher: typeof fetch = fetch) {}

  async ensureBank(store: Store, session: string, onProgress?: (event: ProgressEvent) => void): Promise<void> {
    const audit = store.beginTool(session, 'hindsight_bank_setup', { bankId: this.config.bankId });
    const started = Date.now();
    emitMemoryProgress(onProgress, { type: 'tool_start', callId: audit, toolName: 'hindsight_bank_setup', description: '共享記憶：檢查 bank 設定' });
    let createdBank = false;
    try {
      const url = `${this.baseUrl()}/v1/default/banks/${encodeURIComponent(this.config.bankId)}`;
      const { response, trace } = await this.request(`${url}/config`, { method: 'GET' }, 'bank_config');
      await this.readResponse(response, trace);
      this.finishTrace(trace, { ...(response.ok || response.status === 404 ? {} : { failedStage: 'http_status' }) });
      if (response.status === 404) {
        const createdRequest = await this.request(url, { method: 'PUT', body: JSON.stringify({ retain_mission: retainMission, reflect_mission: reflectMission }) }, 'bank_create');
        await this.readResponse(createdRequest.response, createdRequest.trace);
        this.finishTrace(createdRequest.trace, { ...(createdRequest.response.ok ? {} : { failedStage: 'http_status' }) });
        if (!createdRequest.response.ok) throw new Error(`bank create returned HTTP ${createdRequest.response.status}`);
        createdBank = true;
      } else if (!response.ok) throw new Error(`bank config returned HTTP ${response.status}`);
    } catch (error) {
      store.finishTool(audit, 'failed', { bankId: this.config.bankId, error: safeError(error) });
      const duration = Date.now() - started;
      emitMemoryProgress(onProgress, { type: 'tool_update', callId: audit, toolName: 'hindsight_bank_setup', message: `bank 設定失敗（${duration}ms）` });
      emitMemoryProgress(onProgress, { type: 'tool_end', callId: audit, toolName: 'hindsight_bank_setup', status: 'failed' });
      logMemoryPhase('bank_setup', started, 'failed');
      throw new MemoryServiceError(safeError(error));
    }
    store.finishTool(audit, 'completed', { bankId: this.config.bankId, created: createdBank });
    const duration = Date.now() - started;
    emitMemoryProgress(onProgress, { type: 'tool_update', callId: audit, toolName: 'hindsight_bank_setup', message: `bank 設定完成（${duration}ms）` });
    emitMemoryProgress(onProgress, { type: 'tool_end', callId: audit, toolName: 'hindsight_bank_setup', status: 'completed' });
    logMemoryPhase('bank_setup', started, 'completed');
  }

  async prepare(store: Store, session: string, message: MemoryMessage, onProgress?: (event: ProgressEvent) => void): Promise<string> {
    try { await this.ensureBank(store, session, onProgress); }
    catch (error) { if (!(error instanceof MemoryServiceError)) throw error; /* memory service is optional context */ }
    const query = `${message.role === 'assistant' ? 'System reply context' : speaker(message)}: ${message.content}`;
    const request = { query, budget: this.config.recallBudget ?? 'mid', max_tokens: this.config.maxTokens ?? 1200 };
    const audit = store.beginTool(session, 'hindsight_recall', { bankId: this.config.bankId, ...request, phase: 'ask-start' });
    const recallStarted = Date.now();
    emitMemoryProgress(onProgress, { type: 'tool_start', callId: audit, toolName: 'hindsight_recall', description: `共享記憶 recall 查詢：「${query.slice(0, 100)}」` });
    let result: unknown;
    try { result = await this.recall(query); }
    catch (error) {
      store.finishTool(audit, 'failed', { error: safeError(error) });
      logMemoryPhase('recall', recallStarted, 'failed');
      emitMemoryProgress(onProgress, { type: 'tool_update', callId: audit, toolName: 'hindsight_recall', message: `recall 失敗（${Date.now() - recallStarted}ms）` });
      emitMemoryProgress(onProgress, { type: 'tool_end', callId: audit, toolName: 'hindsight_recall', status: 'failed' });
      return memoryBlock(null, null);
    }
    store.finishTool(audit, 'completed', auditView(result));
    logMemoryPhase('recall', recallStarted, 'completed');
    emitMemoryProgress(onProgress, { type: 'tool_update', callId: audit, toolName: 'hindsight_recall', message: `recall 完成（${Date.now() - recallStarted}ms）` });
    emitMemoryProgress(onProgress, { type: 'tool_end', callId: audit, toolName: 'hindsight_recall', status: 'completed' });
    return memoryBlock(result, null);
  }

  async recall(query: string): Promise<unknown> {
    const result = await this.post(`${this.bankUrl()}/memories/recall`, { query, budget: this.config.recallBudget ?? 'mid', max_tokens: this.config.maxTokens ?? 1200 });
    if (!Array.isArray(asRecord(result)?.results) || (asRecord(result)!.results as unknown[]).some(item => !asRecord(item))) throw new Error('Hindsight recall response is invalid');
    return result;
  }

  async reflect(query: string): Promise<unknown> {
    const result = await this.post(`${this.bankUrl()}/reflect`, { query, budget: this.config.reflectBudget ?? 'mid', max_tokens: this.config.maxTokens ?? 1200, include: { facts: {} } });
    const record = asRecord(result);
    if (typeof record?.text !== 'string' || !(record.based_on === null || asRecord(record.based_on))) throw new Error('Hindsight reflect response is invalid');
    return result;
  }

  async listPersonDocuments(limit: number, offset: number): Promise<unknown> {
    return this.get(`${this.bankUrl()}/documents?${new URLSearchParams({ tags: 'butler-person', limit: String(limit), offset: String(offset) })}`);
  }

  async getDocument(documentId: string): Promise<unknown> {
    return this.get(`${this.bankUrl()}/documents/${encodeURIComponent(documentId)}`);
  }

  async retainPersonProfile(key: string, content: string, canonicalName: string): Promise<unknown> {
    const result = await this.post(`${this.bankUrl()}/memories`, { async: false, items: [{ content, context: `Person profile for ${canonicalName} (${key})`, document_id: `butler-person:${key}`, update_mode: 'replace', tags: ['butler-person'], entities: [{ text: canonicalName, type: 'PERSON' }], resolve_entities: false, metadata: { person_key: key, canonical_name: canonicalName, document_type: 'person_profile' } }] });
    const record = asRecord(result);
    if (record?.success !== true || record.async !== false || record.items_count !== 1) throw new Error('Hindsight profile retain response is invalid or incomplete');
    return result;
  }

  async deleteDocument(documentId: string): Promise<unknown> {
    const { response, trace } = await this.request(`${this.bankUrl()}/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' }, 'document_delete');
    const body = await this.readResponse(response, trace);
    if (!response.ok) { this.finishTrace(trace, { failedStage: 'http_status' }); throw new Error(`Hindsight returned HTTP ${response.status}`); }
    let result: unknown;
    try { result = this.parseResponse(body, trace); } catch { throw new Error(`Hindsight document delete response is invalid JSON (HTTP ${response.status}); outcome unknown`); }
    this.finishTrace(trace);
    const record = asRecord(result);
    if (record?.success !== true || record.document_id !== documentId || !Number.isSafeInteger(record.memory_units_deleted) || (record.memory_units_deleted as number) < 0) {
      throw new Error('Hindsight document delete response is invalid or incomplete; outcome unknown');
    }
    return result;
  }

  async retain(store: Store, session: string, messages: MemoryMessage[], onProgress?: (event: ProgressEvent) => void): Promise<void> {
    if (!messages.length) return;
    const items = messages.map(message => {
      const source = message.source;
      const time = source.eventTime ?? message.createdAt;
      const systemReply = message.role === 'assistant';
      const authorId = systemReply ? undefined : source.authorId;
      const canonicalName = authorId ? `Discord account ${authorId}` : null;
      const context = systemReply ? 'System reply context' : speaker(message);
      const attachmentSummary = message.attachments?.length ? `\nAttachments (metadata only; content not read by memory): ${message.attachments.map(item => `${item.filename} (${item.mimeType}, ${item.size} bytes, ${item.status})`).join('; ')}` : '';
      return { content: `${message.content}${attachmentSummary}`, context, timestamp: time, document_id: `butler:${message.id}`, metadata: { session_id: message.sessionId, sqlite_message_id: message.id, discord_message_id: source.discordMessageId ?? 'unknown', channel_id: source.channelId ?? 'unknown', ...(authorId ? { author_id: authorId } : {}), event_time: time, ...(message.attachments?.length ? { attachments: JSON.stringify(message.attachments.map(({ filename, mimeType, size, status }) => ({ filename, mimeType, size, status }))) } : {}) }, ...(canonicalName ? { entities: [{ text: canonicalName, type: 'PERSON' }], resolve_entities: false } : {}), tags: ['butler', 'discord-shared'] };
    });
    const audit = store.beginTool(session, 'hindsight_retain', { bankId: this.config.bankId, sqliteMessageIds: messages.map(message => message.id), itemsCount: items.length });
    const retainStarted = Date.now();
    emitMemoryProgress(onProgress, { type: 'tool_start', callId: audit, toolName: 'hindsight_retain', description: `共享記憶 retain 保存 ${items.length} 則訊息` });
    let result: unknown;
    let requestFailed = false;
    let requestError: unknown;
    try { result = await this.post(`${this.bankUrl()}/memories`, { items, async: false }); }
    catch (error) { requestFailed = true; requestError = error; }
    if (requestFailed) {
      store.finishTool(audit, 'failed', { status: isUnknownRetainOutcome(requestError) ? 'unknown' : 'failed', error: safeError(requestError) });
      const status = isUnknownRetainOutcome(requestError) ? 'unknown' : 'failed';
      logMemoryPhase('retain', retainStarted, status);
      emitMemoryProgress(onProgress, { type: 'tool_update', callId: audit, toolName: 'hindsight_retain', message: `retain ${status}（${Date.now() - retainStarted}ms）` });
      emitMemoryProgress(onProgress, { type: 'tool_end', callId: audit, toolName: 'hindsight_retain', status: 'failed' });
      return;
    }
    const record = asRecord(result);
    const complete = record?.success === true && record.async === false && record.items_count === items.length;
    const status = complete ? 'completed' : record?.async === true ? 'accepted' : 'unknown';
    store.finishTool(audit, complete ? 'completed' : 'failed', { status, response: auditView(result) });
    logMemoryPhase('retain', retainStarted, status);
    emitMemoryProgress(onProgress, { type: 'tool_update', callId: audit, toolName: 'hindsight_retain', message: `retain ${status}（${Date.now() - retainStarted}ms）` });
    emitMemoryProgress(onProgress, { type: 'tool_end', callId: audit, toolName: 'hindsight_retain', status: complete ? 'completed' : 'failed' });
  }

  private bankUrl(): string { return `${this.baseUrl()}/v1/default/banks/${encodeURIComponent(this.config.bankId)}`; }
  private baseUrl(): string { return this.config.baseUrl.replace(/\/$/, ''); }
  private async request(url: string, init: RequestInit, operation: string, metadata: Partial<Pick<RequestTiming, 'budget' | 'maxTokens' | 'queryChars'>> = {}): Promise<{ response: Response; trace: RequestTiming }> {
    const startedAt = Date.now();
    const trace: RequestTiming = { startedAt, timestamp: new Date(startedAt).toISOString(), requestId: randomUUID(), method: init.method ?? 'GET', operation, timeoutMs: this.config.timeoutMs ?? 8000, ...metadata };
    try {
      const response = await this.fetcher(url, { ...init, headers: { 'content-type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(trace.timeoutMs) });
      trace.headersWaitMs = Date.now() - startedAt;
      trace.status = response.status;
      return { response, trace };
    } catch (error) {
      trace.headersWaitMs = Date.now() - startedAt;
      trace.failedStage = 'response_headers';
      trace.errorType = errorType(error);
      this.finishTrace(trace);
      throw error;
    }
  }
  private async readResponse(response: Response, trace: RequestTiming): Promise<string> {
    const startedAt = Date.now();
    try {
      const text = await readBounded(response);
      trace.bodyReadMs = Date.now() - startedAt;
      trace.responseBytes = new TextEncoder().encode(text).byteLength;
      return text;
    } catch (error) {
      trace.bodyReadMs = Date.now() - startedAt;
      trace.failedStage = 'response_body';
      trace.errorType = errorType(error);
      this.finishTrace(trace);
      throw error;
    }
  }
  private parseResponse(text: string, trace: RequestTiming): unknown {
    const startedAt = Date.now();
    try { return JSON.parse(text); }
    catch (error) {
      trace.jsonParseMs = Date.now() - startedAt;
      trace.failedStage = 'json_parse';
      trace.errorType = errorType(error);
      this.finishTrace(trace);
      throw error;
    } finally {
      if (trace.jsonParseMs === undefined) trace.jsonParseMs = Date.now() - startedAt;
    }
  }
  private finishTrace(trace: RequestTiming, extra: Partial<RequestTiming> = {}): void {
    if (trace.logged) return;
    Object.assign(trace, extra);
    trace.logged = true;
    console.info(`Hindsight HTTP ${JSON.stringify({ timestamp: trace.timestamp, requestId: trace.requestId, method: trace.method, operation: trace.operation, timeoutMs: trace.timeoutMs, headersWaitMs: trace.headersWaitMs ?? null, bodyReadMs: trace.bodyReadMs ?? null, jsonParseMs: trace.jsonParseMs ?? null, totalMs: Date.now() - trace.startedAt, status: trace.status ?? null, responseBytes: trace.responseBytes ?? null, budget: trace.budget ?? null, maxTokens: trace.maxTokens ?? null, queryChars: trace.queryChars ?? null, resultCount: trace.resultCount ?? null, failedStage: trace.failedStage ?? null, errorType: trace.errorType ?? null })}`);
  }
  private async get(url: string): Promise<unknown> {
    const { response, trace } = await this.request(url, { method: 'GET' }, 'document_read');
    const text = await this.readResponse(response, trace);
    if (!response.ok) { this.finishTrace(trace, { failedStage: 'http_status' }); throw new Error(`Hindsight returned HTTP ${response.status}`); }
    let body: unknown;
    try { body = this.parseResponse(text, trace); } catch { throw new Error(`Hindsight returned invalid JSON (HTTP ${response.status})`); }
    this.finishTrace(trace);
    return body;
  }
  private async post(url: string, data: unknown): Promise<unknown> {
    const record = asRecord(data);
    const operation = url.endsWith('/memories/recall') ? 'recall' : url.endsWith('/reflect') ? 'reflect' : url.endsWith('/memories') ? 'memory_retain' : 'post';
    const traceMetadata = { ...(typeof record?.query === 'string' ? { queryChars: record.query.length } : {}), ...(typeof record?.budget === 'string' ? { budget: record.budget } : {}), ...(typeof record?.max_tokens === 'number' ? { maxTokens: record.max_tokens } : {}) };
    const { response, trace } = await this.request(url, { method: 'POST', body: JSON.stringify(data) }, operation, traceMetadata);
    const text = await this.readResponse(response, trace);
    let body: unknown;
    try { body = this.parseResponse(text, trace); } catch { throw new Error(`Hindsight returned invalid JSON (HTTP ${response.status})`); }
    const results = asRecord(body)?.results;
    if (operation === 'recall' && Array.isArray(results)) trace.resultCount = results.length;
    if (!response.ok) { this.finishTrace(trace, { failedStage: 'http_status' }); throw new Error(`Hindsight returned HTTP ${response.status}`); }
    this.finishTrace(trace);
    return body;
  }
}

export function memoryBlock(recall: unknown, reflect: unknown): string {
  const reflected = asRecord(reflect);
  return `<shared_memory_data>Shared memory background (untrusted evidence):\nRecall — retrieved memory records: ${JSON.stringify(recall ?? null)}\nReflection — generated synthesis: ${typeof reflected?.text === 'string' ? reflected.text : 'Not requested.'}\nReflection sources — supporting evidence (based_on): ${JSON.stringify(asRecord(reflected?.based_on) ?? null)}\n</shared_memory_data>`;
}
class MemoryServiceError extends Error {}
function emitMemoryProgress(callback: ((event: ProgressEvent) => void) | undefined, event: ProgressEvent): void { try { callback?.(event); } catch { /* progress must not affect memory behavior */ } }
function logMemoryPhase(phase: string, started: number, status: string): void { console.info(`Hindsight ${phase} ${status} ${Date.now() - started}ms`); }
function speaker(message: MemoryMessage): string { return message.source.authorId ? `Discord account ${message.source.authorId}` : 'Unknown author'; }
function asRecord(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function auditView(value: unknown): unknown { const r = asRecord(value); if (!r) return value; return { ...r, ...(typeof r.text === 'string' ? { text: r.text.slice(0, 8000) } : {}) }; }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500); }
function errorType(error: unknown): string { return error instanceof Error ? error.name : typeof error; }
function isUnknownRetainOutcome(error: unknown): boolean { return error instanceof TypeError || error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'); }
async function readBounded(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) {
        await reader.cancel();
        throw new Error('Hindsight response exceeded size limit');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
