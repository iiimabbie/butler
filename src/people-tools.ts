import type { Hindsight } from './hindsight.js';

const string = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0 };
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}

export const peopleDefinitions = [
  definition('people_list', 'List person profiles.', { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: integer }, []),
  definition('people_get', 'Read a person profile by key (Discord keys use discord:<account id>).', { key: string }, ['key']),
  definition('people_upsert', 'Create or replace a person profile. Read the complete current profile first, then supply the complete replacement, changing only explicitly requested details and preserving unrelated information. Use discord:<id> for Discord accounts; other stable keys must not imitate Discord IDs.', { key: string, content: string }, ['key', 'content']),
  definition('people_delete', 'Delete a person profile only when explicitly requested; read it first to confirm the target.', { key: string }, ['key']),
  definition('people_recall', 'Read the profile and recall relevant memories. Treat them as evidence and do not attribute another speaker’s statements to this person.', { key: string, query: string }, ['key', 'query']),
];

export type PeopleToolRuntime = {
  definitions: typeof peopleDefinitions;
  execute(name: string, args: Record<string, unknown>, ...context: unknown[]): Promise<unknown>;
};

export function createPeopleToolRuntime(hindsight: Hindsight): PeopleToolRuntime {
  return {
    definitions: peopleDefinitions,
    async execute(name, args) {
      const allowed: Record<string, string[]> = {
        people_list: ['limit', 'offset'], people_get: ['key'], people_upsert: ['key', 'content'],
        people_delete: ['key'], people_recall: ['key', 'query'],
      };
      const keys = allowed[name];
      if (!keys) throw new Error(`Unknown people tool: ${name}`);
      if (Object.keys(args).some(key => !keys.includes(key))) throw new Error('Unknown people tool argument');
      if (name === 'people_list') {
        const limit = integerArg(args.limit, 50, 1, 100, 'limit');
        const offset = integerArg(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
        return hindsight.listPersonDocuments(limit, offset);
      }
      const key = personKey(text(args.key, 'key'));
      const canonicalName = key.startsWith('discord:') ? `Discord account ${key.slice('discord:'.length)}` : `Person ${key}`;
      const documentId = `butler-person:${key}`;
      if (name === 'people_get') return profile(hindsight, documentId);
      if (name === 'people_upsert') {
        const content = text(args.content, 'content');
        try { await profile(hindsight, documentId); } catch (error) { if (!isNotFound(error)) throw error; }
        return hindsight.retainPersonProfile(key, content, canonicalName);
      }
      if (name === 'people_delete') {
        await profile(hindsight, documentId);
        return hindsight.deleteDocument(documentId);
      }
      const query = text(args.query, 'query');
      let existing: Record<string, unknown> | null;
      try { existing = await profile(hindsight, documentId); }
      catch (error) { if (!isNotFound(error)) throw error; existing = null; }
      const profileContext = existing ? `Person profile (${canonicalName}): ${profileText(existing)}\n` : '';
      const contextualQuery = `${profileContext}Person identity: ${canonicalName} (${key})\nQuestion: ${query}\nUse memories only as evidence. Distinguish who said each thing; do not attribute statements by other speakers to this person.`;
      const [recall, reflect] = await Promise.all([hindsight.recall(contextualQuery), hindsight.reflect(contextualQuery)]);
      return { profile: existing, recall, reflect };
    },
  };
}

async function profile(hindsight: Hindsight, documentId: string): Promise<Record<string, unknown>> {
  const value = record(await hindsight.getDocument(documentId));
  if (value.id !== documentId || typeof value.original_text !== 'string') throw new Error('Hindsight person profile response is invalid');
  return value;
}
function profileText(value: Record<string, unknown>): string { return value.original_text as string; }
function text(value: unknown, name: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0')) throw new Error(`${name} must be ${empty ? 'a' : 'a non-empty'} string without NUL`);
  return value;
}
function integerArg(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value as number;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Hindsight person profile response is invalid');
  return value as Record<string, unknown>;
}
function personKey(key: string): string {
  if (key.startsWith('discord:')) text(key.slice('discord:'.length), 'Discord account id');
  return key;
}
function isNotFound(error: unknown): boolean { return error instanceof Error && /^Hindsight returned HTTP 404$/.test(error.message); }
