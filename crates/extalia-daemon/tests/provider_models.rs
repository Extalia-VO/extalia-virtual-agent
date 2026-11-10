//! Real executable and synthetic local HTTP coverage; never contacts a provider or real profile.
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const ID: &str = "12345678-1234-4234-8234-123456789abc";
static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "extalia-provider-models-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn spawn(&self, arguments: &[&str]) -> Child {
        Command::new(env!("CARGO_BIN_EXE_extalia-daemon"))
            .args(arguments)
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("EXTALIA_HOME", self.0.join("profile-must-not-exist"))
            .env("HTTP_PROXY", "http://127.0.0.1:1")
            .env("HTTPS_PROXY", "http://127.0.0.1:1")
            .env("ALL_PROXY", "http://127.0.0.1:1")
            .env("NO_PROXY", "")
            .env("OPENAI_API_KEY", "synthetic-env-key-must-not-be-used")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }
    fn run(&self, bytes: &[u8]) -> Output {
        let mut child = self.spawn(&["--provider-models"]);
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.stderr.is_empty(),
            "no payload or network diagnostics on stderr"
        );
        assert!(
            std::fs::read_dir(&self.0).unwrap().next().is_none(),
            "no profile initialization"
        );
        output
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn request(base: &str) -> Value {
    json!({"schema":"extalia.provider-models.v1", "requestId":ID,
        "clientVersion":"test", "baseUrl":base, "timeoutMs":1000})
}
fn reply(output: Output) -> Value {
    assert!(output.status.success());
    assert!(output.stdout.len() < 128 * 1024);
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schema"], "extalia.provider-models.v1");
    assert_eq!(value["requestId"], ID);
    assert_eq!(value["daemonVersion"], env!("CARGO_PKG_VERSION"));
    value
}
fn accept(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let start = Instant::now();
    loop {
        match listener.accept() {
            Ok((stream, _)) => return stream,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    && start.elapsed() < Duration::from_secs(5) =>
            {
                thread::sleep(Duration::from_millis(5))
            }
            Err(error) => panic!("fixture accept: {error}"),
        }
    }
}
fn fixture(respond: impl FnOnce(&mut TcpStream) + Send + 'static) -> (String, JoinHandle<String>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
        let mut stream = accept(&listener);
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            assert_eq!(stream.read(&mut byte).unwrap(), 1);
            bytes.push(byte[0]);
            assert!(bytes.len() < 16 * 1024);
        }
        respond(&mut stream);
        String::from_utf8(bytes).unwrap()
    });
    (base, handle)
}
fn json_fixture(body: Value) -> (String, JoinHandle<String>) {
    fixture(move |stream| {
        let body = serde_json::to_vec(&body).unwrap();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .unwrap();
        let _ = stream.write_all(&body);
    })
}

#[test]
fn http_path_auth_header_and_sorted_ids() {
    let (base, server) = json_fixture(
        json!({"data":[{"id":"z/model"},{"id":"a+model"},{"id":"z/model"},{"id":"invalid model"},{"id":"-bad"},{"id":"é"},{"id":3},null]}),
    );
    let mut input = request(&format!("{base}/custom/v1///"));
    input["apiKey"] = json!("synthetic-key");
    input["headers"] = json!({"x-omniroute-no-memory":"true"});
    let value = reply(Sandbox::new().run(&serde_json::to_vec(&input).unwrap()));
    assert_eq!(value["models"], json!(["a+model", "z/model"]));
    assert_eq!(value["truncated"], false);
    let sent = server.join().unwrap().to_ascii_lowercase();
    assert!(sent.starts_with("get /custom/v1/models http/1.1\r\n"));
    assert!(sent.contains("authorization: bearer synthetic-key\r\n"));
    assert!(sent.contains("x-omniroute-no-memory: true\r\n"));
}

#[test]
fn absent_key_never_uses_environment_credentials() {
    for empty_key in [false, true] {
        let (base, server) = json_fixture(json!({"data":[]}));
        let mut input = request(&base);
        if empty_key {
            input["apiKey"] = json!("");
        }
        let value = reply(Sandbox::new().run(&serde_json::to_vec(&input).unwrap()));
        assert_eq!(value["outcome"], "ok");
        assert!(
            !server
                .join()
                .unwrap()
                .to_ascii_lowercase()
                .contains("authorization:")
        );
    }
}

