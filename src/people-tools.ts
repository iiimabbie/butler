import { ToolUsageError } from './tool-errors.js';
import type { Hindsight } from './hindsight.js';
import { createFixedKnowledgePage, refreshProperties, resolveKnowledgeFolder, tagsArg, validateKnowledgeTags, validateRefreshArgs } from './knowledge-tools.js';

const string = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0 };
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}

export const peopleDefinitions = [
  definition('people_list', 'List person knowledge pages by stable identity key. offset counts matching pages (default 0); limit defaults to 50, maximum 100. Use people_get to read a complete page.', { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: integer }, []),
  definition('people_get', 'Read the complete Hindsight-generated knowledge page for a stable person key, including its source query and refresh state. For Discord accounts, supply the raw numeric account ID; it maps to the stable index discord:<account id>. Other people may use a consistent key. An absent page returns a not-found error.', { key: string }, ['key']),
  definition('people_upsert', 'Create or refresh a person page using the fixed operator-owned prompt and settings. Supply dcid (raw Discord account ID: 2–32 digits, no prefix), nickname (page name becomes person｜<nickname>), max_tokens (256–8192 output tokens), and tags (non-empty existing memory tags). Optional refresh_mode, refresh_cron and min_refresh_interval_seconds apply only when creating a new page; they never change an existing page trigger. First query memory_tags_list and confirm the person-to-tag mapping with relevant memories. Never infer tags from nickname or dcid. If no relevant existing tag can be confirmed, do not upsert; report the missing mapping. Pages live in the person folder. Do not supply content, query, or fixed settings. The system itself is not a person-profile subject. Creation/refresh is queued, not completed content.', { dcid: { type: 'string', pattern: '^[0-9]{2,32}$' }, nickname: { type: 'string', minLength: 1, maxLength: 100 }, max_tokens: { type: 'integer', minimum: 256, maximum: 8192 }, tags: { type: 'array', items: string, minItems: 1, maxItems: 20, uniqueItems: true }, ...refreshProperties }, ['dcid', 'nickname', 'max_tokens', 'tags']),
];

export type PeopleToolRuntime = {
  definitions: typeof peopleDefinitions;
  execute(name: string, args: Record<string, unknown>, ...context: unknown[]): Promise<unknown>;
};

type KnowledgeNode = Record<string, unknown> & { id: string; kind: string; name: string; children?: KnowledgeNode[] };
type PersonPage = KnowledgeNode & { mental_model_id: string; source_query: string };
const fixedPrompt = '的人物頁。以 Renee 的第一人稱視角摘要包括身份/別名、偏好、個性與 Renee 對此人的主觀印象、關係及其有意義的由來、經歷、當時情緒等。紀錄此人與其他被提及人物的關係，不抄錄其他人無關個資。不把新聞/外部模型引文當成此人的政治立場或生活事實，也不把單次疲累當作永久習慣。正文使用第三人稱，以明確人物名稱記錄身份、經歷、情緒與關係；Renee 自己的感受或主觀印象也寫成「Renee 覺得……」，不以未標示的「我／你／姊姊／主人」代替人物。保留情感與關係的意義，區分此人表達的感受與 Renee 的解讀，不假定感情或關係是雙向的。依原始媒介與場景記錄事件：Discord 中實際發生的發言、親密互動、衝突與關係變化就是線上事件；參與者按自己的身份互動，除非原文明確設定其他角色或虛構框架，不預設任何人是在扮演角色。文字動作只在原文顯示已實際完成或承接時，記為該線上場景已發生；區分玩笑、願望、邀請、打算、假設、未完成動作與單純提及。區分互動本身與其中描述的身體行為或想像情節，不由文字推定線下身體事件；原文明確設定為角色扮演或虛構時才按該上下文描述，也保留互動實際發生及其情感意義。需要時交代媒介，不反覆加入「只是虛構」「不代表現實」「不能推定」等免責句。逐字引言可保留第一人稱，但須標明原始說話者；舊記憶中作者不明的「我」不能預設是 Renee 或人物頁主角。正文自然寫，正確區分發話者、受話者、被談論者、本人陳述、他人轉述、助理回報、工具驗證及推論。不迴避情色內容、個性差勁或色情等負面印象。';

