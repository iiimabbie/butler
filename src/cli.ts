import type { Store } from './store.js';
import { ask } from './agent.js';

const [command, ...args] = process.argv.slice(2);
const baseUrl = process.env.CPA_BASE_URL ?? 'http://127.0.0.1:8317/v1';

try {
  if (command === 'models') {
    await listModels();
  } else if (command === 'discord' || command === 'discord-register') {
    const { readDiscordConfig, registerDiscordCommands, startDiscord } = await import('./discord.js');
    const config = readDiscordConfig(process.env);
    if (command === 'discord-register') await registerDiscordCommands(config);
    else {
      const dbPath = process.env.BUTLER_DB ?? new URL('../.data/butler.sqlite', import.meta.url).pathname;
      const { Store } = await import('./store.js');
      const store = new Store(dbPath);
      await startDiscord(config, store);
    }
  } else {
    const dbPath = process.env.BUTLER_DB ?? new URL('../.data/butler.sqlite', import.meta.url).pathname;
    const { Store } = await import('./store.js');
    const store = new Store(dbPath);
    try {
      await runCommand(store);
    } finally {
      store.close();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function listModels(): Promise<void> {
  const headers: Record<string, string> = {};
  if (process.env.CPA_API_KEY) headers.authorization = `Bearer ${process.env.CPA_API_KEY}`;
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`CPA HTTP ${response.status}: ${JSON.stringify(body)}`);
  if (!isRecord(body) || !Array.isArray(body.data)) throw new Error('CPA models response is missing data array');
  const ids = body.data.map((model) => isRecord(model) && typeof model.id === 'string' ? model.id : null);
  if (ids.some((id) => id === null)) throw new Error('CPA models response contains an invalid model');
  console.log(ids.join('\n'));
}

async function runCommand(store: Store): Promise<void> {
  if (command === 'sessions') {
    console.log(JSON.stringify(store.listSessions(), null, 2));
  } else if (command === 'history') {
    const [sessionId, offsetArg, limitArg] = args;
    if (!sessionId) throw new Error('Usage: history <session-id> [offset] [limit]');
    const offset = integerArg(offsetArg, 0, 'offset');
    const limit = integerArg(limitArg, 20, 'limit', 1, 100);
    const rows = store.history(sessionId, offset, limit + 1);
    console.log(JSON.stringify(pageRows(rows, offset, limit), null, 2));
  } else if (command === 'search') {
    const [query, offsetArg, limitArg] = args;
    if (!query) throw new Error('Usage: search <query> [offset] [limit]');
    const offset = integerArg(offsetArg, 0, 'offset');
    const limit = integerArg(limitArg, 20, 'limit', 1, 100);
    console.log(JSON.stringify(pageRows(store.search(query, offset, limit + 1), offset, limit), null, 2));
  } else if (command === 'get') {
    const [id, offsetArg, limitArg] = args;
    if (!id) throw new Error('Usage: get <tool-history-id> [offset] [limit]');
    const offset = integerArg(offsetArg, 0, 'offset');
    const limit = integerArg(limitArg, 4000, 'limit', 1, 100_000);
    const record = store.toolById(id);
    if (!record) throw new Error('History record not found');
    console.log(JSON.stringify({ ...record, result: resultPage(record.result, offset, limit) }, null, 2));
  } else if (command === 'new') {
    console.log(store.newSession());
  } else if (command === 'ask') {
    const { prompt, sessionId } = parseAskArgs(args);
    const session = store.ensureSession(sessionId);
    const text = await ask(store, session, prompt, {
      baseUrl,
      apiKey: process.env.CPA_API_KEY,
      model: required('CPA_MODEL'),
    });
    console.log(`session ${session}\n${text}`);
  } else {
    throw new Error('Usage: models | ask <message> [--session ID] | new | sessions | history <session-id> [offset] [limit] | search <query> [offset] [limit] | get <tool-history-id> [offset] [limit]');
  }
}

function parseAskArgs(values: string[]): { prompt: string; sessionId?: string } {
  const promptParts: string[] = [];
  let sessionId: string | undefined;
  for (let index = 0; index < values.length; index++) {
    if (values[index] === '--session') {
      if (sessionId !== undefined || !values[index + 1] || values[index + 1].startsWith('--')) {
        throw new Error('--session requires exactly one session ID');
      }
      sessionId = values[++index];
    } else if (values[index].startsWith('--')) {
      throw new Error(`Unknown ask option: ${values[index]}`);
    } else {
      promptParts.push(values[index]);
    }
  }
  const prompt = promptParts.join(' ').trim();
  if (!prompt) throw new Error('Usage: ask <message> [--session ID]');
  return { prompt, sessionId };
}

function pageRows<T extends { result: string | null }>(rows: T[], offset: number, limit: number) {
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map(({ result, ...row }) => ({ ...row, result: resultPage(result, 0, 500), has_more: result !== null && result.length > 500 })),
    offset,
    limit,
    has_more: hasMore,
    next_offset: hasMore ? offset + limit : null,
  };
}

function resultPage(result: string | null, offset: number, limit: number) {
  if (result === null) return { text: null, total_length: 0, offset, next_offset: null };
  return {
    text: result.slice(offset, offset + limit),
    total_length: result.length,
    offset,
    next_offset: offset + limit < result.length ? offset + limit : null,
  };
}

function integerArg(value: string | undefined, fallback: number, name: string, min = 0, max = 1_000_000): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
