#!/usr/bin/env python3
"""Development-only stdlib asyncio completion benchmark worker (Python 3.13+).

No runtime/tool execution or profile access. The host owns lifetime/idle retirement.
HTTP/1.1 only, verified TLS, no ambient proxies, redirects or automatic replay.
"""
import asyncio
import json
import math
import queue
import re
import ssl
import struct
import sys
import threading
from urllib.parse import urlsplit

SCHEMA = 'extalia.provider-worker.v1'
COMPLETE_SCHEMA = 'extalia.provider-complete.v1'
MIB = 1024 * 1024
REQUEST_LIMIT, INTAKE_LIMIT = 128 * MIB, 256 * MIB
WIRE_LIMIT, TEXT_LIMIT, PENDING_LIMIT = 64 * MIB, 8 * MIB, 2 * MIB
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
TOKEN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
SSE_BOUNDARY = re.compile(br'\r?\n\r?\n')


class Failure(Exception):
    def __init__(self, code, status=None, retryable=False):
        self.code, self.status, self.retryable = code, status, retryable


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


class LiteralFloat(float):
    def __new__(cls, literal):
        result = super().__new__(cls, literal)
        result.literal = literal
        return result


def argument_json(value):
    # The neutral request was serialized by Node. Preserve its float spelling in
    # prior tool argument strings, where numeric formatting is provider-visible.
    if isinstance(value, LiteralFloat):
        return value.literal
    if isinstance(value, dict):
        return '{' + ','.join(dumps(k) + ':' + argument_json(v) for k, v in value.items()) + '}'
    if isinstance(value, list):
        return '[' + ','.join(argument_json(v) for v in value) + ']'
    return dumps(value)


def loads(value, preserve_numbers=False):
    def invalid(_):
        raise ValueError('nonfinite')
    if isinstance(value, (bytes, bytearray)):
        value = value.decode('utf-8')
    return json.loads(value, parse_constant=invalid, **({'parse_float': LiteralFloat} if preserve_numbers else {}))


def size(value):
    return len(value.encode('utf-8'))


def counter(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 9007199254740991 and math.isfinite(value) and value == int(value)


def bounded(value):
    remaining = 100000
    def visit(item, depth):
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 64:
            return False
        if isinstance(item, dict):
            return all(visit(v, depth + 1) for v in item.values())
        if isinstance(item, list):
            return all(visit(v, depth + 1) for v in item)
        return item is None or type(item) in (str, bool) or (isinstance(item, (int, float)) and -1.7976931348623157e308 <= item <= 1.7976931348623157e308 and math.isfinite(item))
    return visit(value, 0)


def clean(value, limit):
    return isinstance(value, str) and size(value) <= limit and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value)


def fields(value, allowed, required=()):
    return isinstance(value, dict) and value.keys() <= set(allowed) and set(required) <= value.keys()


def require(ok):
    if not ok:
        raise Failure('invalid_request')


