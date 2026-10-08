import type { Hindsight } from './hindsight.js';

const string = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0 };
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}

export const peopleDefinitions = [
  definition('people_list', 'List person knowledge pages by stable identity key. offset counts matching pages (default 0); limit defaults to 50, maximum 100. Use people_get to read a complete page.', { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: integer }, []),
  definition('people_get', 'Read the complete Hindsight-generated knowledge page for a stable person key, including its source query and refresh state. Discord account keys remain discord:<account id>; their canonical identity is dc:<account id>. Other people use a consistent key. An absent page returns a not-found error.', { key: string }, ['key']),
  definition('people_upsert', 'Create or refresh a Hindsight-generated person knowledge page from shared conversational memories; do not write page content or supply conclusions as established facts. Hindsight generates the summary, including relevant preferences, personality, relationships, experiences, and emotional context. Write a natural summary without repetitive evidence disclaimers while preserving meaningful dates, source attribution, corrections, and unresolved contradictions. Optional name sets a readable page name; optional query adds a focus to the fixed person-summary instructions. Omitted options preserve existing values. Updates may be made autonomously. The system itself is not a person-profile subject. Creation and refresh are queued, not completed summaries. Discord account keys remain discord:<account id>, with canonical identity dc:<account id>; use a stable key for other people.', { key: string, name: string, query: string }, ['key']),
  definition('people_delete', 'Delete the specified person knowledge page and its backing model when the current speaker explicitly requests deletion. Confirm the unique page first. This does not delete conversation records, source documents, or all memories about the person. Discord account keys remain discord:<account id>; canonical identity is dc:<account id>.', { key: string }, ['key']),
  definition('people_recall', 'Retrieve and summarize relevant memories about a person using their stable identity key and a specific question. Returns the existing Hindsight-generated knowledge page, matching memories, and a synthesized answer with supporting references. Use the information naturally while distinguishing the person being discussed from the speakers who mentioned them. Preserve meaningful changes, dates, and contradictions without adding unnecessary evidence disclaimers. The knowledge page is null when absent. Identity context helps retrieval but is not a strict person-only filter.', { key: string, query: string }, ['key', 'query']),
];

export type PeopleToolRuntime = {
  definitions: typeof peopleDefinitions;
  execute(name: string, args: Record<string, unknown>, ...context: unknown[]): Promise<unknown>;
};

type KnowledgeNode = Record<string, unknown> & { id: string; kind: string; name: string; children?: KnowledgeNode[] };
type PersonPage = KnowledgeNode & { mental_model_id: string; source_query: string };
const trigger = { mode: 'full', refresh_after_consolidation: true, refresh_cron: null, min_refresh_interval_seconds: 3600, exclude_mental_models: true };
const evidenceInstructions = '根據共享記憶整理此人的身份、偏好、個性、關係、經歷及有意義的情感脈絡，以自然、精簡的繁中描述，不反覆加入「未經本人確認」或「缺乏直接證據」等免責說明。正確區分被描述的人與發話者，以及本人陳述、他人轉述與系統解讀；保留有助於理解的來源、日期、必要的精確時間與時區、明確更正及未解矛盾。不補充無記憶依據的細節，不將推測寫成確定事實，也不僅因較新就判為正確。既有人物摘要只是背景整理，不是獨立確認。';

