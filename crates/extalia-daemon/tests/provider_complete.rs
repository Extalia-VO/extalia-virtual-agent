//! Real subprocess and loopback fixtures. No external providers, credentials or profiles.
#![cfg(feature = "provider-experiments")]
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const ID: &str = "12345678-1234-4234-8234-123456789abc";
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "extalia-provider-complete-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn spawn(&self, args: &[&str]) -> Child {
        Command::new(env!("CARGO_BIN_EXE_extalia-daemon"))
            .args(args)
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("EXTALIA_HOME", self.0.join("must-not-exist"))
            .env("HTTP_PROXY", "http://127.0.0.1:1")
            .env("HTTPS_PROXY", "http://127.0.0.1:1")
            .env("ALL_PROXY", "http://127.0.0.1:1")
            .env("NO_PROXY", "")
            .env("OPENAI_API_KEY", "unused-environment-key")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }
    fn run(&self, request: &Value) -> Vec<Value> {
        self.bytes(&serde_json::to_vec(request).unwrap()).1
    }
    fn bytes(&self, bytes: &[u8]) -> (Output, Vec<Value>) {
        let mut child = self.spawn(&["--provider-complete"]);
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(std::fs::read_dir(&self.0).unwrap().next().is_none());
        let mut frames = Vec::new();
        let mut bytes = output.stdout.as_slice();
        while !bytes.is_empty() {
            assert!(bytes.len() >= 4);
            let size = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
            assert!(size <= 32 * 1024 * 1024 && bytes.len() >= size + 4);
            let value: Value = serde_json::from_slice(&bytes[4..4 + size]).unwrap();
            assert_eq!(value["schema"], "extalia.provider-complete.v1");
            assert_eq!(value["requestId"], ID);
            assert_eq!(value["seq"], frames.len());
            if value["kind"] == "delta" {
                assert!(value["text"].as_str().unwrap().len() <= 16 * 1024);
            }
            frames.push(value);
            bytes = &bytes[4 + size..];
        }
        if !frames.is_empty() {
            assert!(output.status.success());
            assert!(
                frames[..frames.len() - 1]
                    .iter()
                    .all(|f| f["kind"] == "delta")
            );
        }
        (output, frames)
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn request(base: &str) -> Value {
    json!({"schema":"extalia.provider-complete.v1","requestId":ID,"clientVersion":"test","connection":{"baseUrl":base,"model":"test-model"},"system":"System","messages":[],"tools":[],"timeoutMs":3000,"requestUsage":true})
}
fn accept(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let start = Instant::now();
    loop {
        match listener.accept() {
            Ok((s, _)) => {
                s.set_nonblocking(false).unwrap();
                s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                s.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
                return s;
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    && start.elapsed() < Duration::from_secs(5) =>
            {
                thread::sleep(Duration::from_millis(5))
            }
            Err(e) => panic!("accept {e}"),
        }
    }
}
fn read_request(stream: &mut TcpStream) -> (String, Value) {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut b = [0];
        assert_eq!(stream.read(&mut b).unwrap(), 1);
        bytes.push(b[0]);
        assert!(bytes.len() < 128 * 1024);
    }
    let headers = String::from_utf8(bytes).unwrap();
    let size: usize = headers
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|n| n.trim().parse().unwrap())
        })
        .unwrap();
    let mut body = vec![0; size];
    stream.read_exact(&mut body).unwrap();
    (headers, serde_json::from_slice(&body).unwrap())
}
fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    write!(stream,"HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
    let _ = stream.write_all(body);
}
fn fixture(
    f: impl FnOnce(&mut TcpStream) + Send + 'static,
) -> (String, JoinHandle<(String, Value)>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    (
        base,
        thread::spawn(move || {
            let mut s = accept(&listener);
            let request = read_request(&mut s);
            f(&mut s);
            request
        }),
    )
}
fn json_fixture(value: Value) -> (String, JoinHandle<(String, Value)>) {
    fixture(move |s| {
        respond(
            s,
            200,
            "application/json",
            &serde_json::to_vec(&value).unwrap(),
        )
    })
}
fn terminal(frames: &[Value]) -> &Value {
    frames.last().unwrap()
}