def prepare(request, request_id):
    require(fields(request, ('schema', 'requestId', 'clientVersion', 'connection', 'system', 'messages', 'tools', 'timeoutMs', 'requestUsage'),
                   ('schema', 'requestId', 'clientVersion', 'connection', 'system', 'messages', 'tools', 'timeoutMs', 'requestUsage')))
    require(request['schema'] == COMPLETE_SCHEMA and request['requestId'] == request_id)
    require(clean(request['clientVersion'], 64) and request['clientVersion'].strip())
    require(type(request['timeoutMs']) is int and 1 <= request['timeoutMs'] <= 600000 and type(request['requestUsage']) is bool)
    require(isinstance(request['system'], str))
    connection = request['connection']
    require(fields(connection, ('baseUrl', 'model', 'apiKey', 'headers'), ('baseUrl', 'model')))
    require(clean(connection['model'], 4096) and connection['model'].strip())
    require(isinstance(connection['baseUrl'], str))
    base = connection['baseUrl'].strip()
    require(clean(base, 4096) and not any(c.isspace() for c in base) and not any(c in base for c in '?#\\'))
    try:
        url = urlsplit(base)
        require(url.scheme in ('http', 'https') and url.hostname and not url.username and not url.password and '@' not in url.netloc)
        port = url.port or (443 if url.scheme == 'https' else 80)
    except ValueError:
        raise Failure('invalid_request') from None
    path = (url.path.rstrip('/') + '/chat/completions').encode('ascii').decode()
    headers = {'content-type': 'application/json'}
    key = connection.get('apiKey')
    require(key is None or isinstance(key, str))
    if key:
        require(clean(key, 8192))
        headers['authorization'] = 'Bearer ' + key
    custom = connection.get('headers')
    if custom is not None:
        require(isinstance(custom, dict) and len(custom) <= 128)
        require(all(isinstance(k, str) and isinstance(v, str) for k, v in custom.items()))
        require(sum(size(k) + size(v) for k, v in custom.items()) <= 65536)
        for name, value in custom.items():
            require(size(name) <= 256 and TOKEN.fullmatch(name) and clean(value, 8192))
            try:
                value.encode('latin-1')
            except UnicodeError:
                raise Failure('invalid_request') from None
            # Framing headers belong to the transport, never to caller input.
            require(name.lower() not in ('content-length', 'transfer-encoding', 'connection', 'host'))
            headers[name.lower()] = value
    messages, tools = request['messages'], request['tools']
    require(isinstance(messages, list) and len(messages) <= 100000 and isinstance(tools, list) and len(tools) <= 128)
    outbound = [{'role': 'system', 'content': request['system']}]
    for message in messages:
        require(fields(message, ('role', 'text', 'images', 'toolCalls', 'native', 'results'), ('role',)))
        role = message['role']
        if role == 'user':
            require(isinstance(message.get('text'), str) and not any(k in message and message[k] is not None for k in ('toolCalls', 'results', 'native')))
            images = message.get('images') or []
            require(isinstance(images, list) and len(images) <= 128)
            for image in images:
                require(fields(image, ('mimeType', 'data'), ('mimeType', 'data')) and image['mimeType'] in ('image/png', 'image/jpeg', 'image/webp', 'image/gif') and isinstance(image['data'], str))
            content = ([{'type': 'image_url', 'image_url': {'url': 'data:' + image['mimeType'] + ';base64,' + image['data']}} for image in images]
                       + [{'type': 'text', 'text': message['text'] or 'Attached image.'}]) if images else message['text']
            outbound.append({'role': role, 'content': content})
        elif role == 'assistant':
            calls = message.get('toolCalls')
            require(isinstance(message.get('text'), str) and isinstance(calls, list) and len(calls) <= 128 and message.get('images') is None and message.get('results') is None)
            require('native' not in message or bounded(message['native']))
            result = {'role': role, 'content': message['text'] or None}
            output_calls = []
            for call in calls:
                require(fields(call, ('id', 'name', 'input', 'inputError'), ('id', 'name', 'input')) and isinstance(call['id'], str) and isinstance(call['name'], str)
                        and isinstance(call['input'], dict) and bounded(call['input']) and (call.get('inputError') is None or isinstance(call['inputError'], str)))
                output_calls.append({'id': call['id'], 'type': 'function', 'function': {'name': call['name'], 'arguments': argument_json(call['input'])}})
            if output_calls:
                result['tool_calls'] = output_calls
            outbound.append(result)
        elif role == 'tool':
            require(isinstance(message.get('results'), list) and all(message.get(k) is None for k in ('text', 'images', 'toolCalls', 'native')))
            for entry in message['results']:
                require(fields(entry, ('toolCallId', 'name', 'content', 'isError'), ('toolCallId', 'name', 'content', 'isError'))
                        and all(isinstance(entry[k], str) for k in ('toolCallId', 'name', 'content')) and type(entry['isError']) is bool)
                outbound.append({'role': 'tool', 'tool_call_id': entry['toolCallId'], 'content': ('Error: ' if entry['isError'] else '') + entry['content']})
        else:
            raise Failure('invalid_request')
    for tool in tools:
        require(fields(tool, ('name', 'description', 'parameters'), ('name', 'description', 'parameters')) and isinstance(tool['name'], str)
                and isinstance(tool['description'], str) and isinstance(tool['parameters'], dict) and bounded(tool['parameters']))
    body = {'model': connection['model'], 'messages': outbound, 'stream': True}
    if tools:
        body['tools'] = [{'type': 'function', 'function': tool} for tool in tools]
    return (url.scheme, url.hostname, port), path, headers, body


