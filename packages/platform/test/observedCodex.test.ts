import { describe, expect, it } from 'vitest';
import { AGENT_HOST_METHODS, isAgentHostMethod, type AgentHostApi, type ObservedCodexStatus, type ObservedCodexMessageInput, type ObservedCodexAnswerInput } from '../src/index.js';

describe('optional observed Codex host contract', () => {
  it('forwards every explicit control operation through the shared transport allowlist', () => {
    const methods = ['observedCodexStatus', 'connectObservedCodex', 'disconnectObservedCodex', 'sendObservedCodexMessage', 'answerObservedCodexInput'] as const;
    methods.forEach(method => { expect(isAgentHostMethod(method)).toBe(true); expect(AGENT_HOST_METHODS.filter(value => value === method)).toHaveLength(1); });
    expect(isAgentHostMethod('spawnObservedCodex')).toBe(false);
  });
  it('exports portable DTOs and keeps existing hosts compatible', () => {
    const status: ObservedCodexStatus = { sessionId: 'session', state: 'disconnected', canSend: false, canAnswer: false, requests: [] };
    const message: ObservedCodexMessageInput = { connectionId: 'connection', text: 'hello' };
    const answer: ObservedCodexAnswerInput = { connectionId: 'connection', requestId: 'request', answers: { question: 'chosen explicitly' } };
    const olderHost: Pick<AgentHostApi, 'observedCodexStatus' | 'connectObservedCodex' | 'disconnectObservedCodex' | 'sendObservedCodexMessage' | 'answerObservedCodexInput'> = {};
    expect(olderHost.observedCodexStatus).toBeUndefined();
    expect(status.canSend).toBe(false); expect(message.text).toBe('hello'); expect(answer.answers.question).toBe('chosen explicitly');
  });
});