#[test]
fn rejects_invalid_requests_before_network_or_profile_work() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let mut cases = Vec::new();
    for (key, value) in [
        ("schema", json!("wrong")),
        ("clientVersion", json!(" ")),
        ("clientVersion", json!("x".repeat(65))),
        ("clientVersion", json!("x\n")),
        ("timeoutMs", json!(0)),
        ("timeoutMs", json!(15001)),
        ("timeoutMs", json!(1.5)),
        ("apiKey", json!("key\r\nInjected: secret")),
        ("apiKey", json!("x".repeat(8193))),
        ("apiKey", Value::Null),
        ("headers", Value::Null),
        ("headers", json!({"authorization":"secret"})),
        ("headers", json!({"x-omniroute-no-memory":"false"})),
        ("headers", json!({"x-omniroute-no-memory":null})),
        ("extra", json!(true)),
    ] {
        let mut input = request(&base);
        input[key] = value;
        cases.push(input);
    }
    for url in [
        format!("{base}?q=secret"),
        format!("{base}#secret"),
        base.replace("http://", "http://user:secret@"),
        base.replace("http://", "http://@"),
        base.replace("http://", "ftp://"),
        format!("{base}/\npath"),
        format!("{base}/\\path"),
    ] {
        let mut input = request(&base);
        input["baseUrl"] = json!(url);
        cases.push(input);
    }
    let sandbox = Sandbox::new();
    for input in cases {
        let value = reply(sandbox.run(&serde_json::to_vec(&input).unwrap()));
        assert_eq!(value["code"], "invalid_request", "{input}");
        assert!(value.get("status").is_none());
    }
    assert!(listener.accept().is_err());
}

#[test]
fn duplicate_fields_are_invalid() {
    let input = format!(
        r#"{{"schema":"extalia.provider-models.v1","requestId":"{ID}","clientVersion":"test","baseUrl":"http://127.0.0.1:1","timeoutMs":1000,"timeoutMs":1000}}"#
    );
    assert_eq!(
        reply(Sandbox::new().run(input.as_bytes()))["code"],
        "invalid_request"
    );
}