def quota(text):
    text = text.lower()
    if 'context' in text or 'prompt is too long' in text or re.search(r'maximum.*length', text):
        return False
    return any(word in text for word in ('quota', 'credit', 'billing', 'payment required', 'too many requests', 'usage limit', 'limit exceeded', 'limit reached', 'exceeded your', 'out of tokens', 'token limit exceeded', 'token limit reached', 'tokens limit exceeded', 'tokens limit reached', 'token budget exceeded', 'token budget reached', 'tokens budget exceeded', 'tokens budget reached', 'ratelimit', 'rate_limit', 'rate-limit', 'rate limit'))


def error_detail(body):
    try:
        value = loads(body)
        error = value.get('error')
        return error if isinstance(error, str) else (error.get('message', '') if isinstance(error, dict) else value.get('message', ''))
    except (ValueError, AttributeError, UnicodeError):
        return body[:1200].decode('utf-8', 'replace')[:300]


class State:
    def __init__(self):
        self.text, self.text_bytes, self.calls, self.args_bytes = [], 0, {}, 0
        self.model, self.finish_reason, self.usage = None, None, {}

    def absorb_usage(self, raw):
        if not isinstance(raw, dict):
            return
        for target, primary, alternate in (('inputTokens', 'prompt_tokens', 'input_tokens'), ('outputTokens', 'completion_tokens', 'output_tokens')):
            if primary in raw or alternate in raw:
                value = raw[primary] if primary in raw else raw[alternate]
                self.usage[target] = int(value) if counter(value) else None
        details = raw.get('prompt_tokens_details')
        if isinstance(details, dict) and 'cached_tokens' in details:
            value = details['cached_tokens']
            self.usage['cachedInputTokens'] = int(value) if counter(value) else None

    def call(self, index, value, replace):
        if not isinstance(value, dict):
            return
        if index not in self.calls and len(self.calls) >= 128:
            raise Failure('response_too_large')
        call = self.calls.setdefault(index, {'id': '', 'name': '', 'args': [], 'bytes': 0})
        if replace:
            self.args_bytes -= call['bytes']
            call = self.calls[index] = {'id': '', 'name': '', 'args': [], 'bytes': 0}
        ident = value.get('id')
        if isinstance(ident, str) and ident:
            if size(ident) > 4096:
                raise Failure('response_too_large')
            call['id'] = ident
        function = value.get('function')
        if isinstance(function, dict):
            name, args = function.get('name'), function.get('arguments')
            if isinstance(name, str):
                if size(call['name']) + size(name) > 4096:
                    raise Failure('response_too_large')
                call['name'] += name
            if isinstance(args, str):
                count = size(args)
                if self.args_bytes + count > TEXT_LIMIT:
                    raise Failure('response_too_large')
                call['args'].append(args)
                call['bytes'] += count
                self.args_bytes += count

    def absorb(self, chunk):
        if not isinstance(chunk, dict):
            raise Failure('invalid_response')
        error = chunk.get('error')
        if isinstance(error, dict) and isinstance(error.get('message'), str) and error['message']:
            raise Failure('provider_error', retryable=quota(error['message']))
        model = chunk.get('model')
        if isinstance(model, str) and model:
            if size(model) > 4096 or not model.strip():
                raise Failure('response_too_large')
            self.model = model
        self.absorb_usage(chunk.get('usage'))
        texts = []
        choices = chunk.get('choices', [])
        if not isinstance(choices, list):
            raise Failure('invalid_response')
        if len(choices) > 128:
            raise Failure('response_too_large')
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            self.absorb_usage(choice.get('usage'))
            delta = choice.get('delta')
            self.absorb_usage(delta.get('usage') if isinstance(delta, dict) else None)
            reason = choice.get('finish_reason')
            if isinstance(reason, str) and reason:
                if size(reason) > 1024:
                    raise Failure('response_too_large')
                self.finish_reason = reason
            for field in ('message', 'delta'):
                value = choice.get(field)
                if not isinstance(value, dict):
                    continue
                content = value.get('content')
                if isinstance(content, str) and content:
                    count = size(content)
                    if self.text_bytes + count > TEXT_LIMIT:
                        raise Failure('response_too_large')
                    self.text.append(content)
                    self.text_bytes += count
                    texts.append(content)
                if 'tool_calls' in value:
                    calls = value['tool_calls']
                    if not isinstance(calls, list):
                        raise Failure('invalid_response')
                    if len(calls) > 128:
                        raise Failure('response_too_large')
                    for i, call in enumerate(calls):
                        index = i if field == 'message' else (call.get('index') if isinstance(call, dict) else None)
                        if index is None:
                            index = len(self.calls)
                        if not counter(index):
                            raise Failure('invalid_response')
                        self.call(int(index), call, field == 'message')
        return texts

    def finish(self):
        filtered, truncated = self.finish_reason == 'content_filter', self.finish_reason == 'length'
        calls = []
        if not filtered:
            for index, call in sorted(self.calls.items()):
                raw, error, value = ''.join(call['args']), None, {}
                if truncated:
                    error = 'Tool arguments were truncated by the provider.'
                elif raw.strip():
                    try:
                        parsed = loads(raw)
                        if isinstance(parsed, dict):
                            if not bounded(parsed):
                                raise Failure('response_too_large')
                            value = parsed
                        else:
                            error = 'Tool arguments must be a JSON object.'
                    except (ValueError, RecursionError):
                        error = 'Tool arguments were not valid JSON.'
                result = {'id': call['id'] or f'call_{index}', 'name': call['name'], 'input': value}
                if error:
                    result['inputError'] = error
                calls.append(result)
        usage = {key: value for key, value in self.usage.items() if value is not None}
        if usage.get('cachedInputTokens', 0) > usage.get('inputTokens', 9007199254740991):
            usage.pop('cachedInputTokens', None)
        stop = 'refusal' if filtered else 'max_tokens' if truncated else 'tool_use' if calls else 'end' if self.finish_reason in (None, 'stop') else 'other'
        result = {'text': ''.join(self.text), 'toolCalls': calls, 'stop': stop}
        if self.model is not None:
            result['model'] = self.model
        if usage:
            result['usage'] = usage
        if 'inputTokens' in usage:
            result['promptTokens'] = usage['inputTokens']
        if filtered:
            result['refusal'] = 'The provider filtered this response.'
        return result