#[test]
fn request_conversion_images_tools_and_custom_auth_precedence() {
    let (base, server) = json_fixture(
        json!({"model":"actual","choices":[{"message":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}),
    );
    let mut req = request(&format!("{base}/custom/v1///"));
    req["connection"]["apiKey"] = json!("synthetic-key");
    req["connection"]["headers"] = json!({"authorization":"Bearer override","x-extra":"custom"});
    req["messages"] = json!([
        {"role":"user","text":"","images":[{"mimeType":"image/png","data":"aGVsbG8="}]},
        {"role":"assistant","text":"","toolCalls":[{"id":"old","name":"lookup","input":{"q":"x"},"inputError":"previous invalid arguments"}],"native":{"api":"anthropic-messages","content":[]}},
        {"role":"tool","results":[{"toolCallId":"old","name":"lookup","content":"bad","isError":true}]}
    ]);
    req["tools"] = json!([{"name":"lookup","description":"Lookup","parameters":{"type":"object","properties":{}}}]);
    let frames = Sandbox::new().run(&req);
    assert_eq!(frames[0]["text"], "answer");
    assert_eq!(terminal(&frames)["result"]["promptTokens"], 9);
    let (head, body) = server.join().unwrap();
    let head = head.to_ascii_lowercase();
    assert!(head.starts_with("post /custom/v1/chat/completions http/1.1"));
    assert!(head.contains("authorization: bearer override\r\n"));
    assert!(head.contains("x-extra: custom\r\n"));
    assert!(!head.contains("synthetic-key"));
    assert_eq!(
        body["messages"][0],
        json!({"role":"system","content":"System"})
    );
    assert_eq!(
        body["messages"][1]["content"],
        json!([{"type":"image_url","image_url":{"url":"data:image/png;base64,aGVsbG8="}},{"type":"text","text":"Attached image."}])
    );
    assert_eq!(body["messages"][2]["content"], Value::Null);
    assert_eq!(
        body["messages"][2]["tool_calls"][0]["function"]["arguments"],
        "{\"q\":\"x\"}"
    );
    assert_eq!(body["messages"][3]["content"], "Error: bad");
    assert_eq!(body["tools"][0]["function"]["name"], "lookup");
    assert_eq!(body["stream_options"]["include_usage"], true);
}

#[test]
fn sse_crlf_multiline_split_utf8_unterminated_final_tools_and_usage() {
    let body=": comment\r\n\r\ndata: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":1,\"prompt_tokens_details\":{\"cached_tokens\":4}},\r\ndata: \"choices\":[{\"delta\":{\"content\":\"hé🙂\",\"tool_calls\":[{\"index\":1,\"function\":{\"name\":\"look\",\"arguments\":\"{\\\"x\\\":\"}}]}}]}\r\n\r\ndata: malformed\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"id\",\"function\":{\"name\":\"up\",\"arguments\":\"1}\"}}]},\"finish_reason\":\"tool_calls\",\"usage\":{\"completion_tokens\":3}}]}\n\ndata: {\"usage\":{\"prompt_tokens\":null,\"prompt_tokens_details\":{\"cached_tokens\":2}},\"model\":\"real\"}"
    .as_bytes().to_vec();
    let (base, server) = fixture(move |s| {
        write!(s,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
        for b in body {
            let _ = s.write_all(&[b]);
        }
    });
    let frames = Sandbox::new().run(&request(&base));
    let result = &terminal(&frames)["result"];
    assert_eq!(result["text"], "hé🙂");
    assert_eq!(result["stop"], "tool_use");
    assert_eq!(
        result["toolCalls"],
        json!([{"id":"id","name":"lookup","input":{"x":1}}])
    );
    assert_eq!(
        result["usage"],
        json!({"outputTokens":3,"cachedInputTokens":2})
    );
    assert!(result.get("promptTokens").is_none());
    server.join().unwrap();
}

#[test]
fn usage_safe_counts_cross_fields_refusal_and_tool_argument_errors() {
    for (args, error) in [
        ("[]", "Tool arguments must be a JSON object."),
        ("{", "Tool arguments were not valid JSON."),
    ] {
        let (base, server) = json_fixture(
            json!({"choices":[{"message":{"tool_calls":[{"id":"","function":{"name":"f","arguments":args}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":9007199254740992_u64,"prompt_tokens_details":{"cached_tokens":4}}}),
        );
        let frames = Sandbox::new().run(&request(&base));
        let result = &terminal(&frames)["result"];
        assert_eq!(result["usage"], json!({"inputTokens":3}));
        assert_eq!(result["toolCalls"][0]["id"], "call_0");
        assert_eq!(result["toolCalls"][0]["inputError"], error);

        server.join().unwrap();
    }
    let (base, server) = json_fixture(
        json!({"choices":[{"message":{"tool_calls":[{"id":"a","function":{"name":"f","arguments":"{\"valid\":true}"}}]},"finish_reason":"length"}]}),
    );
    let frames = Sandbox::new().run(&request(&base));
    assert_eq!(terminal(&frames)["result"]["stop"], "max_tokens");
    assert!(terminal(&frames)["result"]["toolCalls"][0]["inputError"].is_string());
    server.join().unwrap();
}

#[test]
fn narrow_400_retry_exactly_once_and_only_after_rejection() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut first = accept(&listener);
        let (_, body) = read_request(&mut first);
        assert!(body.get("stream_options").is_some());
        respond(
            &mut first,
            400,
            "application/json",
            br#"{"error":{"message":"Unknown request parameter: stream_options private-key"}}"#,
        );
        drop(first);
        let mut second = accept(&listener);
        let (_, body) = read_request(&mut second);
        assert!(body.get("stream_options").is_none());
        respond(
            &mut second,
            200,
            "application/json",
            br#"{"choices":[{"message":{"content":"ok"}}]}"#,
        );
    });
    let frames = Sandbox::new().run(&request(&base));
    assert_eq!(terminal(&frames)["streamOptionsRejected"], true);
    server.join().unwrap();
    for (status, detail, retryable) in [
        (400, "invalid prompt", false),
        (403, "quota exceeded private-key", true),
        (401, "quota exceeded private-key", false),
        (429, "private-key", true),
        (302, "private-key", false),
    ] {
        let (base, server) = fixture(move |s| {
            respond(
                s,
                status,
                "application/json",
                &serde_json::to_vec(&json!({"error":{"message":detail}})).unwrap(),
            )
        });
        let frames = Sandbox::new().run(&request(&base));
        assert_eq!(terminal(&frames)["status"], status);
        assert_eq!(terminal(&frames)["retryable"], retryable);
        assert!(
            !serde_json::to_string(&frames)
                .unwrap()
                .contains("private-key")
        );
        server.join().unwrap();
    }
}

#[test]
fn bounded_frames_pending_events_text_and_tool_count() {
    let (base, server) =
        json_fixture(json!({"choices":[{"message":{"content":"🙂".repeat(20_000)}}]}));
    let frames = Sandbox::new().run(&request(&base));
    assert_eq!(frames.iter().filter(|f| f["kind"] == "delta").count(), 5);
    assert_eq!(terminal(&frames)["kind"], "result");
    server.join().unwrap();
    for body in [
        format!("data: {}", " ".repeat(2 * 1024 * 1024 + 1)),
        format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{"tool_calls":(0..129).map(|i|json!({"index":i})).collect::<Vec<_>>()}}]})
        ),
    ] {
        let (base, server) =
            fixture(move |s| respond(s, 200, "text/event-stream", body.as_bytes()));
        let frames = Sandbox::new().run(&request(&base));
        assert_eq!(terminal(&frames)["code"], "response_too_large");
        server.join().unwrap();
    }
    let (base, server) =
        json_fixture(json!({"choices":[{"message":{"content":"x".repeat(8*1024*1024+1)}}]}));
    let frames = Sandbox::new().run(&request(&base));
    assert_eq!(terminal(&frames)["code"], "response_too_large");
    server.join().unwrap();
}

#[test]
fn requires_eof_cancellation_and_exclusive_mode_never_create_profile() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let sandbox = Sandbox::new();
    let mut child = sandbox.spawn(&["--provider-complete"]);
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(&serde_json::to_vec(&request(&base)).unwrap())
        .unwrap();
    stdin.flush().unwrap();
    thread::sleep(Duration::from_millis(60));
    assert!(listener.accept().is_err());
    child.kill().unwrap();
    drop(stdin);
    child.wait().unwrap();
    for args in [
        vec!["--provider-complete", "--profile", "default"],
        vec!["--provider-models", "--provider-complete"],
        vec!["--provider-complete", "--provider-complete"],
    ] {
        let output = sandbox.spawn(&args).wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
    }
    assert!(std::fs::read_dir(&sandbox.0).unwrap().next().is_none());
}

#[test]
fn malformed_and_invalid_requests_never_perform_network() {
    let sandbox = Sandbox::new();
    for bytes in [b"{".as_slice(), br#"{"requestId":"bad"}"#, b"{} {}"] {
        let (output, frames) = sandbox.bytes(bytes);
        assert_eq!(output.status.code(), Some(2));
        assert!(frames.is_empty());
    }
    for (field, value) in [
        ("timeoutMs", json!(0)),
        ("timeoutMs", json!(600001)),
        ("schema", json!("wrong")),
    ] {
        let mut req = request("http://127.0.0.1:1");
        req[field] = value;
        assert_eq!(terminal(&sandbox.run(&req))["code"], "invalid_request");
    }
    for base in [
        "http://user:secret@127.0.0.1:1",
        "http://127.0.0.1:1?q=x",
        "ftp://example.com",
    ] {
        assert_eq!(
            terminal(&sandbox.run(&request(base)))["code"],
            "invalid_request"
        );
    }
}

#[test]
fn body_deadline_and_provider_error_are_sanitized() {
    let (base, server) = fixture(|s| {
        let _ = s.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        );
        thread::sleep(Duration::from_millis(150));
    });
    let mut req = request(&base);
    req["timeoutMs"] = json!(60);
    let frames = Sandbox::new().run(&req);
    assert_eq!(terminal(&frames)["code"], "timeout");
    assert_eq!(terminal(&frames)["retryable"], false);
    server.join().unwrap();
    let (base, server) = fixture(|s| {
        respond(
            s,
            200,
            "text/event-stream",
            b"data: {\"error\":{\"message\":\"credit quota private-key\"}}\n\n",
        )
    });
    let frames = Sandbox::new().run(&request(&base));
    assert_eq!(terminal(&frames)["code"], "provider_error");
    assert_eq!(terminal(&frames)["retryable"], true);
    assert!(
        !serde_json::to_string(&frames)
            .unwrap()
            .contains("private-key")
    );
    server.join().unwrap();
}

