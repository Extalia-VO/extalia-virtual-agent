import { describe, expect, it } from 'vitest';
import { codexUserInputEvidence } from '../src/codexUserInput.js';
const call = { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'call-one', arguments: JSON.stringify({ questions: [{ title: 'Which scope?', options: ['One', 'Two'] }, { title: 'Describe the outcome.' }] }) } };
const accepted = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-one', output: '{"accepted":true}' } };
describe('verified Codex async input metadata', () => {
  it('requires exact supported call identity and acceptance and survives ordinary work', () => {
    expect(codexUserInputEvidence([call]).requests[0]?.canAnswer).toBe(false);
    const result = codexUserInputEvidence([call, accepted, { type: 'event_msg', payload: { type: 'task_complete' } }]);
    expect(result.requests).toEqual([{ callId: 'call-one', canAnswer: true, questions: [{ title: 'Which scope?', options: ['One', 'Two'] }, { title: 'Describe the outcome.', options: [] }] }]);
    expect(codexUserInputEvidence([{ ...call, payload: { ...call.payload, name: 'another_tool' } }, accepted]).requests).toEqual([]);
  });
  it('reads completed native item identity and deduplicates the idless legacy mirror', () => {
    const questions = [{ title: 'Continue?', options: null }];
    const result = codexUserInputEvidence([
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'call-two', delivery: 'async', questions } } },
      { type: 'event_msg', payload: { type: 'agent_message', delivery: 'async', questions } },
    ]);
    expect(result.requests).toEqual([{ callId: 'call-two', canAnswer: true, questions: [{ title: 'Continue?', options: [] }] }]);
    expect(codexUserInputEvidence([{ type: 'event_msg', payload: { type: 'agent_message', delivery: 'async', questions } }]).requests[0]?.canAnswer).toBe(false);
  });
  it('never overwrites a positively correlated reply with a contradictory later title', () => {
    const reply = (question: string) => ({ type: 'event_msg', payload: { type: 'user_message', message: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: '["request_user_input_async","call-one",0]', question, answer: 'One' }])}</send_user_message_question_reply>` } });
    expect(codexUserInputEvidence([call, accepted, reply('Which scope?'), reply('Different title')]).replies).toHaveLength(2);
  });
  it('keeps recent questions after more than the historical request bound', () => {
    const rows = Array.from({ length: 160 }, (_, index) => [
      { ...call, payload: { ...call.payload, call_id: `call-${index}` } },
      { ...accepted, payload: { ...accepted.payload, call_id: `call-${index}` } },
    ]).flat();
    const result = codexUserInputEvidence(rows);
    expect(result.requests).toHaveLength(128);
    expect(result.requests.at(-1)).toMatchObject({ callId: 'call-159', canAnswer: true });
    expect(result.requests[0]?.callId).toBe('call-32');
  });
  it('retains only bounded exact reply envelopes, with no answer contents in metadata', () => {
    const message = `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: '["request_user_input_async","call-one",0]', question: 'Which scope?', answer: 'One' }])}</send_user_message_question_reply>`;
    expect(codexUserInputEvidence([{ type: 'event_msg', payload: { type: 'user_message', message } }]).replies).toEqual([{ questionItemId: '["request_user_input_async","call-one",0]', question: 'Which scope?' }]);
    expect(codexUserInputEvidence([{ type: 'event_msg', payload: { type: 'user_message', message: `Quoted: ${message}` } }]).replies).toEqual([]);
    expect(codexUserInputEvidence([{ ...call, payload: { ...call.payload, arguments: JSON.stringify({ questions: [{ title: 'x'.repeat(2001) }] }) } }]).requests).toEqual([]);
  });
});
