/** A rejected tool request that the model can correct, before any mutation. */
export class ToolUsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolUsageError';
  }
}
