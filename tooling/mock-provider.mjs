#!/usr/bin/env node
/**
 * A scripted OpenAI-compatible endpoint for trying Extalia without an API key
 * and for end-to-end tests. It plays a tiny agent: create `hello.txt`, show it
 * with a command, then summarize. Nothing here calls a real model.
 *
 *   node tooling/mock-provider.mjs [--port 4319]
 *   Connection: preset "Custom endpoint", base URL http://127.0.0.1:4319/v1, model "mock-agent", no key.
 */
import { createServer } from 'node:http';

const portArg = process.argv.indexOf('--port');
const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 4319;

function plan(messages) {
  const lastTool = [...messages].reverse().find(message => message.role === 'assistant' && message.tool_calls?.length);
  const last = messages.at(-1);
  if (last?.role !== 'tool') {
    return { text: "I'll create hello.txt in the project.", tool: { name: 'write_file', arguments: { path: 'hello.txt', content: 'Hello from Extalia\n' } } };
  }
  if (lastTool?.tool_calls[0]?.function?.name === 'write_file') {
    return { text: 'Now I will check the file.', tool: { name: 'run_command', arguments: { command: 'cat hello.txt' } } };
  }
  return { text: 'Created `hello.txt` and checked its contents with `cat`. Nothing else is left to do.' };
}

function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({ model: 'mock-agent', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'mock-agent' }] }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  request.on('data', part => { body += part; });
  request.on('end', async () => {
    const { messages = [] } = JSON.parse(body || '{}');
    const step = plan(messages);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const word of step.text.split(/(?<= )/)) {
      response.write(chunk({ content: word }));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (step.tool) {
      const id = `call_${Date.now().toString(36)}`;
      response.write(chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.arguments) } }] }, 'tool_calls'));
    } else {
      response.write(chunk({}, 'stop'));
    }
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
});

server.listen(port, '127.0.0.1', () => console.log(`Mock provider on http://127.0.0.1:${port}/v1 (model: mock-agent)`));