class Sse:
    def __init__(self):
        self.pending, self.scan, self.done = bytearray(), 0, False

    def feed(self, data, eof=False):
        if self.done:
            return []
        self.pending.extend(data)
        values, consumed = [], 0
        while True:
            match = SSE_BOUNDARY.search(self.pending, self.scan)
            if not match:
                self.scan = max(consumed, len(self.pending) - 3)
                break
            start, end = match.span()
            if end - consumed > PENDING_LIMIT:
                raise Failure('response_too_large')
            value = self.event(self.pending[consumed:start])
            consumed, self.scan = end, end
            if value is not None:
                values.append(value)
            if self.done:
                break
        if consumed:
            del self.pending[:consumed]
            self.scan -= consumed
        if len(self.pending) > PENDING_LIMIT:
            raise Failure('response_too_large')
        if eof and not self.done:
            value = self.event(self.pending)
            self.pending.clear()
            if value is not None:
                values.append(value)
            self.done = True
        return values

    def event(self, block):
        data = []
        for line in block.decode('utf-8', 'replace').split('\n'):
            line = line.removesuffix('\r')
            name, _, value = line.partition(':')
            if name == 'data':
                data.append(value[1:] if value.startswith(' ') else value)
        if not data:
            return None
        data = '\n'.join(data)
        if data == '[DONE]':
            self.done = True
            return None
        try:
            return loads(data)
        except (ValueError, RecursionError):
            return None


