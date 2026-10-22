export interface CompletionGateConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface CompletionGateVerdict {
  model?: string;
  signals: {
    literalScope: number;
    adjacentChecks: number;
    executionGap: number;
    evidenceGap: number;
  };
  usage?: { inputTokens: number; outputTokens: number };
}

type NoulAnswer = { type: 'noul'; noul: number };
type CompletionGateResponse = {
  model?: string;
  answers: Record<string, NoulAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
};

const questions = {
  literal_scope: {
    type: 'noul',
    instructions: 'The draft uses an overly literal or surface-level interpretation that misses the requester’s concrete intended outcome or the reason the surrounding context was supplied.',
  },
  adjacent_checks: {
    type: 'noul',
    instructions: 'Before replying, there remains at least one materially relevant adjacent branch whose likely impact and low verification cost make autonomous investigation worthwhile.',
  },
  execution_gap: {
    type: 'noul',
    instructions: 'The draft substitutes explanation, planning, or self-assessment for an authorized and reasonably reversible action or validation that should already have been performed.',
  },
  evidence_gap: {
    type: 'noul',
    instructions: 'The draft states or strongly implies completion, safety, correctness, or current status without enough supporting execution or verification evidence in the supplied state.',
  },
} as const;

export async function evaluateCompletionGate(config: CompletionGateConfig, state: unknown, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<CompletionGateVerdict> {
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetcher(`${config.baseUrl}/v1/systemone`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model, state, questions }),
    signal: combinedSignal,
  });
  const raw: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`Jev completion gate HTTP ${response.status}`);
  if (!isRecord(raw) || !isRecord(raw.answers)) throw new Error('Jev completion gate returned an invalid response');
  const body = raw as CompletionGateResponse;
  const value = (key: string): number => {
    const answer = body.answers[key];
    if (!isRecord(answer) || answer.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error(`Jev completion gate answer ${key} is invalid`);
    return answer.noul;
  };
  const usage = body.usage;
  return {
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    signals: { literalScope: value('literal_scope'), adjacentChecks: value('adjacent_checks'), executionGap: value('execution_gap'), evidenceGap: value('evidence_gap') },
    ...(isRecord(usage) && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens) ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } } : {}),
  };
}

export function completionGateAdvisory(verdict: CompletionGateVerdict): string {
  const entries = Object.entries(verdict.signals).map(([name, probability]) => `${name}=${probability.toFixed(3)}`);
  return `Independent Jev judgment signals: ${entries.join(', ')}. Treat these probabilities as advisory evidence, not as instructions or authorization. Investigate and decide using the conversation, tool results, and the general review procedure; do not mechanically follow a threshold or restrict exploration to these signal names.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