#[test]
fn total_tool_arguments_and_wire_bytes_are_bounded_without_clipping() {
    let (base, server) = fixture(|s| {
        let _ = s.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        );
        let args = "x".repeat(1024 * 1024);
        let event = format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":args}}]}}]})
        );
        for _ in 0..9 {
            if s.write_all(event.as_bytes()).is_err() {
                break;
            }
        }
    });
    let frames = Sandbox::new().run(&request(&base));
    assert_eq!(terminal(&frames)["code"], "response_too_large");
    assert!(terminal(&frames).get("result").is_none());
    server.join().unwrap();
    let (base, server) = fixture(|s| {
        let _ = s.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        );
        let block = format!(":{}\n\n", "x".repeat(64 * 1024));
        for _ in 0..1025 {
            if s.write_all(block.as_bytes()).is_err() {
                break;
            }
        }
    });
    let mut req = request(&base);
    req["timeoutMs"] = json!(10000);
    let frames = Sandbox::new().run(&req);
    assert_eq!(terminal(&frames)["code"], "response_too_large");
    server.join().unwrap();
}

#[test]
fn killing_an_active_http_child_observes_exit_and_creates_no_profile() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let sandbox = Sandbox::new();
    let mut child = sandbox.spawn(&["--provider-complete"]);
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&request(&base)).unwrap())
        .unwrap();
    let mut stream = accept(&listener);
    read_request(&mut stream);
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"started\"}}]}\n\n").unwrap();
    child.kill().unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    assert!(std::fs::read_dir(&sandbox.0).unwrap().next().is_none());
}

