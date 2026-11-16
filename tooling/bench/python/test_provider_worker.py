"""Focused stdlib tests; all HTTP fixtures are synthetic loopback sockets."""
import asyncio
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import uuid

FILE = Path(__file__).with_name('provider_worker.py')
spec = importlib.util.spec_from_file_location('provider_worker', FILE)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def event(value):
    return 'data: ' + worker.dumps(value) + '\n\n'


def payload(ident, base, model='small'):
    return {'schema': worker.COMPLETE_SCHEMA, 'requestId': ident, 'clientVersion': 'test',
            'connection': {'baseUrl': base, 'model': model}, 'system': 'Synthetic system.',
            'messages': [{'role': 'user', 'text': 'Hello 世界🙂'}], 'tools': [], 'timeoutMs': 3000, 'requestUsage': True}


class StateTests(unittest.TestCase):
    def test_request_images_order_and_prior_numeric_arguments(self):
        ident = str(uuid.uuid4())
        request = payload(ident, 'http://127.0.0.1:1/v1')
        request['messages'] = [{'role': 'user', 'text': '', 'images': [{'mimeType': 'image/png', 'data': 'c3ludGhldGlj'}]},
                               {'role': 'assistant', 'text': '', 'toolCalls': [{'id': 'prior', 'name': 'lookup', 'input': {'zeta': '世界🙂', 'tiny': 1e-7, 'small': 0.000001, 'large': 1e21, 'alpha': 1}}]},
                               {'role': 'tool', 'results': [{'toolCallId': 'prior', 'name': 'lookup', 'content': 'synthetic', 'isError': True}]}]
        raw = worker.dumps(request).replace('1e-07', '1e-7').replace('1e-06', '0.000001').replace('1e+21', '1e+21')
        prepared = worker.prepare(worker.loads(raw, preserve_numbers=True), ident)
        messages = prepared[3]['messages']
        self.assertEqual(messages[1]['content'][-1]['text'], 'Attached image.')
        self.assertEqual(messages[2]['tool_calls'][0]['function']['arguments'], '{"zeta":"世界🙂","tiny":1e-7,"small":0.000001,"large":1e+21,"alpha":1}')
        self.assertEqual(messages[2]['content'], None)
        self.assertEqual(messages[3]['content'], 'Error: synthetic')

    def test_request_validation(self):
        ident = str(uuid.uuid4())
        for change in ({'timeoutMs': True}, {'timeoutMs': 0}, {'schema': 'bad'}, {'requestUsage': 1}, {'tools': [{}]}):
            value = payload(ident, 'http://127.0.0.1:1/v1')
            value.update(change)
            with self.assertRaises(worker.Failure):
                worker.prepare(value, ident)
        for base in ('http://user@example.com', 'http://example.com?token=x', 'file:///tmp', 'http://example.com\\path'):
            with self.assertRaises(worker.Failure):
                worker.prepare(payload(ident, base), ident)

    def test_usage_invalidation_and_cached_cross_fields(self):
        state = worker.State()
        state.absorb({'usage': {'prompt_tokens': 10, 'completion_tokens': 3, 'prompt_tokens_details': {'cached_tokens': 8}}})
        state.absorb({'choices': [{'delta': {'usage': {'prompt_tokens': -1, 'completion_tokens': True}}}]})
        self.assertEqual(state.finish()['usage'], {'cachedInputTokens': 8})
        state.absorb({'usage': {'input_tokens': 4, 'output_tokens': 9007199254740992}})
        self.assertEqual(state.finish()['usage'], {'inputTokens': 4})
        self.assertEqual(state.finish()['promptTokens'], 4)

    def test_indexed_tools_and_argument_errors(self):
        state = worker.State()
        state.absorb({'choices': [{'delta': {'tool_calls': [
            {'index': 1, 'function': {'name': 'broken', 'arguments': '{invalid'}},
            {'index': 0, 'id': 'good', 'function': {'name': 'look', 'arguments': '{"query":'}}]}}]})
        state.absorb({'choices': [{'delta': {'tool_calls': [{'index': 0, 'function': {'name': 'up', 'arguments': '"sample"}'}}]}}]})
        result = state.finish()
        self.assertEqual(result['stop'], 'tool_use')
        self.assertEqual(result['toolCalls'][0], {'id': 'good', 'name': 'lookup', 'input': {'query': 'sample'}})
        self.assertEqual(result['toolCalls'][1]['inputError'], 'Tool arguments were not valid JSON.')

    def test_truncation_and_refusal_disable_tools(self):
        for reason in ('length', 'content_filter'):
            state = worker.State()
            state.absorb({'choices': [{'message': {'tool_calls': [{'id': 'call', 'function': {'name': 'f', 'arguments': '{"run":true}'}}]}, 'finish_reason': reason}]})
            result = state.finish()
            if reason == 'length':
                self.assertEqual(result['toolCalls'][0]['input'], {})
                self.assertIn('truncated', result['toolCalls'][0]['inputError'])
            else:
                self.assertEqual(result['toolCalls'], [])
                self.assertEqual(result['stop'], 'refusal')

    def test_sse_utf8_crlf_multiline_malformed_final(self):
        parser = worker.Sse()
        raw = ': comment\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"世界🙂"}}]}\r\n\r\ndata: invalid\n\ndata: {"usage":{"prompt_tokens":3}}'.encode()
        values = []
        for byte in raw:
            values.extend(parser.feed(bytes([byte])))
        values.extend(parser.feed(b'', eof=True))
        self.assertEqual(values, [{'choices': [{'delta': {'content': '世界🙂'}}]}, {'usage': {'prompt_tokens': 3}}])

    def test_sse_many_events_and_long_event_across_transport_chunks(self):
        expected = [{'choices': [{'delta': {'content': 'δ' * 20000 if index == 50 else f'fragment {index} 世界🙂'}}]}
                    for index in range(100)]
        raw = ''.join(event(value).replace('\n', '\r\n') if index % 2 else event(value)
                      for index, value in enumerate(expected)).encode()
        raw += b'data: [DONE]\r\n\r\n'
        parser, values, offset = worker.Sse(), [], 0
        widths = (8192, 3, 1, 2048)
        turn = 0
        while offset < len(raw):
            width = widths[turn % len(widths)]
            values.extend(parser.feed(raw[offset:offset + width]))
            offset += width
            turn += 1
        values.extend(parser.feed(b'', eof=True))
        self.assertEqual(values, expected)
        self.assertTrue(parser.done)

    def test_parser_and_structure_limits(self):
        parser = worker.Sse()
        with self.assertRaises(worker.Failure) as raised:
            parser.feed(b'x' * (worker.PENDING_LIMIT + 1))
        self.assertEqual(raised.exception.code, 'response_too_large')
        state = worker.State()
        with self.assertRaises(worker.Failure):
            state.absorb({'choices': [{'delta': {'tool_calls': [{'index': -1}]}}]})
        state.text_bytes = worker.TEXT_LIMIT
        with self.assertRaises(worker.Failure):
            state.absorb({'choices': [{'delta': {'content': 'x'}}]})
        self.assertFalse(worker.bounded(nested(66)))
        self.assertFalse(worker.counter(10 ** 1000))
        self.assertFalse(worker.bounded({'huge': 10 ** 1000}))


