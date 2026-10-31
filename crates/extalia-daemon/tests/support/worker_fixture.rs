//! Opt-in test executable. Never packaged and never used by the application.
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

const VERSION: &str = "0.0.0-reference";
fn emit(value: &Value, padded: bool) -> bool {
    let mut bytes = serde_json::to_vec(value).unwrap();
    if padded {
        bytes.resize(65_535, b' ');
    }
    bytes.push(b'\n');
    let mut output = std::io::stdout().lock();
    output
        .write_all(&bytes)
        .and_then(|_| output.flush())
        .is_ok()
}
fn pause() {
    // Safety ceiling even if a broken supervisor fails to terminate its child.
    std::thread::sleep(Duration::from_secs(5));
}
fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "healthy".into());
    if mode == "hold-pipes" {
        std::thread::sleep(Duration::from_millis(600));
        return;
    }
    if mode == "silent" {
        pause();
        return;
    }
    if mode == "stderr-flood" {
        let _ = std::io::stderr().lock().write_all(&[b'x'; 65_536]);
        pause();
        return;
    }
    if mode == "malformed" {
        let _ = std::io::stdout().lock().write_all(b"{}\n");
        pause();
        return;
    }
    if mode == "truncated" {
        let _ = std::io::stdout().lock().write_all(b"{\"schema_version\":1");
        return;
    }
    if mode == "oversize" {
        let _ = std::io::stdout().lock().write_all(&[b' '; 65_536]);
        pause();
        return;
    }
    if mode == "unsolicited" {
        emit(
            &json!({"schema_version":1,"kind":"response","request_id":"00000000-0000-4000-8000-000000000001","result":{"status":"ok","worker_version":VERSION}}),
            false,
        );
        pause();
        return;
    }
    let hello = json!({"schema_version":1,"kind":"hello","worker_version":if mode == "wrong-version" {"2"} else {VERSION},"operations":["health"]});
    if !emit(&hello, mode == "stdout-flood") {
        return;
    }
    if mode == "duplicate-hello" {
        emit(&hello, false);
        pause();
        return;
    }
    let mut input = BufReader::new(std::io::stdin().lock());
    let mut line = String::new();
    if input.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let Ok(request) = serde_json::from_str::<Value>(&line) else {
        return;
    };
    let _ = std::fs::write("request-observed", b"yes");
    if mode == "ignore-cancel" {
        pause();
        return;
    }
    if mode == "cooperative-cancel" {
        line.clear();
        if input.read_line(&mut line).unwrap_or(0) > 0
            && let Ok(cancel) = serde_json::from_str::<Value>(&line)
            && cancel["kind"] == "cancel"
            && cancel["request_id"] == request["request_id"]
        {
            let _ = std::fs::write("cancel-observed", b"yes");
            emit(
                &json!({"schema_version":1,"kind":"error","request_id":request["request_id"],"error":{"code":"cancelled"}}),
                false,
            );
        }
        return;
    }
    if mode == "late-response" {
        std::thread::sleep(Duration::from_millis(300));
    }
    if mode == "environment" {
        let keys: Vec<String> = std::env::vars_os()
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        let _ = std::fs::write("environment.json", serde_json::to_vec(&keys).unwrap());
    }
    if mode == "worker-error" {
        emit(
            &json!({"schema_version":1,"kind":"error","request_id":request["request_id"],"error":{"code":"unavailable"}}),
            false,
        );
        return;
    }
    let id = if mode == "wrong-id" {
        json!("00000000-0000-4000-8000-000000000099")
    } else {
        request["request_id"].clone()
    };
    let response = json!({"schema_version":1,"kind":"response","request_id":id,"result":{"status":"ok","worker_version":VERSION}});
    if !emit(&response, mode == "stdout-flood") {
        return;
    }
    if mode == "stdout-flood" {
        let _ = std::io::stdout().lock().write_all(&[b' '; 4096]);
        pause();
        return;
    }
    if mode == "response-hang" {
        pause();
        return;
    }
    if mode == "descendant" {
        // A short-lived child intentionally inherits pipes after this process exits.
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .arg("hold-pipes")
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        // Cannot wait here: the test needs an exited direct child with inherited pipes.
        #[allow(clippy::zombie_processes)]
        let _descendant = command.spawn().unwrap();
    }
    if mode == "nonzero" {
        std::process::exit(17);
    }
}