#[test]
fn redirects_never_forward_credentials_or_contact_the_target() {
    let target = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    target.set_nonblocking(true).unwrap();
    let location = format!("http://{}/secret", target.local_addr().unwrap());
    let (base, server) = fixture(move |s| {
        let _ = write!(
            s,
            "HTTP/1.1 302 Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
    });
    let mut req = request(&base);
    req["connection"]["apiKey"] = json!("synthetic-key");
    let frames = Sandbox::new().run(&req);
    assert_eq!(terminal(&frames)["status"], 302);
    server.join().unwrap();
    assert!(target.accept().is_err());
}

#[test]
fn content_filter_discards_previously_streamed_tools_and_refuses_execution() {
    let body = format!(
        "data: {}\n\ndata: {}\n\n",
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"blocked","function":{"name":"write","arguments":"{\"path\":\"example.txt\"}"}}]}}]}),
        json!({"choices":[{"finish_reason":"content_filter"}]})
    );
    let (base, server) = fixture(move |s| respond(s, 200, "text/event-stream", body.as_bytes()));
    let frames = Sandbox::new().run(&request(&base));
    let result = &terminal(&frames)["result"];
    assert_eq!(result["stop"], "refusal");
    assert_eq!(result["toolCalls"], json!([]));
    assert_eq!(result["refusal"], "The provider filtered this response.");
    server.join().unwrap();
}