def nested(count):
    value = {}
    for _ in range(count):
        value = {'child': value}
    return value


class DeltaTests(unittest.IsolatedAsyncioTestCase):
    async def test_long_fragment_preserves_utf8_and_frame_boundaries(self):
        instance = worker.Worker(str(uuid.uuid4()))
        operation = worker.Operation(str(uuid.uuid4()), 1)
        frames = []

        async def capture(payload, owner):
            self.assertIs(owner, operation)
            frames.append(payload)
            owner.seq += 1

        instance.emit = capture
        text = 'a' * 16383 + '🙂' + '世界δ' * 20000 + 'end'
        await instance.delta(operation, text)
        self.assertEqual(''.join(frame['text'] for frame in frames), text)
        self.assertGreater(len(frames), 10)
        self.assertEqual(worker.size(frames[0]['text']), 16383)
        self.assertTrue(frames[1]['text'].startswith('🙂'))
        self.assertTrue(all(frame['kind'] == 'delta' and 0 < worker.size(frame['text']) <= 16384 for frame in frames))
        self.assertTrue(all(worker.size(frame['text']) >= 16381 for frame in frames[:-1]))
        self.assertEqual(operation.seq, len(frames))


class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.connections, self.requests, self.closed = 0, [], asyncio.Event()
        self.handlers, self.writers = set(), set()
        self.server = await asyncio.start_server(self.handle_http, '127.0.0.1', 0)
        self.base = 'http://127.0.0.1:' + str(self.server.sockets[0].getsockname()[1]) + '/v1'
        self.temp = tempfile.TemporaryDirectory(prefix='extalia-python-worker-test-')
        self.ident = str(uuid.uuid4())
        self.process = await asyncio.create_subprocess_exec(sys.executable, '-I', '-u', str(FILE), '--provider-worker', self.ident,
                                                            cwd=self.temp.name, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.assertEqual((await self.read())['kind'], 'hello')

    async def asyncTearDown(self):
        if self.process.returncode is None:
            self.send_control('S')
            await asyncio.wait_for(self.process.wait(), 5)
        self.assertEqual(await self.process.stderr.read(), b'')
        self.server.close()
        await self.server.wait_closed()
        for writer in self.writers:
            writer.close()
        if self.handlers:
            await asyncio.gather(*list(self.handlers), return_exceptions=True)
        self.temp.cleanup()

    async def handle_http(self, reader, writer):
        task = asyncio.current_task()
        self.handlers.add(task)
        self.writers.add(writer)
        self.connections += 1
        try:
            while True:
                try:
                    head = await reader.readuntil(b'\r\n\r\n')
                except asyncio.IncompleteReadError:
                    return
                headers = dict(line.decode().split(': ', 1) for line in head.split(b'\r\n')[1:-2])
                body = worker.loads(await reader.readexactly(int(headers['Content-Length'])))
                self.requests.append(body)
                mode = body['model']
                chunk = event({'model': 'synthetic-model', 'choices': [{'delta': {'content': 'Hello 世界🙂'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 3}}).encode()
                if mode == 'cancel':
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n' + f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                    await writer.drain()
                    await reader.read()
                    self.closed.set()
                    return
                if mode == 'slow':
                    await asyncio.sleep(0.15)
                if mode == 'retry' and 'stream_options' in body:
                    error = b'{"error":{"message":"unsupported stream_options"}}'
                    writer.write(b'HTTP/1.1 400 Bad Request\r\nContent-Length: ' + str(len(error)).encode() + b'\r\n\r\n' + error)
                elif mode == 'json':
                    response = b'{"choices":[{"message":{"content":"json answer"},"finish_reason":"stop"}]}'
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(response)).encode() + b'\r\n\r\n' + response)
                elif mode == 'cut':
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\ndata: {}')
                    return
                elif mode == 'error':
                    response = b'{"error":{"message":"quota exhausted secret synthetic"}}'
                    writer.write(b'HTTP/1.1 429 Too Many Requests\r\nContent-Length: ' + str(len(response)).encode() + b'\r\n\r\n' + response)
                elif mode == 'eof':
                    writer.write(b'HTTP/1.0 200 OK\r\nContent-Type: text/event-stream\r\n\r\n' + chunk.rstrip(b'\n'))
                    return
                else:
                    response = chunk + b'data: [DONE]\n\n'
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n')
                    # Force arbitrary transport slices across Unicode/SSE boundaries.
                    for offset in range(0, len(response), 7):
                        part = response[offset:offset + 7]
                        writer.write(f'{len(part):x}\r\n'.encode() + part + b'\r\n')
                    writer.write(b'0\r\nX-Synthetic: fixture\r\n\r\n')
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()
            self.writers.discard(writer)
            self.handlers.discard(task)

    def write(self, body):
        self.process.stdin.write(struct.pack('<I', len(body)) + body)

    def send_control(self, op, ident=None, count=None, worker_id=None):
        body = {'schema': worker.SCHEMA, 'workerId': worker_id or self.ident}
        if ident is not None:
            body['requestId'] = ident
        if count is not None:
            body['bytes'] = count
        self.write(op.encode() + worker.dumps(body).encode())

    def admit(self, mode='small', commit=True):
        ident = str(uuid.uuid4())
        raw = worker.dumps(payload(ident, self.base, mode)).encode()
        self.send_control('B', ident, len(raw))
        for offset in range(0, len(raw), 16384):
            self.write(b'C' + self.ident.encode() + ident.encode() + raw[offset:offset + 16384])
        if commit:
            self.send_control('E', ident)
        return ident

    async def read(self):
        header = await asyncio.wait_for(self.process.stdout.readexactly(4), 5)
        return worker.loads(await asyncio.wait_for(self.process.stdout.readexactly(struct.unpack('<I', header)[0]), 5))

    async def receipt(self, ident):
        frames = []
        while True:
            frame = await self.read()
            self.assertEqual(frame['requestId'], ident)
            self.assertEqual(frame['seq'], len(frames))
            frames.append(frame)
            if frame['kind'] == 'settled':
                self.assertTrue(frame['joined'])
                return frames

    async def test_streaming_keepalive_reuse(self):
        for _ in range(2):
            ident = self.admit()
            frames = await self.receipt(ident)
            self.assertEqual(''.join(f['text'] for f in frames if f['kind'] == 'delta'), 'Hello 世界🙂')
            self.assertEqual(frames[-2]['result']['model'], 'synthetic-model')
        self.assertEqual(self.connections, 1)
        self.assertEqual(len(self.requests), 2)

    async def test_json_eof_retry_and_http_error(self):
        for mode in ('json', 'eof', 'retry', 'error', 'cut'):
            frames = await self.receipt(self.admit(mode))
            terminal = frames[-2]
            if mode == 'error':
                self.assertEqual((terminal['code'], terminal['status'], terminal['retryable']), ('http_error', 429, True))
                self.assertNotIn('secret', worker.dumps(terminal))
            elif mode == 'cut':
                self.assertEqual(terminal['code'], 'transport_error')
            else:
                self.assertEqual(terminal['kind'], 'result')
                if mode == 'retry':
                    self.assertTrue(terminal['streamOptionsRejected'])

    async def test_cancel_closes_transport_and_other_request_survives(self):
        cancelled = self.admit('cancel')
        self.assertEqual((await self.read())['kind'], 'delta')
        other = self.admit('slow')
        self.send_control('X', cancelled)
        frames = [await self.read(), await self.read()]
        self.assertEqual([frame['kind'] for frame in frames], ['error', 'settled'])
        self.assertEqual(frames[0]['requestId'], cancelled)
        self.assertEqual(frames[0]['code'], 'cancelled')
        await asyncio.wait_for(self.closed.wait(), 1)
        self.assertEqual((await self.receipt(other))[-2]['kind'], 'result')

    async def test_cancel_before_commit_and_retired_trailing_frames(self):
        ident = self.admit(commit=False)
        self.send_control('X', ident)
        self.assertEqual((await self.receipt(ident))[-2]['code'], 'cancelled')
        self.write(b'C' + self.ident.encode() + ident.encode() + b'ignored')
        self.send_control('E', ident)
        self.assertEqual((await self.receipt(self.admit()))[-2]['kind'], 'result')
        self.assertEqual(len(self.requests), 1)

    async def test_cancel_immediately_after_commit_has_no_http_effects(self):
        ident = self.admit()
        self.send_control('X', ident)
        self.assertEqual((await self.receipt(ident))[-2]['code'], 'cancelled')
        self.assertEqual(self.requests, [])

    async def test_busy_is_terminal_before_http(self):
        ids = []
        for _ in range(33):
            ident = str(uuid.uuid4())
            ids.append(ident)
            self.send_control('B', ident, 1)
        self.assertEqual((await self.receipt(ids[-1]))[-2]['code'], 'busy')
        self.write(b'C' + self.ident.encode() + ids[-1].encode() + b'x')
        self.send_control('E', ids[-1])
        for ident in ids[:-1]:
            self.send_control('X', ident)
            self.assertEqual((await self.receipt(ident))[-2]['code'], 'cancelled')
        self.assertEqual(self.requests, [])

    async def test_foreign_control_drains_live_transport_without_effect(self):
        self.admit('cancel')
        await self.read()
        self.send_control('B', str(uuid.uuid4()), 1, worker_id=str(uuid.uuid4()))
        await asyncio.wait_for(self.process.wait(), 5)
        self.assertEqual(self.process.returncode, 1)
        await asyncio.wait_for(self.closed.wait(), 1)
        self.assertEqual(len(self.requests), 1)

    async def test_duplicate_begin_never_replays_http(self):
        ident = self.admit()
        await self.receipt(ident)
        self.send_control('B', ident, 1)
        await asyncio.wait_for(self.process.wait(), 5)
        self.assertEqual(self.process.returncode, 1)
        self.assertEqual(len(self.requests), 1)

    async def test_shutdown_and_eof_join_active_transport(self):
        self.admit('cancel')
        await self.read()
        self.process.stdin.close()
        await asyncio.wait_for(self.process.wait(), 5)
        self.assertEqual(self.process.returncode, 0)
        await asyncio.wait_for(self.closed.wait(), 1)


if __name__ == '__main__':
    unittest.main()