#[test]
fn malformed_oversized_and_trailing_documents_exit_without_reply() {
    let sandbox = Sandbox::new();
    let valid = serde_json::to_vec(&request("http://127.0.0.1:1")).unwrap();
    let mut trailing = valid.clone();
    trailing.extend_from_slice(b" {}");
    for bytes in [
        b"{".to_vec(),
        b" ".repeat(16 * 1024 + 1),
        trailing,
        br#"{"requestId":"bad"}"#.to_vec(),
    ] {
        let output = sandbox.run(&bytes);
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn requires_eof_before_http() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let sandbox = Sandbox::new();
    let mut child = sandbox.spawn(&["--provider-models"]);
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(
            &serde_json::to_vec(&request(&format!(
                "http://{}",
                listener.local_addr().unwrap()
            )))
            .unwrap(),
        )
        .unwrap();
    input.flush().unwrap();
    thread::sleep(Duration::from_millis(60));
    assert!(child.try_wait().unwrap().is_none());
    assert!(listener.accept().is_err());
    child.kill().unwrap();
    drop(input);
    child.wait().unwrap();
}

#[test]
fn combined_profile_arguments_exit_before_initialization() {
    let sandbox = Sandbox::new();
    let path = sandbox.0.join("must-not-exist");
    for arguments in [
        vec!["--provider-models", "--data-dir", path.to_str().unwrap()],
        vec!["--profile", "default", "--provider-models"],
        vec!["--provider-models", "--provider-models"],
        vec!["--provider-models=1"],
    ] {
        let output = sandbox.spawn(&arguments).wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(std::fs::read_dir(&sandbox.0).unwrap().next().is_none());
    }
}

#[test]
fn http_errors_are_sanitized_and_redirects_are_not_followed() {
    for status in [302, 401, 429, 500] {
        let target = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        target.set_nonblocking(true).unwrap();
        let location = format!("http://{}/secret", target.local_addr().unwrap());
        let (base, server) = fixture(move |stream| {
            let _ = write!(
                stream,
                "HTTP/1.1 {status} Test\r\nLocation: {location}\r\nContent-Length: 22\r\nConnection: close\r\n\r\nprivate-provider-error"
            );
        });
        let value = reply(Sandbox::new().run(&serde_json::to_vec(&request(&base)).unwrap()));
        assert_eq!(value["code"], "http_error");
        assert_eq!(value["status"], status);
        assert!(!value.to_string().contains("private-provider"));
        server.join().unwrap();
        assert!(target.accept().is_err());
    }
}

#[test]
fn invalid_response_json_and_missing_data_are_rejected() {
    for body in ["not json", "{}", "{\"data\":{}}", "{\"data\":[]} {}"] {
        let (base, server) = fixture(move |stream| {
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        });
        assert_eq!(
            reply(Sandbox::new().run(&serde_json::to_vec(&request(&base)).unwrap()))["code"],
            "invalid_response"
        );
        server.join().unwrap();
    }
}

#[test]
fn incrementally_caps_body_without_content_length() {
    let (base, server) = fixture(|stream| {
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
            .unwrap();
        let chunk = [b' '; 8192];
        for _ in 0..258 {
            if stream.write_all(&chunk).is_err() {
                break;
            }
        }
    });
    assert_eq!(
        reply(Sandbox::new().run(&serde_json::to_vec(&request(&base)).unwrap()))["code"],
        "response_too_large"
    );
    server.join().unwrap();
}

#[test]
fn excessive_rows_are_rejected() {
    let (base, server) = json_fixture(json!({"data":vec![json!({"id":"a"});10001]}));
    assert_eq!(
        reply(Sandbox::new().run(&serde_json::to_vec(&request(&base)).unwrap()))["code"],
        "response_too_large"
    );
    server.join().unwrap();
}

#[test]
fn valid_unique_ids_are_sorted_then_capped() {
    let mut data: Vec<_> = (0..505)
        .rev()
        .map(|i| json!({"id":format!("model-{i:04}")}))
        .collect();
    data.extend([json!({"id":"model-0000"}), json!({"id":"a".repeat(201)})]);
    let (base, server) = json_fixture(json!({"data":data}));
    let value = reply(Sandbox::new().run(&serde_json::to_vec(&request(&base)).unwrap()));
    assert_eq!(value["models"].as_array().unwrap().len(), 500);
    assert_eq!(value["models"][0], "model-0000");
    assert_eq!(value["models"][499], "model-0499");
    assert_eq!(value["truncated"], true);
    server.join().unwrap();
}

#[test]
fn slow_headers_and_slow_body_time_out() {
    for send_headers in [false, true] {
        let (base, server) = fixture(move |stream| {
            if send_headers {
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{");
            }
            thread::sleep(Duration::from_millis(250));
        });
        let mut input = request(&base);
        input["timeoutMs"] = json!(60);
        let start = Instant::now();
        assert_eq!(
            reply(Sandbox::new().run(&serde_json::to_vec(&input).unwrap()))["code"],
            "timeout"
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        server.join().unwrap();
    }
}

#[test]
fn transport_errors_are_sanitized() {
    // A closed port can exhaust the request deadline before Winsock reports
    // refusal. Establish a real connection, then fail HTTP framing instead.
    let (base, server) = fixture(|stream| {
        stream.write_all(b"invalid HTTP response\r\n\r\n").unwrap();
    });
    let mut input = request(&base);
    input["apiKey"] = json!("synthetic-transport-key");
    let value = reply(Sandbox::new().run(&serde_json::to_vec(&input).unwrap()));
    let sent = server.join().unwrap().to_ascii_lowercase();
    assert!(sent.starts_with("get /models http/1.1\r\n"));
    assert!(sent.contains("authorization: bearer synthetic-transport-key\r\n"));
    assert_eq!(value["code"], "transport_error");
    assert!(value.get("status").is_none());
    assert!(!value.to_string().contains(&base));
    assert!(!value.to_string().contains("synthetic-transport-key"));
}

#[test]
fn trickled_body_obeys_one_total_deadline() {
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (base, server) = fixture(move |stream| {
        started_tx.send(Instant::now()).unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n")
            .unwrap();
        for _ in 0..40 {
            if stream.write_all(b" ").is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    });
    let mut input = request(&base);
    input["timeoutMs"] = json!(120);
    assert_eq!(
        reply(Sandbox::new().run(&serde_json::to_vec(&input).unwrap()))["code"],
        "timeout"
    );
    // Exclude child startup and TLS initialization from the HTTP operation's deadline.
    let elapsed = started_rx.recv().unwrap().elapsed();
    assert!(
        elapsed < Duration::from_millis(650),
        "HTTP duration: {elapsed:?}"
    );
    server.join().unwrap();
}

#[test]
fn exact_model_id_and_unique_count_boundaries() {
    let max_id = format!("a{}", ".:_/@+-".repeat(28) + "xyz");
    assert_eq!(max_id.len(), 200);
    let mut data: Vec<_> = (0..499)
        .map(|i| json!({"id":format!("model-{i:04}")}))
        .collect();
    data.extend([
        json!({"id":max_id}),
        json!({"id":"model-0000"}),
        json!({"id":"x".repeat(201)}),
        json!({"id":"a\n"}),
    ]);
    let (base, server) = json_fixture(json!({"data":data}));
    let value = reply(Sandbox::new().run(&serde_json::to_vec(&request(&base)).unwrap()));
    assert_eq!(value["models"].as_array().unwrap().len(), 500);
    assert_eq!(value["truncated"], false);
    assert!(value["models"].as_array().unwrap().contains(&json!(max_id)));
    server.join().unwrap();
}