async def close_writer(writer):
    writer.close()
    try:
        await writer.wait_closed()
    except (OSError, ssl.SSLError):
        pass


class Pool:
    """Bounded idle sockets, no retries; each checked-out socket has one owner."""
    def __init__(self):
        self.idle = []
        self.context = None

    async def acquire(self, key):
        while self.idle:
            idle_key, reader, writer = self.idle.pop()
            if idle_key == key and not reader.at_eof() and not writer.is_closing():
                return reader, writer
            await close_writer(writer)
        scheme, host, port = key
        if scheme == 'https' and self.context is None:
            self.context = ssl.create_default_context()
        return await asyncio.open_connection(host, port, ssl=self.context if scheme == 'https' else None,
                                             server_hostname=host if scheme == 'https' else None, limit=65536)

    async def release(self, key, reader, writer):
        if len(self.idle) < 32 and not reader.at_eof() and not writer.is_closing():
            self.idle.append((key, reader, writer))
        else:
            await close_writer(writer)

    async def close(self):
        sockets, self.idle = self.idle, []
        await asyncio.gather(*(close_writer(writer) for _, _, writer in sockets))


class HttpResponse:
    def __init__(self, reader, status, headers, version):
        self.reader, self.status, self.headers = reader, status, headers
        self.chunked = headers.get('transfer-encoding', '').lower() == 'chunked'
        self.length = None
        if 'content-length' in headers:
            try:
                self.length = int(headers['content-length'])
                if self.length < 0:
                    raise ValueError()
            except ValueError:
                raise Failure('invalid_response') from None
        if 'transfer-encoding' in headers and (not self.chunked or 'content-length' in headers):
            raise Failure('invalid_response')
        self.reusable = version == 'HTTP/1.1' and headers.get('connection', '').lower() != 'close' and (self.chunked or self.length is not None)

    async def chunks(self):
        total = 0
        async def checked(data):
            nonlocal total
            total += len(data)
            if total > WIRE_LIMIT:
                raise Failure('response_too_large')
            return data
        if self.chunked:
            while True:
                line = await self.reader.readline()
                if len(line) > 8192 or not line.endswith(b'\r\n'):
                    raise Failure('invalid_response')
                try:
                    count = int(line.split(b';', 1)[0], 16)
                    if count < 0:
                        raise ValueError()
                except ValueError:
                    raise Failure('invalid_response') from None
                if count == 0:
                    trailer_bytes = 0
                    while True:
                        line = await self.reader.readline()
                        trailer_bytes += len(line)
                        if not line or trailer_bytes > 65536:
                            raise Failure('invalid_response')
                        if line == b'\r\n':
                            return
                while count:
                    data = await self.reader.readexactly(min(count, 8192))
                    count -= len(data)
                    yield await checked(data)
                if await self.reader.readexactly(2) != b'\r\n':
                    raise Failure('invalid_response')
        elif self.length is not None:
            remaining = self.length
            if remaining > WIRE_LIMIT:
                raise Failure('response_too_large')
            while remaining:
                data = await self.reader.readexactly(min(8192, remaining))
                remaining -= len(data)
                yield await checked(data)
        else:
            while data := await self.reader.read(8192):
                yield await checked(data)