export function createPeopleToolRuntime(hindsight: Hindsight): PeopleToolRuntime {
  // Serialize local upserts so concurrent calls cannot create duplicate folders/pages.
  let pending: Promise<unknown> = Promise.resolve();
  return {
    definitions: peopleDefinitions,
    async execute(name, args) {
      const allowed: Record<string, string[]> = {
        people_list: ['limit', 'offset'], people_get: ['key'], people_upsert: ['dcid', 'nickname', 'max_tokens', 'tags', ...Object.keys(refreshProperties)],
      };
      const keys = allowed[name];
      if (!keys) throw new ToolUsageError(`Unknown people tool: ${name}`);
      if (Object.keys(args).some(key => !keys.includes(key))) throw new ToolUsageError('Unknown people tool argument');
      if (name === 'people_list') {
        const limit = integerArg(args.limit, 50, 1, 100, 'limit');
        const offset = integerArg(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
        const pages = await personPages(hindsight);
        const rows = pages.slice(offset, offset + limit).map(page => ({ key: page.key, page_id: page.id, mental_model_id: page.mental_model_id, name: page.name, timestamp: page.timestamp ?? null, is_stale: page.is_stale ?? null, last_refresh_failed_at: page.last_refresh_failed_at ?? null }));
        const total = pages.length;
        const nextOffset = offset + rows.length;
        return { people: rows, total, offset, limit, has_more: nextOffset < total, next_offset: nextOffset < total ? nextOffset : null };
      }
      if (name === 'people_upsert') {
        const dcid = text(args.dcid, 'dcid');
        if (!/^[0-9]{2,32}$/.test(dcid)) throw new ToolUsageError('dcid must be a raw Discord account ID (2–32 digits, no prefix)');
        const nickname = text(args.nickname, 'nickname');
        if (nickname.length > 100 || /[\r\n]/.test(nickname)) throw new ToolUsageError('nickname must be a single line, at most 100 characters');
        if (args.max_tokens === undefined) throw new ToolUsageError('max_tokens is required');
        const tokens = integerArg(args.max_tokens, 2048, 256, 8192, 'max_tokens');
        const tags = tagsArg(args.tags, true);
        const refresh = validateRefreshArgs(args);
        const run = pending.then(() => upsertPerson(hindsight, personKey(dcid), nickname, tokens, tags, refresh));
        pending = run.catch(() => undefined);
        return run;
      }
      const key = personKey(text(args.key, 'key'));
      const page = await getPerson(hindsight, key);
      if (!page) throw new ToolUsageError(`Person page not found for key ${key}`);
      return page;
    },
  };
}

async function upsertPerson(hindsight: Hindsight, key: string, nickname: string, maxTokens: number, tags: string[], refresh: ReturnType<typeof validateRefreshArgs>): Promise<unknown> {
  let page: PersonPage | null = await uniquePerson(hindsight, key);
  const sourceQuery = makeSourceQuery(key);
  const pageName = `person｜${nickname}`;
  if (!page) {
    try {
      await createFixedKnowledgePage(hindsight, { name: pageName, folder: 'person', source_query: sourceQuery, tags, max_tokens: maxTokens, refresh });
      return { message: '人物頁新增成功，正在等待刷新。' };
    } catch (error) {
      if (!isHttpStatus(error, 409)) throw error;
      page = await uniquePerson(hindsight, key);
      if (!page) throw new Error(`Knowledge page name conflict for ${pageName}; no matching person page was found`);
    }
  }
  await validateKnowledgeTags(hindsight, tags);
  const changes: Record<string, unknown> = { max_tokens: maxTokens, tags };
  if (pageName !== page.name) changes.name = pageName;
  const parentId = await resolveKnowledgeFolder(hindsight, 'person');
  if (page.parent_id !== parentId) changes.parent_id = parentId;
  const sourceQueryChanged = page.source_query !== sourceQuery;
  if (sourceQueryChanged) changes.source_query = sourceQuery;
  await hindsight.updateKnowledgePage(page.id, changes);
  // The server automatically queues a refresh when source_query changes.
  if (sourceQueryChanged) return { message: '人物頁更新成功，正在等待刷新。' };
  try {
    await hindsight.refreshKnowledgePage(page.mental_model_id);
    return { message: '人物頁更新成功，正在等待刷新。' };
  } catch (error) {
    throw new Error(`Person page updates succeeded for key ${key} (page ${page.id}, model ${page.mental_model_id}), but refresh failed: ${error instanceof Error ? error.message : String(error)}`);
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
        const fixedIdentity = /^整理 \{?(?:dc:)?([0-9]{2,32})\}? 的人物頁。/.exec(node.description);
        if (fixedIdentity && typeof node.mental_model_id === 'string') {
          pages.push({ ...node, key: `discord:${fixedIdentity[1]!}`, mental_model_id: node.mental_model_id, source_query: node.description });
        } else if (firstLine.startsWith(prefix) && typeof node.mental_model_id === 'string') {
          let parsed: unknown;
          try { parsed = JSON.parse(firstLine.slice(prefix.length)); } catch { parsed = undefined; }
          if (typeof parsed === 'string') {
            try {
              const key = personKey(text(parsed, 'person key'));
              if (firstLine === `Butler person key: ${JSON.stringify(parsed)}`) pages.push({ ...node, key, mental_model_id: node.mental_model_id, source_query: node.description });
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

function makeSourceQuery(key: string): string {
  return `整理 ${key.slice('discord:'.length)} ${fixedPrompt}`;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new ToolUsageError(`${name} must be a non-empty string without NUL`);
  return value.trim();
}
function integerArg(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new ToolUsageError(`${name} must be an integer from ${min} to ${max}`);
  return value as number;
}
function personKey(key: string): string {
  if (/^[0-9]{2,32}$/.test(key)) return `discord:${key}`;
  if (key.startsWith('discord:')) text(key.slice('discord:'.length), 'Discord account id');
  return key;
}
function isHttpStatus(error: unknown, status: number): boolean { return error instanceof Error && error.message.includes(`HTTP ${status}`); }
