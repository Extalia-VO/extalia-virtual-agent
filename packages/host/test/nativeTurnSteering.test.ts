import { expect, it } from 'vitest';
import { runTurn, type AnyTool, type ModelMessage, type ModelProvider, type ModelRequest } from '@extalia/runtime';
import { NativeTurnSteering } from '../src/nativeTurnSteering.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const initial: ModelMessage[] = [{ role: 'user', text: 'original task' }];

it('durably accepts during a tool pipeline and injects after all results in the same invocation', async () => {
  const toolEntered = deferred(), releaseTool = deferred(), admissionEntered = deferred(), releaseAdmission = deferred();
  const persisted: ModelMessage[][] = [], requests: ModelMessage[][] = [];
  const steering = new NativeTurnSteering(initial, async history => {
    admissionEntered.resolve(); await releaseAdmission.promise; persisted.push(structuredClone(history));
  });
  const tool: AnyTool = {
    name: 'read_example', description: 'Read', access: 'read', kind: 'read',
    parameters: { type: 'object', properties: {} }, describe: () => ({ label: 'Read example' }),
    run: async () => { toolEntered.resolve(); await releaseTool.promise; return { ok: true, output: 'tool result' }; },
  };
  const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], async complete(request) {
    requests.push(structuredClone(request.messages) as ModelMessage[]);
    if (requests.length === 1) return { text: '', toolCalls: [{ id: 'call-1', name: tool.name, input: {} }], stop: 'tool_use' };
    expect(persisted).toHaveLength(1);
    return { text: 'finished with steering', toolCalls: [], stop: 'end' };
  } };
  const running = runTurn({ provider, system: 'system', history: [], prompt: 'original task', tools: [tool],
    permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(), emit() {}, requestApproval: async () => 'reject',
    signal: new AbortController().signal, takeSteering: (history, boundary) => steering.take(history, boundary) });
  await toolEntered.promise;
  const accepted = steering.send('change direction');
  await admissionEntered.promise;
  expect(requests).toHaveLength(1);
  releaseTool.resolve();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(requests).toHaveLength(1);
  releaseAdmission.resolve();
  expect(await accepted).toBe('sent');
  const result = await running;
  expect(result.outcome).toBe('completed');
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(initial);
  expect(requests[1]?.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
  expect(requests[1]?.at(-2)).toMatchObject({ role: 'tool', results: [{ toolCallId: 'call-1', content: 'tool result' }] });
  expect(requests[1]?.at(-1)).toEqual({ role: 'user', text: 'change direction' });
  expect(result.history.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
  expect(steering.available).toBe(false);
  await expect(steering.send('too late')).rejects.toThrow('no longer');
});

it('continues an ordinary model final with admitted steering and keeps the in-flight request immutable', async () => {
  const entered = deferred(), release = deferred();
  const requests: ModelMessage[][] = [];
  let inFlight: ModelRequest | undefined;
  const steering = new NativeTurnSteering(initial, async () => {});
  const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], async complete(request) {
    requests.push(structuredClone(request.messages) as ModelMessage[]);
    if (requests.length === 1) { inFlight = request; entered.resolve(); await release.promise; }
    return { text: 'answer', toolCalls: [], stop: 'end' };
  } };
  const running = runTurn({ provider, system: 'system', history: [], prompt: 'original task', tools: [],
    permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(), emit() {}, requestApproval: async () => 'reject',
    signal: new AbortController().signal, takeSteering: (history, boundary) => steering.take(history, boundary) });
  await entered.promise;
  await steering.send('follow up within this run');
  expect(inFlight!.messages).toEqual(initial);
  release.resolve();
  const result = await running;
  expect(requests).toHaveLength(2);
  expect(result.history.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
});

it('serializes concurrent accepted text and preserves it on cancellation without another provider call', async () => {
  const entered = deferred(), release = deferred(), controller = new AbortController();
  const persisted: ModelMessage[][] = [];
  const steering = new NativeTurnSteering(initial, async history => { persisted.push(structuredClone(history)); });
  let calls = 0;
  const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], async complete() {
    calls++; entered.resolve(); await release.promise; return { text: 'late answer', toolCalls: [], stop: 'end' };
  } };
  const running = runTurn({ provider, system: 'system', history: [], prompt: 'original task', tools: [],
    permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(), emit() {}, requestApproval: async () => 'reject',
    signal: controller.signal, takeSteering: (history, boundary) => steering.take(history, boundary) });
  await entered.promise;
  await Promise.all([steering.send('first accepted'), steering.send('second accepted')]);
  controller.abort(); release.resolve();
  const result = await running;
  expect(result.outcome).toBe('cancelled'); expect(calls).toBe(1);
  expect(persisted.map(history => history.map(message => message.role === 'user' ? message.text : ''))).toEqual([
    ['original task', 'first accepted'], ['original task', 'first accepted', 'second accepted'],
  ]);
  expect(result.history).toEqual([...initial, { role: 'user', text: 'first accepted' }, { role: 'user', text: 'second accepted' }]);
});

it('refuses inference when durable acceptance fails and seals the inbox', async () => {
  const steering = new NativeTurnSteering(initial, async () => { throw new Error('disk refused'); });
  await expect(steering.send('must not infer')).rejects.toThrow('disk refused');
  expect(steering.available).toBe(false);
  await expect(steering.take(initial, 'step')).rejects.toThrow('disk refused');
});
