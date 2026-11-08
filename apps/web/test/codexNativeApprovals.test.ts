import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, ObservedCodexApprovalRequest, ObservedCodexStatus } from '@extalia/platform';
import { expect, it, vi } from 'vitest';
import { CodexApprovalCard } from '../src/observe/ObservedCodexControls';
import { createObservedCodexControl } from '../src/observe/observedCodexModel';
import { MESSAGES } from '../src/i18n';
const approval = (): ObservedCodexApprovalRequest => ({ id: 'approval', turnId: 'turn', itemId: 'item', state: 'pending', availableDecisions: ['accept', 'cancel'], kind: 'commandExecution', commandKind: 'writeStdin', command: '\u0003yes\n', cwd: '/projects/example' });
const connected = (): ObservedCodexStatus => ({ sessionId: 'session', state: 'connected', connectionId: 'connection', threadId: 'native', activeTurnId: 'turn', canSend: false, canAnswer: false, canApprove: true, requests: [], approvals: [approval()] });
it.each(['en', 'id'] as const)('renders exact stdin type/control bytes and no preselected permission in %s', language => {
  const html = renderToStaticMarkup(createElement(CodexApprovalCard, { t: MESSAGES[language], request: approval(), disabled: false, onAnswer: vi.fn() }));
  expect(html).toContain(MESSAGES[language].observedCodex.commandKinds.writeStdin);
  expect(html).toContain('\\u0003yes\\n'); expect(html).not.toContain('checked=""'); expect(html).toContain('disabled=""');
});
it('shows complete file changes and exact requested permissions', () => {
  const base = { id: 'a', turnId: 'turn', itemId: 'item', state: 'pending' as const, availableDecisions: ['decline' as const] };
  const render = (request: ObservedCodexApprovalRequest) => renderToStaticMarkup(createElement(CodexApprovalCard, { t: MESSAGES.en, request, disabled: false, onAnswer: vi.fn() }));
  const html = render({ ...base, kind: 'fileChange', grantRoot: '/projects/root', changes: [{ path: '/projects/example/file.txt', diff: '+exact replacement', kind: { type: 'update', move_path: '/projects/example/new.txt' } }] });
  expect(html).toContain('+exact replacement'); expect(html).toContain('/projects/example/new.txt'); expect(html).toContain(MESSAGES.en.observedCodex.rootGrantSourceOnly);
  const permissions = render({ ...base, kind: 'permissions', scope: 'turn', permissions: { network: { enabled: true }, fileSystem: { write: ['/projects/example'] } } });
  expect(permissions).toContain('/projects/example'); expect(permissions).toContain('network'); expect(permissions).toContain('enabled');
});
it('sends only a current, explicitly offered native decision and suppresses duplicate submissions', async () => {
  const status = connected();
  const api = { observedCodexStatus: vi.fn(async () => status), connectObservedCodex: vi.fn(), disconnectObservedCodex: vi.fn(), sendObservedCodexMessage: vi.fn(), answerObservedCodexInput: vi.fn(), answerObservedCodexApproval: vi.fn(async () => ({ ...connected(), delivery: 'submitted' as const })) };
  const model = createObservedCodexControl(api as unknown as AgentHostApi, 'session'), stop = model.start();
  try {
    await model.refresh(); await Promise.resolve(); await Promise.resolve();
    await model.approve(approval(), 'decline'); expect(api.answerObservedCodexApproval).not.toHaveBeenCalled();
    await model.approve(approval(), 'cancel'); await model.approve(approval(), 'cancel');
    expect(api.answerObservedCodexApproval).toHaveBeenCalledExactlyOnceWith('session', { connectionId: 'connection', requestId: 'approval', decision: 'cancel' });
  } finally { stop(); }
});