export function createPeopleToolRuntime(hindsight: Hindsight): PeopleToolRuntime {
  return {
    definitions: peopleDefinitions,
    async execute(name, args) {
      const allowed: Record<string, string[]> = {
        people_list: ['limit', 'offset'], people_get: ['key'], people_upsert: ['key', 'name', 'query'],
        people_delete: ['key'], people_recall: ['key', 'query'],
      };
      const keys = allowed[name];
      if (!keys) throw new Error(`Unknown people tool: ${name}`);
      if (Object.keys(args).some(key => !keys.includes(key))) throw new Error('Unknown people tool argument');
      if (name === 'people_list') {
        const limit = integerArg(args.limit, 50, 1, 100, 'limit');
        const offset = integerArg(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
        const pages = await personPages(hindsight);
        const rows = pages.slice(offset, offset + limit).map(page => ({ key: page.key, page_id: page.id, mental_model_id: page.mental_model_id, name: page.name, timestamp: page.timestamp ?? null, is_stale: page.is_stale ?? null, last_refresh_failed_at: page.last_refresh_failed_at ?? null }));
        const total = pages.length;
        const nextOffset = offset + rows.length;
        return { people: rows, total, offset, limit, has_more: nextOffset < total, next_offset: nextOffset < total ? nextOffset : null };
      }
      const key = personKey(text(args.key, 'key'));
      if (name === 'people_get') {
        const page = await getPerson(hindsight, key);
        if (!page) throw new Error(`Person page not found for key ${key}`);
        return page;
      }
      if (name === 'people_upsert') return upsertPerson(hindsight, key, optionalText(args.name, 'name'), optionalText(args.query, 'query'));
      if (name === 'people_delete') {
        const page = await uniquePerson(hindsight, key);
        if (!page) throw new Error(`Person page not found for key ${key}`);
        if (page.children?.length) throw new Error(`Person page ${page.id} has children and cannot be deleted`);
        if (!page.mental_model_id) throw new Error(`Person page ${page.id} has no backing model`);
        return hindsight.deleteKnowledgePage(page.id);
      }
      const query = text(args.query, 'query');
      const existing = await getPerson(hindsight, key);
      const canonicalName = key.startsWith('discord:') ? `dc:${key.slice('discord:'.length)}` : key;
      const profileContext = existing && typeof existing.body === 'string' && existing.body.trim() ? `Person knowledge page summary (background, not independent evidence): ${existing.body}\n` : '';
      const contextualQuery = `${profileContext}Target person: ${canonicalName} (profile key ${key})
Question: ${query}
Retrieve relevant memories about this person and answer naturally. Identify who each memory concerns and avoid confusing different speakers. Consider the existing profile, meaningful corrections, changes over time, and relevant context. Preserve source attribution when necessary for accurate understanding, but do not repeatedly qualify ordinary conversational information with statements about missing personal confirmation or insufficient evidence. Mention uncertainty or contradictions only when they materially affect the answer. Do not invent missing information. Distinguish explicit corrections from changes over time or different situations; recency alone does not resolve a contradiction. Preserve exact times and timezones when relevant. The existing knowledge-page summary is background context, not independent confirmation.`;
      const [recall, reflect] = await Promise.all([hindsight.recall(contextualQuery), hindsight.reflect(contextualQuery)]);
      return { profile: existing, recall, reflect };
    },
  };
}

async function upsertPerson(hindsight: Hindsight, key: string, name: string | undefined, query: string | undefined): Promise<unknown> {
  let page: PersonPage | null = await uniquePerson(hindsight, key);
  const sourceQuery = makeSourceQuery(key, query);
  if (!page) {
    const pageName = name ?? `人物｜${key}`;
    try {
      const created = await hindsight.createKnowledgePage({ name: pageName, source_query: sourceQuery, tags: [], trigger });
      return { key, page_id: created.page_id, mental_model_id: created.mental_model_id, name: pageName, source_query: sourceQuery, operation_id: created.operation_id, status: 'queued', refresh_queued: true };
    } catch (error) {
      if (!isHttpStatus(error, 409)) throw error;
      page = await uniquePerson(hindsight, key);
      if (!page) throw new Error(`Knowledge page name conflict for ${pageName}; no matching person page was found`);
    }
  }

  const changes: Record<string, unknown> = {};
  if (name !== undefined && name !== page.name) changes.name = name;
  const sourceQueryChanged = query !== undefined && page.source_query !== sourceQuery;
  if (sourceQueryChanged) changes.source_query = sourceQuery;
  if (!sameTags(page.tags, [])) changes.tags = [];
  if (!sameTrigger(page.trigger, trigger)) changes.trigger = trigger;
  if (Object.keys(changes).length) await hindsight.updateKnowledgePage(page.id, changes);
  if (sourceQueryChanged) return { key, page_id: page.id, mental_model_id: page.mental_model_id, name: name ?? page.name, source_query: sourceQuery, status: 'queued', refresh_queued: true };
  try {
    const refresh = await hindsight.refreshKnowledgePage(page.mental_model_id);
    return { key, page_id: page.id, mental_model_id: page.mental_model_id, operation_id: refresh.operation_id, status: 'queued', refresh_queued: true, name: name ?? page.name, source_query: page.source_query };
  } catch (error) {
    const updateSummary = Object.keys(changes).length ? 'Person page updates succeeded' : 'Person page refresh could not be queued';
    throw new Error(`${updateSummary} for key ${key} (page ${page.id}, model ${page.mental_model_id}), but refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getPerson(hindsight: Hindsight, key: string): Promise<Record<string, unknown> | null> {
  const page = await uniquePerson(hindsight, key);
  if (!page) return null;
  const content = await hindsight.getKnowledgePage(page.id);
  return { key, page_id: page.id, mental_model_id: page.mental_model_id, name: content.name, source_query: content.description, body: content.body, markdown: content.markdown, timestamp: content.timestamp ?? null, is_stale: page.is_stale ?? null, last_refresh_failed_at: page.last_refresh_failed_at ?? null, content_empty: typeof content.body !== 'string' || !content.body.trim() };
}

async function uniquePerson(hindsight: Hindsight, key: string): Promise<PersonPage | null> {
  const matches = (await personPages(hindsight)).filter(page => page.key === key);
  if (matches.length > 1) throw new Error(`Multiple person pages found for key ${key}; refusing to choose one`);
  return matches[0] ?? null;
}

async function personPages(hindsight: Hindsight): Promise<(PersonPage & { key: string })[]> {
  const roots = await hindsight.getKnowledgeTree() as KnowledgeNode[];
  const pages: (PersonPage & { key: string })[] = [];
  const visit = (nodes: KnowledgeNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'page' && typeof node.description === 'string') {
        const firstLine = node.description.split(/\r?\n/, 1)[0]!;
        const prefix = 'Butler person key: ';
        if (firstLine.startsWith(prefix) && typeof node.mental_model_id === 'string') {
          let parsed: unknown;
          try { parsed = JSON.parse(firstLine.slice(prefix.length)); } catch { parsed = undefined; }
          if (typeof parsed === 'string') {
            try {
              const key = personKey(text(parsed, 'person key'));
              if (firstLine === `Butler person key: ${JSON.stringify(key)}`) pages.push({ ...node, key, mental_model_id: node.mental_model_id, source_query: node.description });
            } catch { /* malformed markers are not managed person pages */ }
          }
        }
      }
      if (node.children) visit(node.children);
    }
  };
  visit(roots);
  return pages.sort((a, b) => a.key.localeCompare(b.key));
}

function sameTags(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && expected.every((tag, index) => value[index] === tag);
}
function sameTrigger(value: unknown, expected: Record<string, unknown>): boolean {
  const actual = asRecord(value);
  return actual !== null && Object.keys(expected).every(key => actual[key] === expected[key]);
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function makeSourceQuery(key: string, query?: string): string {
  const canonical = key.startsWith('discord:') ? `dc:${key.slice('discord:'.length)}` : key;
  return `Butler person key: ${JSON.stringify(key)}\nCanonical identity: ${canonical}\n${evidenceInstructions}${query === undefined ? '' : `\nAdditional focus: ${query}`}`;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${name} must be a non-empty string without NUL`);
  return value.trim();
}
function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${name} must be a non-empty string without NUL when provided`);
  return value.trim();
}
function integerArg(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value as number;
}
function personKey(key: string): string {
  if (key.startsWith('discord:')) text(key.slice('discord:'.length), 'Discord account id');
  return key;
}
function isHttpStatus(error: unknown, status: number): boolean { return error instanceof Error && error.message.includes(`HTTP ${status}`); }
