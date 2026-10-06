import type { Hindsight } from './hindsight.js';

const string = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0 };
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}

export const peopleDefinitions = [
  definition('people_list', 'List stored person-profile documents to find existing profiles and identity keys. offset counts profiles (default 0); limit defaults to 50, maximum 100. Use people_get with a profile key to read its complete original content.', { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: integer }, []),
  definition('people_get', 'Read a person-profile document, including original_text and document metadata, by stable identity key. Discord accounts use discord:<account id>; other people use a consistent key. This is the maintained profile, not the person’s complete conversation history; use people_recall to consult supporting memories. An absent profile returns a not-found error.', { key: string }, ['key']),
  definition('people_upsert', 'Create or replace a person profile for an external person discussed in conversation evidence; the system itself is not a person-profile subject. Updates may be made autonomously. content replaces the entire profile, not selected fields, and existing content is not merged automatically. Read the existing profile when present, integrate supported changes and preserve unrelated details. Include relevant source attribution, dates and uncertainty; apply explicit corrections to the affected details and keep unresolved contradictions distinguishable. Discord accounts use discord:<account id>; use a stable key for other people.', { key: string, content: string }, ['key', 'content']),
  definition('people_delete', 'Delete the specified person-profile document and memories extracted from that document when the current speaker explicitly requests deletion. Read the profile first to confirm its identity key. This does not erase mentions of the person in other conversation documents. Discord accounts use discord:<account id>.', { key: string }, ['key']),
  definition('people_recall', 'Look up a person using a stable key and a specific question about the topic and relevant time period. Returns profile, recall evidence and a generated reflect answer with its supporting evidence. The profile is null when absent, but memory lookup still runs. The key and profile supply identity context to the queries, not a strict person-only retrieval filter; check who each retrieved statement is about and who said it.', { key: string, query: string }, ['key', 'query']),
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
      const profileContext = existing ? `Person profile snapshot (background evidence; compare with recalled sources) for ${canonicalName}: ${profileText(existing)}\n` : '';
      const contextualQuery = `${profileContext}Target person: ${canonicalName} (${key})\nQuestion: ${query}\nFind evidence about this identified person, distinguishing the subject of each claim from the person who said it. Preserve source attribution and relevant dates. Separate direct statements, attributed reports and assistant interpretations. Compare the profile with retrieved evidence; distinguish explicit corrections, changes over time and different contexts, and describe unresolved conflicts or missing evidence rather than guessing.`;
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
