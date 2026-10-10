/** Responses may normalize omitted strict into all-required schemas.
 * Preserve Butler's omission-based optional arguments; runtime validation still applies.
 * Explicit strict settings and non-function tools are left unchanged.
 */
export function preserveOptionalToolArguments<T extends Record<string, unknown>>(tool: T): T {
  return tool.type === 'function' && tool.strict === undefined ? { ...tool, strict: false } : tool;
}