async def request_http(reader, writer, key, path, headers, body):
    data = dumps(body).encode('utf-8')
    host = key[1]
    if ':' in host:
        host = '[' + host + ']'
    if key[2] != (443 if key[0] == 'https' else 80):
        host += ':' + str(key[2])
    head = f'POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Length: {len(data)}\r\n'
    head += ''.join(f'{name}: {value}\r\n' for name, value in headers.items()) + '\r\n'
    writer.write(head.encode('latin-1'))
    writer.write(data)
    await writer.drain()
    while True:
        status_line = await reader.readline()
        try:
            version, status, _ = status_line.decode('ascii').split(' ', 2)
            status = int(status)
            if version not in ('HTTP/1.0', 'HTTP/1.1') or not 100 <= status <= 599:
                raise ValueError()
        except (ValueError, UnicodeError):
            raise Failure('invalid_response') from None
        response_headers, total = {}, len(status_line)
        while True:
            line = await reader.readline()
            total += len(line)
            if not line or total > 65536:
                raise Failure('invalid_response')
            if line == b'\r\n':
                break
            name, sep, value = line.decode('latin-1').partition(':')
            if not sep or not TOKEN.fullmatch(name):
                raise Failure('invalid_response')
            name, value = name.lower(), value.strip()
            if name in response_headers and name in ('content-length', 'transfer-encoding'):
                raise Failure('invalid_response')
            response_headers[name] = value
        if status < 200 and status != 101:
            continue
        return HttpResponse(reader, status, response_headers, version)


class Operation:
    def __init__(self, ident, reserved):
        self.id, self.reserved, self.data, self.seq = ident, reserved, bytearray(), 0
        self.task, self.writer, self.cancelled, self.started, self.finishing = None, None, False, False, False


