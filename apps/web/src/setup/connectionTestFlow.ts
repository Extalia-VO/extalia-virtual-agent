import type { ConnectionTestResult } from '@extalia/platform';
import type { ConnectionDraft } from './validation';

export interface ConnectionTestScope { readonly target: string }
export interface ConnectionTestTicket { scope: ConnectionTestScope; request: number }
export type ConnectionTestState = { kind: 'idle' }
  | ({ kind: 'testing' } & ConnectionTestTicket)
  | ({ kind: 'done'; result: ConnectionTestResult } & ConnectionTestTicket);

/** Only fields that change endpoint authentication invalidate a model-list test. */
export function connectionTestTarget(draft: ConnectionDraft): string {
  return JSON.stringify([
    draft.id, draft.preset, draft.baseUrl.trim().replace(/\/+$/, ''), draft.credentialMode,
    draft.credentialMode === 'key' ? draft.apiKey.trim() : draft.envVariable.trim(),
    draft.credentialMode === 'key' && draft.hasStoredKey,
  ]);
}

export function currentConnectionTest(state: ConnectionTestState, scope: ConnectionTestScope): ConnectionTestState {
  return state.kind !== 'idle' && state.scope === scope ? state : { kind: 'idle' };
}

/** A late reply from another provider, credential edit or older request cannot publish its models. */
export function finishConnectionTest(state: ConnectionTestState, ticket: ConnectionTestTicket, result: ConnectionTestResult): ConnectionTestState {
  return state.kind === 'testing' && state.scope === ticket.scope && state.request === ticket.request
    ? { ...ticket, kind: 'done', result }
    : state;
}