#[test]
fn tool_input_object_order_survives_http_history_and_result_frames() {
    let raw_args = r#"{"z":1,"a":{"y":2,"b":3}}"#;
    let (base, server) = json_fixture(
        json!({"choices":[{"message":{"tool_calls":[{"id":"new","function":{"name":"lookup","arguments":raw_args}}]},"finish_reason":"tool_calls"}]}),
    );
    let mut req = request(&base);
    req["messages"] = json!([{"role":"assistant","text":"","toolCalls":[{"id":"old","name":"lookup","input":{"z":1,"a":{"y":2,"b":3}}}]}]);
    let bytes = serde_json::to_string(&req).unwrap().replace(
        r#""input":{"a":{"b":3,"y":2},"z":1}"#,
        &format!(r#""input":{raw_args}"#),
    );
    let (output, frames) = Sandbox::new().bytes(bytes.as_bytes());
    assert_eq!(terminal(&frames)["kind"], "result");
    assert!(
        output
            .stdout
            .windows(raw_args.len())
            .any(|window| window == raw_args.as_bytes())
    );
    let (_, body) = server.join().unwrap();
    assert_eq!(
        body["messages"][1]["tool_calls"][0]["function"]["arguments"],
        raw_args
    );
}

const WORKER: &str = "22345678-1234-4234-8234-123456789abc";
const SECOND: &str = "32345678-1234-4234-8234-123456789abc";
const THIRD: &str = "42345678-1234-4234-8234-123456789abc";
struct WorkerHarness {
    sandbox: Sandbox,
    child: Child,
    input: Option<std::process::ChildStdin>,
    frames: std::sync::mpsc::Receiver<Value>,
    reader: Option<JoinHandle<()>>,
}
impl WorkerHarness {
    fn new() -> Self {
        let sandbox = Sandbox::new();
        let mut child = sandbox.spawn(&["--provider-worker", WORKER]);
        let input = child.stdin.take();
        let output = child.stdout.take().unwrap();
        let (frames, reader) = Self::reader(output);
        let result = Self {
            sandbox,
            child,
            input,
            frames,
            reader: Some(reader),
        };
        let hello = result.frame();
        assert_eq!(
            hello,
            json!({"schema":"extalia.provider-worker.v1","workerId":WORKER,"kind":"hello"})
        );
        result
    }
    fn reader(
        mut output: std::process::ChildStdout,
    ) -> (std::sync::mpsc::Receiver<Value>, JoinHandle<()>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let thread = thread::spawn(move || {
            loop {
                let mut size = [0; 4];
                if output.read_exact(&mut size).is_err() {
                    break;
                }
                let size = u32::from_le_bytes(size) as usize;
                assert!(size <= 32 * 1024 * 1024);
                let mut bytes = vec![0; size];
                output.read_exact(&mut bytes).unwrap();
                let value = serde_json::from_slice(&bytes).unwrap();
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        (rx, thread)
    }
    fn frame(&self) -> Value {
        self.frames.recv_timeout(Duration::from_secs(10)).unwrap()
    }
    fn raw(&mut self, bytes: &[u8]) {
        let input = self.input.as_mut().unwrap();
        input
            .write_all(&(bytes.len() as u32).to_le_bytes())
            .unwrap();
        input.write_all(bytes).unwrap();
        input.flush().unwrap();
    }
    fn control(&mut self, op: u8, id: Option<&str>, bytes: Option<usize>) {
        let mut value = json!({"schema":"extalia.provider-worker.v1","workerId":WORKER});
        if let Some(id) = id {
            value["requestId"] = json!(id);
        }
        if let Some(bytes) = bytes {
            value["bytes"] = json!(bytes);
        }
        let mut frame = vec![op];
        frame.extend(serde_json::to_vec(&value).unwrap());
        self.raw(&frame);
    }
    fn chunk(&mut self, id: &str, bytes: &[u8]) {
        let mut frame = vec![b'C'];
        frame.extend(WORKER.as_bytes());
        frame.extend(id.as_bytes());
        frame.extend(bytes);
        self.raw(&frame);
    }
    fn submit(&mut self, request: &Value) {
        let id = request["requestId"].as_str().unwrap();
        let bytes = serde_json::to_vec(request).unwrap();
        self.control(b'B', Some(id), Some(bytes.len()));
        for bytes in bytes.chunks(16 * 1024) {
            self.chunk(id, bytes);
        }
        self.control(b'E', Some(id), None);
    }
    fn finish(mut self, success: bool) {
        drop(self.input.take());
        let output = self.child.wait_with_output().unwrap();
        assert_eq!(output.status.success(), success);
        assert!(
            output.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        self.reader.take().unwrap().join().unwrap();
        assert!(std::fs::read_dir(&self.sandbox.0).unwrap().next().is_none());
    }
}

#[test]
fn persistent_worker_cancels_one_concurrent_http_scope_and_joins_before_receipts() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (closed_tx, closed_rx) = std::sync::mpsc::channel();
    let server = thread::spawn(move || {
        let mut handles = Vec::new();
        for _ in 0..2 {
            let mut s = accept(&listener);
            let tx = started_tx.clone();
            let closed = closed_tx.clone();
            handles.push(thread::spawn(move || {
                let (_, req) = read_request(&mut s);
                if req["model"] == "slow" {
                    s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"started\"}}]}\n\n").unwrap();
                    tx.send(()).unwrap();
                    let mut b = [0];
                    match s.read(&mut b) {
                        Ok(0) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
                        result => panic!("expected cancelled HTTP connection to close, got {result:?}"),
                    }
                    closed.send(()).unwrap();
                } else {
                    thread::sleep(Duration::from_millis(100));
                    respond(
                        &mut s,
                        200,
                        "application/json",
                        br#"{"choices":[{"message":{"content":"completed"}}]}"#,
                    );
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
    });
    let mut worker = WorkerHarness::new();
    let mut slow = request(&base);
    slow["connection"]["model"] = json!("slow");
    worker.submit(&slow);
    let mut fast = request(&base);
    fast["requestId"] = json!(SECOND);
    worker.submit(&fast);
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    worker.control(b'X', Some(ID), None);
    let mut frames = Vec::new();
    let mut joined = std::collections::HashSet::new();
    let mut seq = std::collections::HashMap::<String, u64>::new();
    while joined.len() < 2 {
        let frame = worker.frame();
        assert_eq!(frame["workerId"], WORKER);
        assert_eq!(frame["schema"], "extalia.provider-worker.v1");
        let id = frame["requestId"].as_str().unwrap().to_owned();
        let expected = seq.entry(id.clone()).or_default();
        assert_eq!(frame["seq"], *expected);
        *expected += 1;
        if frame["kind"] == "settled" {
            assert_eq!(frame["joined"], true);
            assert!(
                frames.iter().any(|f: &Value| f["requestId"] == id
                    && (f["kind"] == "result" || f["kind"] == "error"))
            );
            joined.insert(id);
        }
        frames.push(frame);
    }
    assert!(
        frames
            .iter()
            .any(|f| f["requestId"] == ID && f["code"] == "cancelled")
    );
    assert!(
        frames
            .iter()
            .any(|f| f["requestId"] == SECOND && f["result"]["text"] == "completed")
    );
    closed_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    worker.control(b'S', None, None);
    worker.finish(true);
    server.join().unwrap();
}

#[test]
fn persistent_worker_discards_cancelled_intake_trailers_and_keeps_other_intakes_responsive() {
    let (base, server) = json_fixture(json!({"choices":[{"message":{"content":"other"}}]}));
    let mut worker = WorkerHarness::new();
    worker.control(b'B', Some(ID), Some(128 * 1024 * 1024));
    for _ in 0..128 {
        worker.chunk(ID, &vec![b' '; 16 * 1024]);
    }
    let mut fast = request(&base);
    fast["requestId"] = json!(SECOND);
    worker.submit(&fast);
    loop {
        let frame = worker.frame();
        assert_eq!(frame["requestId"], SECOND);
        if frame["kind"] == "settled" {
            break;
        }
    }
    worker.control(b'X', Some(ID), None);
    assert_eq!(worker.frame()["code"], "cancelled");
    assert_eq!(worker.frame()["kind"], "settled");
    worker.chunk(ID, b"ignored");
    worker.control(b'E', Some(ID), None);
    worker.control(b'S', None, None);
    worker.finish(true);
    server.join().unwrap();
}

#[test]
fn persistent_worker_rejects_foreign_instances_and_replayed_begins_and_eof_cancels_intake() {
    let mut worker = WorkerHarness::new();
    worker.control(b'B', Some(ID), Some(1));
    worker.control(b'X', Some(ID), None);
    assert_eq!(worker.frame()["code"], "cancelled");
    assert_eq!(worker.frame()["kind"], "settled");
    worker.control(b'B', Some(ID), Some(1));
    worker.finish(false);
    let mut worker = WorkerHarness::new();
    let mut frame = vec![b'C'];
    frame.extend(SECOND.as_bytes());
    frame.extend(ID.as_bytes());
    frame.push(b' ');
    worker.raw(&frame);
    worker.finish(false);
    let mut worker = WorkerHarness::new();
    worker.control(b'B', Some(THIRD), Some(10));
    drop(worker.input.take());
    assert_eq!(worker.frame()["code"], "cancelled");
    assert_eq!(worker.frame()["kind"], "settled");
    worker.finish(true);
    let sandbox = Sandbox::new();
    for args in [
        vec!["--provider-worker", "bad"],
        vec!["--provider-worker", WORKER, "--profile", "default"],
        vec!["--provider-worker", WORKER, "--provider-complete"],
    ] {
        let output = sandbox.spawn(&args).wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn persistent_worker_enforces_admission_limit_and_shutdown_joins_all_intakes() {
    let mut worker = WorkerHarness::new();
    let ids: Vec<_> = (0..33)
        .map(|i| format!("{i:08x}-1234-4234-8234-123456789abc"))
        .collect();
    for id in &ids {
        worker.control(b'B', Some(id), Some(1));
    }
    let frame = worker.frame();
    assert_eq!(frame["requestId"], ids[32]);
    assert_eq!(frame["code"], "busy");
    assert_eq!(worker.frame()["kind"], "settled");
    worker.chunk(&ids[32], b" ");
    worker.control(b'E', Some(&ids[32]), None);
    worker.control(b'S', None, None);
    let mut settled = 0;
    while settled < 32 {
        let frame = worker.frame();
        if frame["kind"] == "settled" {
            settled += 1;
        } else {
            assert_eq!(frame["code"], "cancelled");
        }
    }
    worker.finish(true);
}

#[test]
fn persistent_worker_blocked_stdout_does_not_block_cancel_intake_or_http_drop() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (dropped_tx, dropped_rx) = std::sync::mpsc::channel();
    let server = thread::spawn(move || {
        let mut s = accept(&listener);
        read_request(&mut s);
        s.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        )
        .unwrap();
        let event = format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{"content":"x".repeat(8192)}}]})
        );
        started_tx.send(()).unwrap();
        for _ in 0..10000 {
            if s.write_all(event.as_bytes()).is_err() {
                dropped_tx.send(()).unwrap();
                return;
            }
        }
        panic!("server should stop on request cancellation");
    });
    let sandbox = Sandbox::new();
    let mut child = sandbox.spawn(&["--provider-worker", WORKER]);
    let input = child.stdin.take();
    let mut stdout = child.stdout.take().unwrap();
    let mut size = [0; 4];
    stdout.read_exact(&mut size).unwrap();
    let mut hello = vec![0; u32::from_le_bytes(size) as usize];
    stdout.read_exact(&mut hello).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&hello).unwrap()["kind"],
        "hello"
    );
    let (_, dummy) = std::sync::mpsc::channel();
    let mut worker = WorkerHarness {
        sandbox,
        child,
        input,
        frames: dummy,
        reader: None,
    };
    worker.submit(&request(&base));
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    // Leave stdout unread long enough to fill the bounded writer/progress queues.
    thread::sleep(Duration::from_millis(150));
    worker.control(b'X', Some(ID), None);
    dropped_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("cancel closes HTTP while stdout remains unread");
    let (frames, reader) = WorkerHarness::reader(stdout);
    worker.frames = frames;
    worker.reader = Some(reader);
    let mut terminal_seen = false;
    loop {
        let frame = worker.frame();
        if frame["kind"] == "error" {
            assert_eq!(frame["code"], "cancelled");
            terminal_seen = true;
        }
        if frame["kind"] == "settled" {
            assert!(terminal_seen);
            assert_eq!(frame["joined"], true);
            break;
        }
    }
    worker.control(b'S', None, None);
    worker.finish(true);
    server.join().unwrap();
}