class Worker:
    def __init__(self, ident):
        self.id, self.slots, self.seen, self.reserved = ident, {}, set(), 0
        self.pool = Pool()
        self.input = asyncio.Queue(16)
        self.output = queue.Queue(128)
        self.output_bytes, self.output_changed = 0, asyncio.Event()
        self.broken = False
        self.stop_reader = threading.Event()

    async def emit(self, payload, operation=None):
        envelope = {'schema': SCHEMA, 'workerId': self.id}
        if operation is not None:
            envelope.update(requestId=operation.id, seq=operation.seq)
        envelope.update(payload)
        data = dumps(envelope).encode('utf-8')
        if len(data) > 32 * MIB:
            raise Failure('response_too_large')
        while self.output.full() or self.output_bytes + len(data) > 64 * MIB:
            if self.broken:
                raise BrokenPipeError()
            self.output_changed.clear()
            await self.output_changed.wait()
        if self.broken:
            raise BrokenPipeError()
        self.output_bytes += len(data)
        self.output.put_nowait(data)
        if operation is not None:
            operation.seq += 1

    async def receipt(self, operation, payload):
        await self.emit(payload, operation)
        await self.emit({'kind': 'settled', 'joined': True}, operation)

    async def delta(self, operation, text):
        data = text.encode('utf-8')
        offset = 0
        while offset < len(data):
            end = min(offset + 16384, len(data))
            while end < len(data) and data[end] & 0xC0 == 0x80:
                end -= 1
            if operation.seq >= 999999:
                raise Failure('response_too_large')
            await self.emit({'kind': 'delta', 'text': data[offset:end].decode('utf-8')}, operation)
            offset = end
            # Ensure buffered streams cannot starve the stdin cancellation queue.
            await asyncio.sleep(0)

    async def http(self, operation, request, prepared):
        key, path, headers, body = prepared
        rejected = False
        for attempt in range(2):
            if request['requestUsage'] and attempt == 0:
                body['stream_options'] = {'include_usage': True}
            else:
                body.pop('stream_options', None)
            reader, writer = await self.pool.acquire(key)
            operation.writer = writer
            try:
                response = await request_http(reader, writer, key, path, headers, body)
                if not 200 <= response.status < 300:
                    chunks = [chunk async for chunk in response.chunks()]
                    detail = error_detail(b''.join(chunks))
                    detail = detail if isinstance(detail, str) else ''
                    retry = response.status == 400 and request['requestUsage'] and attempt == 0 and ('stream_options' in detail.lower() or re.search(r'(unknown|unrecognized|unsupported)\s+(request\s+)?(parameter|argument|field)', detail, re.I))
                    if response.reusable:
                        await self.pool.release(key, reader, writer)
                        operation.writer = None
                    if retry:
                        rejected = True
                        continue
                    raise Failure('http_error', response.status, response.status != 401 and (response.status in (402, 408, 429) or response.status >= 500 or quota(detail)))
                state = State()
                if 'application/json' in response.headers.get('content-type', ''):
                    chunks = [chunk async for chunk in response.chunks()]
                    try:
                        texts = state.absorb(loads(b''.join(chunks)))
                    except (ValueError, RecursionError, UnicodeError):
                        raise Failure('invalid_response') from None
                    for text in texts:
                        await self.delta(operation, text)
                else:
                    sse = Sse()
                    async for chunk in response.chunks():
                        for value in sse.feed(chunk):
                            for text in state.absorb(value):
                                await self.delta(operation, text)
                    for value in sse.feed(b'', eof=True):
                        for text in state.absorb(value):
                            await self.delta(operation, text)
                result = state.finish()
                if response.reusable:
                    await self.pool.release(key, reader, writer)
                    operation.writer = None
                return {'kind': 'result', 'result': result, **({'streamOptionsRejected': True} if rejected else {})}
            finally:
                if operation.writer is writer:
                    await close_writer(writer)
                    operation.writer = None
        raise Failure('invalid_response')

    async def run_operation(self, operation):
        operation.started = True
        try:
            if operation.cancelled:
                raise Failure('cancelled')
            try:
                request = loads(operation.data, preserve_numbers=True)
            except (ValueError, RecursionError, UnicodeError):
                raise Failure('invalid_request') from None
            operation.data = None
            # Validation precedes HTTP and validates the timeout before constructing it.
            prepared = prepare(request, operation.id)
            async with asyncio.timeout(request['timeoutMs'] / 1000):
                terminal = await self.http(operation, request, prepared)
        except asyncio.CancelledError:
            terminal = {'kind': 'error', 'code': 'cancelled', 'retryable': False}
        except TimeoutError:
            terminal = {'kind': 'error', 'code': 'timeout', 'retryable': False}
        except Failure as error:
            terminal = {'kind': 'error', 'code': error.code, 'retryable': error.retryable}
            if error.status is not None:
                terminal['status'] = error.status
        except (OSError, EOFError, asyncio.IncompleteReadError):
            terminal = {'kind': 'error', 'code': 'transport_error', 'retryable': False}
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            terminal = {'kind': 'error', 'code': 'invalid_request', 'retryable': False}
        finally:
            # Cleanup and terminal delivery are joined even when a late X arrives.
            operation.finishing = True
            if operation.writer is not None:
                await close_writer(operation.writer)
                operation.writer = None
        try:
            if operation.cancelled:
                terminal = {'kind': 'error', 'code': 'cancelled', 'retryable': False}
            await self.receipt(operation, terminal)
        finally:
            self.reserved -= operation.reserved
            self.slots.pop(operation.id, None)

    async def cancel(self, operation):
        operation.cancelled = True
        if operation.task is not None:
            # Never repeatedly interrupt the awaited transport-close cleanup.
            if operation.started and not operation.finishing and not operation.task.cancelling():
                operation.task.cancel()
        else:
            self.reserved -= operation.reserved
            self.slots.pop(operation.id, None)
            await self.receipt(operation, {'kind': 'error', 'code': 'cancelled', 'retryable': False})

    async def handle(self, frame):
        op, data = frame[:1], frame[1:]
        if op == b'C':
            require(72 < len(data) <= 72 + 16384 and data[:36] == self.id.encode('ascii'))
            ident = data[36:72].decode('ascii')
            require(UUID.fullmatch(ident) and ident in self.seen)
            operation = self.slots.get(ident)
            if operation:
                require(operation.task is None and len(operation.data) + len(data) - 72 <= operation.reserved)
                operation.data.extend(data[72:])
            return False
        control = loads(data)
        require(fields(control, ('schema', 'workerId', 'requestId', 'bytes'), ('schema', 'workerId')) and control['schema'] == SCHEMA and control['workerId'] == self.id)
        if op == b'S':
            require('requestId' not in control and 'bytes' not in control)
            return True
        ident = control.get('requestId')
        require(isinstance(ident, str) and UUID.fullmatch(ident))
        if op == b'B':
            count = control.get('bytes')
            require(type(count) is int and 0 < count <= REQUEST_LIMIT and ident not in self.seen and len(self.seen) < 65536)
            self.seen.add(ident)
            operation = Operation(ident, count)
            if len(self.slots) >= 32 or self.reserved + count > INTAKE_LIMIT:
                await self.receipt(operation, {'kind': 'error', 'code': 'busy', 'retryable': False})
            else:
                self.slots[ident] = operation
                self.reserved += count
        elif op in (b'E', b'X'):
            require('bytes' not in control and ident in self.seen)
            operation = self.slots.get(ident)
            if operation:
                if op == b'X':
                    await self.cancel(operation)
                else:
                    require(operation.task is None and len(operation.data) == operation.reserved)
                    operation.task = asyncio.create_task(self.run_operation(operation))
        else:
            raise Failure('invalid_request')
        return False

    async def serve(self):
        loop = asyncio.get_running_loop()
        def input_reader():
            def read_exact(count):
                data = bytearray()
                while len(data) < count:
                    chunk = sys.stdin.buffer.read(count - len(data))
                    if not chunk:
                        break
                    data.extend(chunk)
                return bytes(data)
            try:
                while not self.stop_reader.is_set():
                    header = read_exact(4)
                    if not header:
                        event = None
                    elif len(header) != 4 or not 0 < struct.unpack('<I', header)[0] <= 65536:
                        event = False
                    else:
                        count = struct.unpack('<I', header)[0]
                        event = read_exact(count)
                        if len(event) != count:
                            event = False
                    future = asyncio.run_coroutine_threadsafe(self.input.put(event), loop)
                    future.result()
                    if event is None or event is False:
                        return
            except (OSError, RuntimeError):
                pass
        def output_finished(count, broken=False):
            self.output_bytes -= count
            self.broken |= broken
            self.output_changed.set()
            if broken:
                try:
                    self.input.put_nowait(False)
                except asyncio.QueueFull:
                    pass
        def output_writer():
            while True:
                data = self.output.get()
                if data is None:
                    return
                try:
                    sys.stdout.buffer.write(struct.pack('<I', len(data)))
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                except OSError:
                    loop.call_soon_threadsafe(output_finished, len(data), True)
                    return
                loop.call_soon_threadsafe(output_finished, len(data))
        reader = threading.Thread(target=input_reader, daemon=True)
        writer = threading.Thread(target=output_writer, daemon=True)
        reader.start()
        writer.start()
        failed = False
        try:
            await self.emit({'kind': 'hello'})
            while True:
                frame = await self.input.get()
                if frame is None:
                    break
                if frame is False:
                    failed = True
                    break
                try:
                    if await self.handle(frame):
                        break
                except (Failure, ValueError, TypeError, UnicodeError, RecursionError):
                    failed = True
                    break
        finally:
            self.stop_reader.set()
            for operation in list(self.slots.values()):
                await self.cancel(operation)
            await asyncio.gather(*(operation.task for operation in list(self.slots.values()) if operation.task is not None), return_exceptions=True)
            await self.pool.close()
            if not self.broken:
                while self.output.full():
                    self.output_changed.clear()
                    await self.output_changed.wait()
                self.output.put_nowait(None)
                await asyncio.to_thread(writer.join)
        return 1 if failed or self.broken else 0


def main():
    if len(sys.argv) != 3 or sys.argv[1] != '--provider-worker' or not UUID.fullmatch(sys.argv[2]):
        return 2
    try:
        return asyncio.run(Worker(sys.argv[2]).serve())
    except (OSError, RuntimeError, Failure):
        # Fixed diagnostic only; credentials and provider bodies are never logged.
        sys.stderr.write('Python completion benchmark worker failed.\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())
