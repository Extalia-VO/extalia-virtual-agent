# Python completion benchmark prototype

This development-only Python 3.13+ worker implements the existing
`extalia.provider-worker.v1` framed stdio contract for the provider completion
benchmark. It does not select a production backend, execute tools, load a user
profile or read ambient provider credentials. Credentials arrive in stdin frames.

Run focused synthetic loopback tests with:

```sh
python3 -I -B -u tooling/bench/python/test_provider_worker.py
```

The parent starts the worker with:

```sh
python3 -I -B -u tooling/bench/python/provider_worker.py --provider-worker <UUID>
```

`settled` with `joined: true` means the request's coroutine and active transport
have completed cleanup before the receipt. Cancellation closes its owned socket
and awaits `wait_closed`; another request's transport remains independent. Normal
completed responses can return a fully consumed HTTP/1.1 socket to the bounded
idle pool. Admission is at most 32 operations; acquiring a new socket first
consumes or closes idle sockets, so active plus idle sockets stay within 32.
The host sends shutdown on its idle TTL; the worker adds no polling timer.

The stdin reader and stdout writer are separate bounded-queue threads; HTTP,
stream parsing, request cancellation and admission run on one asyncio loop.
Output backpressure suspends request coroutines. Intake, wire, event, text, tool
arguments, call count, frame count and queued-output bytes have explicit bounds.
If a parent stops reading stdout, shutdown can remain blocked while the writer
thread flushes queued frames. This prototype relies on the host draining stdout;
a nonreading parent must terminate the process externally (including SIGKILL
when needed). Bounded queues limit retained output but do not guarantee shutdown
against a permanently blocked pipe.

Scope: stdlib HTTP/1.1, JSON and SSE chat completions used by this benchmark,
including content-length, chunked and EOF bodies, indexed tool fragments,
usage validation and stream-options negotiation. HTTPS uses a lazy cached default
verified SSL context. Synthetic tests and the benchmark use non-TLS loopback;
production TLS/provider interoperability has not been established. There is no
HTTP/2, proxy, redirect, decompression or automatic connection-failure replay.
Caller-supplied transport framing headers are rejected. Prior tool argument
number spellings from Node's neutral JSON are retained in the provider-visible
argument string. These measurements characterize this prototype and its tested
workload, not Python implementations generally.
