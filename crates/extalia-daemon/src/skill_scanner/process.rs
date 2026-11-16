use super::bundle::Bundle;
use extalia_core::skills::inspect::{Failure, InspectionRequest};
use serde_json::json;
use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
#[cfg(unix)]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
const MAX_OUTPUT: usize = 65536;
const DEADLINE: Duration = Duration::from_secs(60);
const MEMORY_KIB: u64 = 512 * 1024;
#[cfg(unix)]
static NEXT: AtomicU64 = AtomicU64::new(0);
pub fn supported() -> bool {
    macos_supported()
        && fs::metadata("/usr/bin/sandbox-exec").is_ok_and(|m| m.is_file())
        && fs::metadata("/bin/ps").is_ok_and(|m| m.is_file())
}
fn macos_supported() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let Ok(file) = fs::File::open("/System/Library/CoreServices/SystemVersion.plist") else {
        return false;
    };
    let mut bytes = Vec::new();
    if file.take(8193).read_to_end(&mut bytes).is_err() || bytes.len() > 8192 {
        return false;
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return false;
    };
    macos_version_supported(text)
}
fn macos_version_supported(text: &str) -> bool {
    text.split_once("<key>ProductVersion</key>")
        .and_then(|(_, tail)| tail.split_once("<string>"))
        .and_then(|(_, tail)| tail.split_once("</string>"))
        .map(|(version, _)| version.trim())
        .filter(|version| {
            version.len() <= 32 && version.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        })
        .and_then(|version| version.split('.').next()?.parse::<u32>().ok())
        .is_some_and(|major| major >= 14)
}
struct Job(PathBuf);
impl Drop for Job {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[cfg(unix)]
fn job() -> Result<Job, Failure> {
    use std::os::unix::fs::DirBuilderExt;

    for _ in 0..100 {
        let root = std::env::temp_dir().join(format!(
            "extalia-skill-scan-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::DirBuilder::new().mode(0o700).create(&root) {
            Ok(()) => return Ok(Job(root)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(Failure::Error),
        }
    }
    Err(Failure::Error)
}
#[cfg(not(unix))]
fn job() -> Result<Job, Failure> {
    Err(Failure::ScannerUnavailable)
}
fn literal(path: &std::path::Path) -> Result<String, Failure> {
    let value = path.to_str().ok_or(Failure::ScannerUnavailable)?;
    if value.chars().any(char::is_control) {
        return Err(Failure::ScannerUnavailable);
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}
fn read_output(mut input: impl Read, overflow: Arc<AtomicBool>) -> Result<Vec<u8>, Failure> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let count = input.read(&mut buffer).map_err(|_| Failure::Error)?;
        if count == 0 {
            break;
        }
        if output.len() + count > MAX_OUTPUT {
            overflow.store(true, Ordering::Release);
            return Err(Failure::InvalidOutput);
        }
        output.extend_from_slice(&buffer[..count]);
    }
    Ok(output)
}
// A sampled resident-memory watchdog, not a kernel virtual-memory limit. A
// missing/slow/malformed observation refuses the scan rather than dropping it.
fn resident_kib(pid: u32, deadline: Instant) -> Result<u64, Failure> {
    let mut probe = Command::new("/bin/ps")
        .args(["-o", "rss=", "-p"])
        .arg(pid.to_string())
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Failure::Error)?;
    let limit = std::cmp::min(deadline, Instant::now() + Duration::from_millis(250));
    let status = loop {
        match probe.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => {
                let _ = probe.kill();
                let _ = probe.wait();
                return Err(Failure::Error);
            }
        }
        if Instant::now() >= limit {
            let _ = probe.kill();
            let _ = probe.wait();
            return Err(Failure::Error);
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    if !status.success() {
        return Err(Failure::Error);
    }
    let mut bytes = Vec::new();
    probe
        .stdout
        .take()
        .ok_or(Failure::Error)?
        .take(65)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::Error)?;
    if bytes.len() > 64 {
        return Err(Failure::Error);
    }
    std::str::from_utf8(&bytes)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .filter(|n| *n > 0)
        .ok_or(Failure::Error)
}

pub fn scan(
    bundle: &Bundle,
    request: &InspectionRequest<'_>,
    budget: Duration,
) -> Result<Vec<u8>, Failure> {
    if !supported() {
        return Err(Failure::ScannerUnavailable);
    }
    if budget.is_zero() {
        return Err(Failure::Timeout);
    }
    let object = fs::canonicalize(request.object_dir).map_err(|_| Failure::Error)?;
    let job = job()?;
    let root = fs::canonicalize(&job.0).map_err(|_| Failure::Error)?;
    let mut ancestors = BTreeSet::new();
    for path in [&bundle.root.join("payload"), &object, &root] {
        for parent in path.ancestors().skip(1) {
            if ancestors.len() >= 256 {
                return Err(Failure::ScannerUnavailable);
            }
            ancestors.insert(parent.to_owned());
        }
    }
    // Upstream's safe openat walk opens each ancestor directory read-only. Only
    // those directory literals are readable; none grants a sibling file's data.
    let directory_reads = ancestors
        .iter()
        .map(|p| literal(p).map(|p| format!("(literal {p})")))
        .collect::<Result<Vec<_>, _>>()?
        .join(" ");
    let profile = format!(
        "(version 1)(deny default)(allow process-exec (literal {}))(allow sysctl-read)(allow file-read* {} (subpath {}) (subpath {}) (subpath {}) (subpath \"/System/Library\") (subpath \"/usr/lib\") (subpath \"/private/var/db/dyld\") (literal \"/dev/null\") (literal \"/dev/random\") (literal \"/dev/urandom\"))(allow file-write* (subpath {}))",
        literal(&bundle.interpreter)?,
        directory_reads,
        literal(&bundle.root.join("payload"))?,
        literal(&object)?,
        literal(&root)?,
        literal(&root)?
    );
    if profile.len() > 65536 {
        return Err(Failure::ScannerUnavailable);
    }
    let mut child = Command::new("/usr/bin/sandbox-exec")
        .arg("-p")
        .arg(profile)
        .arg(&bundle.interpreter)
        .args(["-I", "-S", "-B"])
        .arg(&bundle.script)
        .env_clear()
        .env("HOME", &root)
        .env("TMPDIR", &root)
        .env("PATH", "")
        .env("LC_ALL", "C")
        .env("EXTALIA_SKILLSPECTOR_PARENT_MEMORY_WATCHDOG", "1")
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| Failure::ScannerUnavailable)?;
    let mut bytes=serde_json::to_vec(&json!({"schema_version":1,"operation":"scan","input_path":object,"revision_id":request.revision_id,"tree_sha256":request.tree_sha256,"policy_version":request.policy_version})).map_err(|_|Failure::InvalidOutput)?;
    bytes.push(b'\n');
    if bytes.len() > 16384 {
        let _ = child.kill();
        let _ = child.wait();
        return Err(Failure::InvalidOutput);
    }
    let stdin = child.stdin.take().ok_or(Failure::Error)?;
    let stdout = child.stdout.take().ok_or(Failure::Error)?;
    let stderr = child.stderr.take().ok_or(Failure::Error)?;
    let overflow = Arc::new(AtomicBool::new(false));
    std::thread::scope(|scope| {
        let out = scope.spawn({
            let overflow = Arc::clone(&overflow);
            move || read_output(stdout, overflow)
        });
        let err = scope.spawn({
            let overflow = Arc::clone(&overflow);
            move || read_output(stderr, overflow)
        });
        let input = scope.spawn(move || {
            let mut stdin = stdin;
            stdin.write_all(&bytes).map_err(|_| Failure::Error)
        });
        let deadline = Instant::now() + budget.min(DEADLINE);
        let mut memory_at = Instant::now();
        let mut peak = 0;
        let status = loop {
            if overflow.load(Ordering::Acquire) {
                let _ = child.kill();
                break child
                    .wait()
                    .map_err(|_| Failure::Error)
                    .and(Err(Failure::InvalidOutput));
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                break child
                    .wait()
                    .map_err(|_| Failure::Error)
                    .and(Err(Failure::Timeout));
            }
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {
                    if Instant::now() >= memory_at {
                        match resident_kib(child.id(), deadline) {
                            Ok(resident) if resident <= MEMORY_KIB => {
                                peak = peak.max(resident);
                            }
                            _ => {
                                // The process may have exited between try_wait and ps.
                                if let Ok(Some(status)) = child.try_wait() {
                                    break Ok(status);
                                }
                                let _ = child.kill();
                                let _ = child.wait();
                                break Err(Failure::Error);
                            }
                        }
                        memory_at = Instant::now() + Duration::from_millis(100);
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(Failure::Error);
                }
            }
        };
        eprintln!("extalia-daemon: scanner sampled resident high-water {peak} KiB");
        let output = out.join().map_err(|_| Failure::Error)?;
        let logged = err.join().map_err(|_| Failure::Error)?;
        let written = input.join().map_err(|_| Failure::Error)?;
        let status = status?;
        written?;
        let output = output?;
        let _ = logged?;
        if !status.success() {
            return Err(Failure::Error);
        }
        if output.is_empty()
            || output.last() != Some(&b'\n')
            || output.iter().filter(|b| **b == b'\n').count() != 1
        {
            return Err(Failure::InvalidOutput);
        }
        Ok(output)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(unix))]
    #[test]
    fn unsupported_platform_refuses_job_preparation() {
        assert!(matches!(job(), Err(Failure::ScannerUnavailable)));
    }

    #[test]
    fn macos_wheel_floor_is_explicit_and_missing_version_refuses() {
        for (version, expected) in [
            ("13.7", false),
            ("14.0", true),
            ("26.1", true),
            ("nonsense", false),
        ] {
            assert_eq!(
                macos_version_supported(&format!(
                    "<key>ProductVersion</key><string>{version}</string>"
                )),
                expected
            );
        }
        assert!(!macos_version_supported(
            "<key>ProductUserVisibleVersion</key><string>26.1</string>"
        ));
    }
}
