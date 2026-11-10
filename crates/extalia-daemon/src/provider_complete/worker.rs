//! Persistent stdio multiplexing with one independently joined HTTP/runtime owner per call.
//! Neither the worker nor request owners open a profile, database or credential store.
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc as async_mpsc, watch};

use super::{
    FRAME_LIMIT, Failure, REQUEST_LIMIT, Request, Result, Terminal, WIRE_LIMIT, error_detail,
    response, transport, uuid,
};

const SCHEMA: &str = "extalia.provider-worker.v1";
const INPUT_FRAME_LIMIT: usize = 64 * 1024;
const CHUNK_LIMIT: usize = 16 * 1024;
const INTAKE_LIMIT: usize = 256 * 1024 * 1024;
const ADMITTED_LIMIT: usize = 32;
const LIFETIME_IDS: usize = 65_536;
const OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const OUTPUT_FRAMES: usize = 128;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Control {
    schema: String,
    worker_id: String,
    request_id: Option<String>,
    bytes: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a, T> {
    schema: &'static str,
    worker_id: &'a str,
    request_id: &'a str,
    seq: u64,
    #[serde(flatten)]
    payload: T,
}

enum Event {
    Input(Vec<u8>),
    Eof,
    Bad,
    Wake,
}
struct Intake {
    expected: usize,
    bytes: Vec<u8>,
}
struct Running {
    cancel: watch::Sender<bool>,
    progress: async_mpsc::Receiver<String>,
    owner: JoinHandle<Terminal>,
    forced_error: Option<&'static str>,
}
enum Scope {
    Intake(Intake),
    Running(Running),
}
struct Slot {
    seq: u64,
    reserved: usize,
    scope: Scope,
}

fn failure(code: &'static str) -> Terminal {
    Terminal::Error {
        code,
        retryable: false,
        status: None,
    }
}
fn terminal(result: Result<(response::CompletionResult, bool)>) -> Terminal {
    match result {
        Ok((result, rejected)) => Terminal::Result {
            result,
            stream_options_rejected: rejected.then_some(true),
        },
        Err(error) => Terminal::Error {
            code: error.code,
            retryable: error.retryable,
            status: error.status,
        },
    }
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

async fn read_body(response: &mut reqwest::Response) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport)? {
        if body.len() + chunk.len() > WIRE_LIMIT {
            return Err(Failure::new("response_too_large"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

struct Progress {
    sender: async_mpsc::Sender<String>,
    wake: mpsc::SyncSender<Event>,
}
async fn progress(texts: Vec<String>, output: &Progress) -> Result<()> {
    for text in texts {
        let mut text = text.as_str();
        while !text.is_empty() {
            let mut end = text.len().min(CHUNK_LIMIT);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            output
                .sender
                .send(text[..end].to_owned())
                .await
                .map_err(|_| Failure::new("cancelled"))?;
            let _ = output.wake.try_send(Event::Wake);
            text = &text[end..];
        }
    }
    Ok(())
}

async fn http(request: Request, output: Progress) -> Result<(response::CompletionResult, bool)> {
    let (url, headers) = request.prepare()?;
    let timeout = Duration::from_millis(request.timeout_ms);
    let started = std::time::Instant::now();
    // All Hyper drivers belong to this owner's current-thread runtime, never a shared runtime.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(timeout)
        .timeout(timeout)
        .build()
        .map_err(transport)?;
    let send = |usage| {
        let body = request.body(usage);
        let remaining = timeout.checked_sub(started.elapsed());
        let client = &client;
        let url = url.clone();
        let headers = headers.clone();
        async move {
            let body = body?;
            let remaining = remaining.ok_or_else(|| Failure::new("timeout"))?;
            // Let the outer cancellation/deadline select observe changes after serialization.
            tokio::task::yield_now().await;
            client
                .post(url)
                .headers(headers)
                .timeout(remaining)
                .body(body)
                .send()
                .await
                .map_err(transport)
        }
    };
    let mut response = send(request.request_usage).await?;
    let mut failure_body = None;
    let mut rejected = false;
    if response.status().as_u16() == 400 && request.request_usage {
        let body = read_body(&mut response).await?;
        if response::stream_options_rejected(&error_detail(&body)) {
            response = send(false).await?;
            rejected = response.status().is_success();
        } else {
            failure_body = Some(body);
        }
    }
    if !response.status().is_success() {
        let status = response.status().as_u16();
        if !(100..=599).contains(&status) {
            return Err(Failure::new("invalid_response"));
        }
        let body = match failure_body {
            Some(body) => body,
            None => read_body(&mut response).await?,
        };
        return Err(Failure {
            code: "http_error",
            status: Some(status),
            retryable: status != 401
                && (matches!(status, 402 | 408 | 429 | 500..=599)
                    || response::quota(&error_detail(&body))),
        });
    }
    let mut state = response::State::default();
    let is_json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .contains("application/json");
    if is_json {
        let bytes = read_body(&mut response).await?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| Failure::new("invalid_response"))?;
        let mut texts = Vec::new();
        state.absorb(value, &mut texts)?;
        progress(texts, &output).await?;
    } else {
        let mut sse = response::Sse::default();
        while let Some(chunk) = response.chunk().await.map_err(transport)? {
            let mut done = false;
            for chunk in chunk.chunks(8192) {
                let mut texts = Vec::new();
                done = sse.feed(chunk, false, &mut state, &mut texts)?;
                progress(texts, &output).await?;
                if done {
                    break;
                }
            }
            if done {
                break;
            }
        }
        let mut texts = Vec::new();
        sse.feed(&[], true, &mut state, &mut texts)?;
        progress(texts, &output).await?;
    }
    // Explicitly drop the response and client before the future and then its runtime are dropped.
    drop(response);
    drop(client);
    Ok((state.finish()?, rejected))
}

fn spawn_owner(
    id: String,
    bytes: Vec<u8>,
    wake: mpsc::SyncSender<Event>,
) -> std::io::Result<Running> {
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let (progress_tx, progress_rx) = async_mpsc::channel(2);
    let owner = thread::Builder::new()
        .name("provider-request".into())
        .spawn(move || {
            let outcome = (|| {
                let request: Request =
                    serde_json::from_slice(&bytes).map_err(|_| Failure::new("invalid_request"))?;
                drop(bytes);
                if request.request_id != id || !uuid(&request.request_id) {
                    return Err(Failure::new("invalid_request"));
                }
                if *cancel_rx.borrow() {
                    return Err(Failure::new("cancelled"));
                }
                if !(1..=600_000).contains(&request.timeout_ms) { return Err(Failure::new("invalid_request")); }
                let timeout = Duration::from_millis(request.timeout_ms);
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| Failure::new("transport_error"))?;
                let result = runtime.block_on(async {
                    tokio::select! {
                        biased;
                        () = cancelled(&mut cancel_rx) => Err(Failure::new("cancelled")),
                        result = tokio::time::timeout(timeout, http(request, Progress { sender: progress_tx, wake: wake.clone() })) => result.unwrap_or_else(|_|Err(Failure::new("timeout"))),
                    }
                });
                // This waits for owned blocking DNS work too. Task abort alone is not settlement.
                drop(runtime);
                result
            })();
            let _ = wake.try_send(Event::Wake);
            terminal(outcome)
        })?;
    Ok(Running {
        cancel: cancel_tx,
        progress: progress_rx,
        owner,
        forced_error: None,
    })
}

struct Outputs {
    worker: String,
    queue: VecDeque<Vec<u8>>,
    bytes: usize,
    writer: mpsc::SyncSender<Vec<u8>>,
}
impl Outputs {
    fn push(&mut self, bytes: Vec<u8>) -> std::result::Result<(), ()> {
        if bytes.len() > FRAME_LIMIT
            || self.bytes + bytes.len() > OUTPUT_BYTES
            || self.queue.len() >= OUTPUT_FRAMES
        {
            return Err(());
        }
        self.bytes += bytes.len();
        self.queue.push_back(bytes);
        Ok(())
    }
    fn emit(&mut self, id: &str, seq: u64, payload: impl Serialize) -> std::result::Result<(), ()> {
        let bytes = serde_json::to_vec(&Envelope {
            schema: SCHEMA,
            worker_id: &self.worker,
            request_id: id,
            seq,
            payload,
        })
        .map_err(|_| ())?;
        if bytes.len() > FRAME_LIMIT {
            return self.emit(id, seq, failure("response_too_large"));
        }
        self.push(bytes)
    }
    fn receipt(&mut self, id: &str, seq: u64, value: Terminal) -> std::result::Result<(), ()> {
        self.emit(id, seq, value)?;
        self.emit(id, seq + 1, json!({"kind":"settled", "joined":true}))
    }
    fn flush(&mut self) -> std::result::Result<(), ()> {
        while let Some(bytes) = self.queue.pop_front() {
            let size = bytes.len();
            match self.writer.try_send(bytes) {
                Ok(()) => self.bytes -= size,
                Err(mpsc::TrySendError::Full(bytes)) => {
                    self.queue.push_front(bytes);
                    break;
                }
                Err(mpsc::TrySendError::Disconnected(_)) => return Err(()),
            }
        }
        Ok(())
    }
    fn room_for_result(&self) -> bool {
        self.bytes + FRAME_LIMIT + 1024 <= OUTPUT_BYTES && self.queue.len() + 4 < OUTPUT_FRAMES
    }
}

fn handle(
    frame: Vec<u8>,
    worker: &str,
    slots: &mut HashMap<String, Slot>,
    seen: &mut HashSet<String>,
    reserved: &mut usize,
    output: &mut Outputs,
    wake: &mpsc::SyncSender<Event>,
) -> std::result::Result<bool, ()> {
    let (&op, bytes) = frame.split_first().ok_or(())?;
    if op == b'C' {
        if bytes.len() <= 72 || bytes.len() > 72 + CHUNK_LIMIT || &bytes[..36] != worker.as_bytes()
        {
            return Err(());
        }
        let id = std::str::from_utf8(&bytes[36..72]).map_err(|_| ())?;
        if !uuid(id) || !seen.contains(id) {
            return Err(());
        }
        if let Some(slot) = slots.get_mut(id) {
            match &mut slot.scope {
                Scope::Intake(intake) => {
                    if intake.bytes.len() + bytes.len() - 72 > intake.expected {
                        return Err(());
                    }
                    intake.bytes.extend_from_slice(&bytes[72..]);
                }
                Scope::Running(_) => return Err(()),
            }
        }
        return Ok(false);
    }
    let control: Control = serde_json::from_slice(bytes).map_err(|_| ())?;
    if control.schema != SCHEMA || control.worker_id != worker {
        return Err(());
    }
    if op == b'S' {
        if control.request_id.is_some() || control.bytes.is_some() {
            return Err(());
        }
        return Ok(true);
    }
    let id = control.request_id.filter(|id| uuid(id)).ok_or(())?;
    match op {
        b'B' => {
            let bytes = control
                .bytes
                .filter(|n| *n > 0 && *n <= REQUEST_LIMIT as usize)
                .ok_or(())?;
            if seen.len() >= LIFETIME_IDS || !seen.insert(id.clone()) {
                return Err(());
            }
            if slots.len() >= ADMITTED_LIMIT || *reserved + bytes > INTAKE_LIMIT {
                output.receipt(&id, 0, failure("busy"))?;
            } else {
                *reserved += bytes;
                slots.insert(
                    id,
                    Slot {
                        seq: 0,
                        reserved: bytes,
                        scope: Scope::Intake(Intake {
                            expected: bytes,
                            bytes: Vec::new(),
                        }),
                    },
                );
            }
        }
        b'E' => {
            if control.bytes.is_some() || !seen.contains(&id) {
                return Err(());
            }
            let Some(slot) = slots.remove(&id) else {
                return Ok(false);
            };
            match slot.scope {
                Scope::Intake(intake) => {
                    if intake.bytes.len() != intake.expected {
                        return Err(());
                    }
                    let running =
                        spawn_owner(id.clone(), intake.bytes, wake.clone()).map_err(|_| ())?;
                    slots.insert(
                        id,
                        Slot {
                            seq: slot.seq,
                            reserved: slot.reserved,
                            scope: Scope::Running(running),
                        },
                    );
                }
                Scope::Running(running) => {
                    slots.insert(
                        id,
                        Slot {
                            seq: slot.seq,
                            reserved: slot.reserved,
                            scope: Scope::Running(running),
                        },
                    );
                    return Err(());
                }
            }
        }
        b'X' => {
            if control.bytes.is_some() || !seen.contains(&id) {
                return Err(());
            }
            if let Some(slot) = slots.remove(&id) {
                match slot.scope {
                    Scope::Intake(_) => {
                        *reserved -= slot.reserved;
                        output.receipt(&id, slot.seq, failure("cancelled"))?;
                    }
                    Scope::Running(running) => {
                        let _ = running.cancel.send(true);
                        slots.insert(
                            id,
                            Slot {
                                seq: slot.seq,
                                reserved: slot.reserved,
                                scope: Scope::Running(running),
                            },
                        );
                    }
                }
            }
        }
        _ => return Err(()),
    }
    Ok(false)
}

/// Owns only stdio and per-request transport scopes. Malformed input drains owners before exit.
pub fn serve(worker: String) -> u8 {
    if !uuid(&worker) {
        return 2;
    }
    let (events_tx, events_rx) = mpsc::sync_channel(16);
    let reader_events = events_tx.clone();
    // The stdin-only reader has no provider effects and need not delay shutdown waiting for EOF.
    let _reader = thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let mut size = [0; 4];
            let event = match input.read(&mut size[..1]) {
                Ok(0) => Event::Eof,
                Ok(_) if input.read_exact(&mut size[1..]).is_ok() => {
                    let size = u32::from_le_bytes(size) as usize;
                    if size == 0 || size > INPUT_FRAME_LIMIT {
                        Event::Bad
                    } else {
                        let mut bytes = vec![0; size];
                        if input.read_exact(&mut bytes).is_ok() {
                            Event::Input(bytes)
                        } else {
                            Event::Bad
                        }
                    }
                }
                _ => Event::Bad,
            };
            let stop = matches!(event, Event::Eof | Event::Bad);
            if reader_events.send(event).is_err() || stop {
                break;
            }
        }
    });
    let broken = Arc::new(AtomicBool::new(false));
    let writer_broken = broken.clone();
    let writer_events = events_tx.clone();
    let (writer_tx, writer_rx) = mpsc::sync_channel::<Vec<u8>>(4);
    let writer = thread::spawn(move || {
        let mut output = std::io::stdout().lock();
        while let Ok(bytes) = writer_rx.recv() {
            if output
                .write_all(&(bytes.len() as u32).to_le_bytes())
                .and_then(|()| output.write_all(&bytes))
                .and_then(|()| output.flush())
                .is_err()
            {
                writer_broken.store(true, Ordering::Release);
                let _ = writer_events.try_send(Event::Bad);
                break;
            }
            let _ = writer_events.try_send(Event::Wake);
        }
    });
    let mut output = Outputs {
        worker: worker.clone(),
        queue: VecDeque::new(),
        bytes: 0,
        writer: writer_tx,
    };
    let hello = serde_json::to_vec(&json!({"schema":SCHEMA,"workerId":worker,"kind":"hello"}))
        .expect("fixed envelope");
    let _ = output.push(hello);
    let mut slots = HashMap::<String, Slot>::new();
    let mut seen = HashSet::new();
    let mut reserved = 0;
    let mut shutting_down = false;
    let mut failed = false;
    loop {
        if output.flush().is_err() || broken.load(Ordering::Acquire) {
            failed = true;
            shutting_down = true;
        }
        if shutting_down {
            let ids: Vec<_> = slots.keys().cloned().collect();
            for id in ids {
                if let Some(slot) = slots.remove(&id) {
                    match slot.scope {
                        Scope::Intake(_) => {
                            reserved -= slot.reserved;
                            if !failed
                                && output.receipt(&id, slot.seq, failure("cancelled")).is_err()
                            {
                                failed = true;
                            }
                        }
                        Scope::Running(running) => {
                            let _ = running.cancel.send(true);
                            slots.insert(
                                id,
                                Slot {
                                    seq: slot.seq,
                                    reserved: slot.reserved,
                                    scope: Scope::Running(running),
                                },
                            );
                        }
                    }
                }
            }
        }
        let ids: Vec<_> = slots.keys().cloned().collect();
        for id in ids {
            let Some(slot) = slots.get_mut(&id) else {
                continue;
            };
            if let Scope::Running(running) = &mut slot.scope {
                while failed
                    || *running.cancel.borrow()
                    || (output.queue.len() + 4 < OUTPUT_FRAMES
                        && output.bytes + CHUNK_LIMIT + 1024 < OUTPUT_BYTES)
                {
                    match running.progress.try_recv() {
                        Ok(text) => {
                            if !failed && !*running.cancel.borrow() {
                                if slot.seq >= 999_999 {
                                    running.forced_error = Some("response_too_large");
                                    let _ = running.cancel.send(true);
                                } else if output
                                    .emit(&id, slot.seq, json!({"kind":"delta","text":text}))
                                    .is_err()
                                {
                                    failed = true;
                                    shutting_down = true;
                                    let _ = running.cancel.send(true);
                                } else {
                                    slot.seq += 1;
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
                // Drain progress first: channel messages must precede this request's terminal frame.
                if running.owner.is_finished()
                    && running.progress.is_empty()
                    && (failed || output.room_for_result())
                {
                    let slot = slots.remove(&id).expect("present request slot");
                    let Scope::Running(running) = slot.scope else {
                        unreachable!()
                    };
                    let was_cancelled = *running.cancel.borrow();
                    let value = running
                        .owner
                        .join()
                        .unwrap_or_else(|_| failure("transport_error"));
                    let value = if let Some(code) = running.forced_error {
                        failure(code)
                    } else if was_cancelled {
                        failure("cancelled")
                    } else {
                        value
                    };
                    reserved -= slot.reserved;
                    if !failed && output.receipt(&id, slot.seq, value).is_err() {
                        failed = true;
                        shutting_down = true;
                    }
                }
            }
        }
        if shutting_down && slots.is_empty() {
            break;
        }
        match events_rx.recv_timeout(Duration::from_millis(1)) {
            Ok(Event::Input(frame)) if !shutting_down => match handle(
                frame,
                &worker,
                &mut slots,
                &mut seen,
                &mut reserved,
                &mut output,
                &events_tx,
            ) {
                Ok(shutdown) => shutting_down = shutdown,
                Err(()) => {
                    failed = true;
                    shutting_down = true;
                }
            },
            Ok(Event::Eof) => shutting_down = true,
            Ok(Event::Bad) => {
                failed = true;
                shutting_down = true;
            }
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => shutting_down = true,
        }
    }
    if !failed {
        while !output.queue.is_empty() {
            if output.flush().is_err() || broken.load(Ordering::Acquire) {
                failed = true;
                break;
            }
            let _ = events_rx.recv_timeout(Duration::from_millis(1));
        }
    }
    drop(output);
    if writer.join().is_err() || broken.load(Ordering::Acquire) {
        failed = true;
    }
    if failed { 1 } else { 0 }
}
