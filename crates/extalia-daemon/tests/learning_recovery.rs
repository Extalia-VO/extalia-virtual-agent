//! Kill/restart the actual stdio daemon against synthetic private data. No model,
//! application configuration, real home directory or external service is used.
#![cfg(unix)]

use extalia_daemon::wire;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        loop {
            let root = std::env::temp_dir().join(format!(
                "extalia-daemon-learning-recovery-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&root) {
                Ok(()) => return Self(root),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("temporary test directory unavailable: {error}"),
            }
        }
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Daemon {
    child: Child,
    stdin: ChildStdin,
    frames: Receiver<Vec<u8>>,
}
impl Daemon {
    fn start(data: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_extalia-daemon"))
            .env_clear()
            .arg("--data-dir")
            .arg(data)
            .arg("--profile")
            .arg("default")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (sender, frames) = channel();
        std::thread::spawn(move || {
            loop {
                let mut size = [0; 4];
                if stdout.read_exact(&mut size).is_err() {
                    return;
                }
                let len = u32::from_be_bytes(size) as usize;
                if len > wire::MAX_FRAME_BYTES {
                    return;
                }
                let mut bytes = vec![0; len];
                if stdout.read_exact(&mut bytes).is_err() || sender.send(bytes).is_err() {
                    return;
                }
            }
        });
        let mut daemon = Self {
            child,
            stdin,
            frames,
        };
        let hello = daemon.request(
            "hello",
            json!({"clientVersion":"recovery-test","capabilities":["hello","learning.process"]}),
        );
        assert_eq!(hello["kind"], "response", "{hello}");
        assert!(
            hello["result"]["capabilities"]
                .as_array()
                .unwrap()
                .contains(&json!("learning.process"))
        );
        daemon
    }
    fn request(&mut self, op: &str, params: Value) -> Value {
        let request = json!({"schemaVersion":1,"kind":"request","requestId":"00000000-0000-4000-8000-000000000321","op":op,"params":params});
        let bytes = serde_json::to_vec(&request).unwrap();
        self.stdin
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .unwrap();
        self.stdin.write_all(&bytes).unwrap();
        self.stdin.flush().unwrap();
        let bytes = self
            .frames
            .recv_timeout(Duration::from_secs(10))
            .expect("daemon responds within bounded test time");
        wire::decode_payload(&bytes)
            .expect("reply obeys generated wire schema")
            .to_value()
    }
    fn learning(&mut self, action: &str, input: Value) -> Value {
        let reply = self.request("learning.process", json!({"action":action,"input":input}));
        assert_eq!(reply["kind"], "response", "{reply}");
        assert_eq!(reply["result"]["action"], action);
        reply["result"].clone()
    }
}
impl Drop for Daemon {
    fn drop(&mut self) {
        // A kill, not graceful EOF: no shutdown callback can flush missing state.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn begin() -> Value {
    json!({"profileId":"default","revision":"vault-r1","workspaceId":"workspace","sessionId":"session","runId":"run","promptSha256":"a".repeat(64),"routeFingerprint":"b".repeat(64),"policy":{"enabled":true,"skills":true,"notes":true},"tools":[],"evidence":[{"toolCallId":"source-1","name":"reported-check","content":"The check reported a successful result; recheck before reuse.","isError":false}]})
}
fn recovery(job: &Value) -> Value {
    let v = begin();
    json!({"jobId":job["jobId"],"profileId":v["profileId"],"workspaceId":v["workspaceId"],"sessionId":v["sessionId"],"runId":v["runId"],"promptSha256":v["promptSha256"],"destinationRevision":v["revision"],"routeFingerprint":v["routeFingerprint"],"policy":v["policy"],"tools":[]})
}
fn effect(job: &Value) -> Value {
    json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"]})
}

#[test]
fn process_kill_retains_prepared_work_and_independent_publication_receipts() {
    let data = Temp::new();
    let mut first = Daemon::start(&data.0);
    let original = first.learning("job.begin", begin())["job"].clone();
    drop(first);
    let mut second = Daemon::start(&data.0);
    let list = second.learning(
        "job.list",
        json!({"profileId":"default","workspaceId":"workspace","sessionId":"session"}),
    );
    assert_eq!(list["jobs"][0]["state"], "resumable");
    let resumed = second.learning("job.recover", recovery(&original))["job"].clone();
    assert_eq!(resumed["effect"], original["effect"]);
    second.learning("job.enter", effect(&resumed));
    let mut advance = effect(&resumed);
    advance["completion"] = json!({"kind":"model","result":{"text":"","stop":"tool_use","toolCalls":[{"id":"submit-one","name":"submit_learning","input":{"title":"Check before reuse","lesson":"Treat the earlier report as a claim and run the check again.","evidenceIds":["source-1"],"skill":{"name":"check-before-reuse","description":"Use when reusing a previously reported result.","instructions":"## When to Use\nReuse a result.\n## Procedure\nRepeat the check.\n## Pitfalls\nAn old report can be stale.\n## Verification\nInspect current output."}}}]}});
    let ready = second.learning("job.advance", advance)["job"].clone();
    assert_eq!(ready["status"], "ready");
    let note_key = json!({"profileId":"default","runId":"run","contentSha256":ready["noteSha256"]});
    assert_eq!(
        second.learning("receipt.claim", note_key.clone())["claimed"],
        true
    );
    let mut confirmation = note_key;
    confirmation["receipt"] =
        json!({"kind":"note","data":"{\"path\":\"Learning/workspace/run.md\"}"});
    second.learning("receipt.record", confirmation);
    second.learning(
        "receipt.claim",
        json!({"profileId":"default","runId":"run","contentSha256":ready["skillSha256"]}),
    );
    drop(second);
    let mut third = Daemon::start(&data.0);
    let saved = third.learning("job.recover", recovery(&ready))["job"].clone();
    assert_eq!(saved["submission"], ready["submission"]);
    assert_eq!(saved["noteSha256"], ready["noteSha256"]);
    assert_eq!(saved["skillSha256"], ready["skillSha256"]);
    assert!(saved.get("effect").is_none());
    assert_eq!(
        third.learning(
            "receipt.get",
            json!({"profileId":"default","contentSha256":saved["noteSha256"]})
        )["status"],
        "recorded"
    );
    assert_eq!(
        third.learning(
            "receipt.get",
            json!({"profileId":"default","contentSha256":saved["skillSha256"]})
        )["status"],
        "attempted"
    );
    assert_eq!(
        third.learning(
            "receipt.claim",
            json!({"profileId":"default","runId":"run","contentSha256":saved["skillSha256"]})
        )["claimed"],
        false
    );
}

#[test]
fn process_kill_after_enter_never_reissues_the_admitted_effect() {
    let data = Temp::new();
    let mut first = Daemon::start(&data.0);
    let job = first.learning("job.begin", begin())["job"].clone();
    first.learning("job.enter", effect(&job));
    drop(first);
    let mut second = Daemon::start(&data.0);
    let list = second.learning("job.list", json!({"profileId":"default"}));
    assert_eq!(list["jobs"][0]["state"], "uncertain");
    assert_eq!(list["jobs"][0]["active"], false);
    let denied = second.request(
        "learning.process",
        json!({"action":"job.recover","input":recovery(&job)}),
    );
    assert_eq!(denied["kind"], "error");
    assert_eq!(
        denied["error"]["reason"],
        "learning_recovery_effect_uncertain"
    );
}

#[test]
fn process_kill_before_idle_preserves_snoozed_intent_and_admits_the_same_job_once() {
    let data = Temp::new();
    let mut first = Daemon::start(&data.0);
    let mut capture = begin();
    let tools = capture.as_object_mut().unwrap().remove("tools").unwrap();
    let record = first.learning("queue.capture", capture.clone())["record"].clone();
    assert_eq!(record["state"], "queued");
    assert_eq!(record["modelRequests"], 0);
    assert_eq!(record["active"], false);
    drop(first);

    let mut second = Daemon::start(&data.0);
    let replay = second.learning("queue.capture", capture);
    assert_eq!(replay["created"], false);
    assert_eq!(replay["record"], record);
    let mut control = json!({});
    for key in [
        "profileId",
        "workspaceId",
        "sessionId",
        "runId",
        "promptSha256",
        "destinationRevision",
        "routeFingerprint",
        "policy",
        "jobId",
    ] {
        control[key] = record[key].clone();
    }
    control["queueRevision"] = record["queue"]["revision"].clone();
    let mut snooze = control.clone();
    snooze["delaySeconds"] = 600.into();
    let snoozed = second.learning("queue.delay", snooze)["record"].clone();
    assert_eq!(snoozed["queue"]["delaySeconds"], 600);
    drop(second);

    let mut third = Daemon::start(&data.0);
    let records = third.learning("job.list", json!({"profileId":"default"}));
    assert_eq!(records["jobs"][0], snoozed);
    control["tools"] = tools;
    let stale = third.request(
        "learning.process",
        json!({"action":"queue.admit","input":control}),
    );
    assert_eq!(stale["kind"], "error");
    assert_eq!(stale["error"]["reason"], "learning_queue_changed");
    control["queueRevision"] = snoozed["queue"]["revision"].clone();
    let admitted = third.learning("queue.admit", control.clone())["job"].clone();
    assert_eq!(admitted["jobId"], record["jobId"]);
    assert_eq!(admitted["effect"]["kind"], "model");
    drop(third);

    let mut fourth = Daemon::start(&data.0);
    let records = fourth.learning("job.list", json!({"profileId":"default"}));
    assert_eq!(records["jobs"][0]["state"], "resumable");
    assert_eq!(records["jobs"][0]["modelRequests"], 1);
    let retry = fourth.request(
        "learning.process",
        json!({"action":"queue.admit","input":control}),
    );
    assert_eq!(retry["kind"], "error");
    assert_eq!(retry["error"]["reason"], "learning_queue_already_admitted");
    let recovered = fourth.learning("job.recover", recovery(&admitted))["job"].clone();
    assert_eq!(recovered["effect"], admitted["effect"]);
}
