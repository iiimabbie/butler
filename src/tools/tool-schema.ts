import { ToolUsageError } from './tool-errors.js';

/** Responses may normalize omitted strict into all-required schemas.
 * Preserve Butler's omission-based optional arguments; runtime validation still applies.
 * Explicit strict settings and non-function tools are left unchanged.
 */
export function preserveOptionalToolArguments<T extends Record<string, unknown>>(tool: T): T {
  return tool.type === 'function' && tool.strict === undefined ? { ...tool, strict: false } : tool;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Schema = Record<string, unknown>;

/** Validate a value against the JSON-schema subset used by Butler's tool definitions. */
export function validateValue(rule: Schema, value: unknown, path = 'arguments'): void {
  if (Array.isArray(rule.type)) {
    if (value === null && rule.type.includes('null')) return;
    rule = { ...rule, type: rule.type.find(type => type !== 'null') };
  }
  const invalid = (): never => { throw new ToolUsageError(`${path} is invalid`); };
  if (rule.type === 'boolean') { if (typeof value !== 'boolean') invalid(); return; }
  if (rule.type === 'string') {
    if (typeof value !== 'string' || value.length < Number(rule.minLength ?? 0) || value.length > Number(rule.maxLength ?? Infinity) || (rule.pattern && !new RegExp(String(rule.pattern)).test(value)) || (Array.isArray(rule.enum) && !rule.enum.includes(value))) invalid();
    return;
  }
  if (rule.type === 'integer') {
    if (!Number.isSafeInteger(value) || Number(value) < Number(rule.minimum ?? -Infinity) || Number(value) > Number(rule.maximum ?? Infinity)) invalid();
    return;
  }
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < Number(rule.minItems ?? 0) || value.length > Number(rule.maxItems ?? Infinity) || (rule.uniqueItems === true && new Set(value).size !== value.length)) invalid();
    for (let index = 0; index < (value as unknown[]).length; index++) validateValue(rule.items as Schema, (value as unknown[])[index], `${path}[${index}]`);
    return;
  }
  if (rule.type === 'object') {
    if (!isRecord(value)) return invalid();
    const properties = isRecord(rule.properties) ? rule.properties : {};
    if (Array.isArray(rule.required)) for (const key of rule.required) if (typeof key === 'string' && !(key in value)) throw new ToolUsageError(`${path}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      const child = properties[key];
      if (!child) { if (rule.additionalProperties !== true) throw new ToolUsageError(`Unexpected argument: ${path}.${key}`); continue; }
      validateValue(child as Schema, item, `${path}.${key}`);
    }
  }
}

/** Validate tool arguments against an object schema built from its properties and required keys. */
export function validateToolArgs(properties: Record<string, unknown>, required: readonly string[], args: Record<string, unknown>): void {
  validateValue({ type: 'object', properties, required, additionalProperties: false }, args);
}
