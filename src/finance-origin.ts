export type FinanceIdentity = { kind: 'interactive_discord' | 'scheduler' | 'subagent_internal'; requesterId?: string; channelId?: string; messageId?: string; human?: boolean };

export function financeInteractiveOrigin(input: { requesterId?: string; channelId?: string; messageId?: string; human: boolean }): FinanceIdentity {
  return { kind: 'interactive_discord', requesterId: input.requesterId, channelId: input.channelId, messageId: input.messageId, human: input.human };
}

export function financeNonInteractiveOrigin(kind: 'scheduler' | 'subagent_internal'): FinanceIdentity { return { kind }; }

export function isAuthorizedFinanceOrigin(origin: FinanceIdentity | undefined): boolean {
  return origin?.kind === 'interactive_discord' && typeof origin.messageId === 'string' && /^[0-9]{17,20}$/.test(origin.messageId);
}
