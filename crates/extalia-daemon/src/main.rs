//! `extalia-daemon [--data-dir <absolute dir>] [--profile <id>] [--vault-root <absolute dir>]`:
//! sidecar child of the host
//! that holds the profile lock (ADR 0020). Length-prefixed JSON frames on stdin/stdout; logs
//! on stderr only. With `--data-dir`, takes the store lock, opens and migrates
//! `<dir>/state/core.sqlite` (ADR 0019) and recovers the profile's interrupted work
//! (ADR 0013) and its interrupted skill inspections (back to `quarantined`, ADR 0025)
//! before serving `mission.create`, `task.transition`, `event.commit` and the skill
//! registry operations for that one profile (`--profile`, default `default`; ADR 0024), and
//! the knowledge index operations on `<dir>/profiles/<profile>/knowledge.sqlite` (opened
//! lazily; an unusable index never stops the daemon). `--vault-root` (with `--data-dir` only)
//! names a user-chosen vault folder instead of `<dir>/vaults/<profile>`; it must be absolute
//! here and is validated on use (`knowledge.rs`): an unusable root makes the vault
//! unavailable, never stops the daemon and never falls back to the default.
//! Knowledge requests run on their own thread, in arrival order (`session.rs`), so a long
//! vault sync never holds back mission, permission or skill requests; answers are
//! correlated by request id and may leave out of request order.
//!
//! Exit status: 0 when stdin ends on a frame boundary (after the knowledge requests already
//! received are answered); 1 after a fatal protocol error, a truncated frame or an I/O
//! failure; 2 for invalid arguments; 3 when the core store cannot be opened or recovered; 4
//! when another process holds the store lock. 3 and 4 fail closed before any frame is read.

use std::ffi::OsString;
use std::io::{self, BufWriter};
use std::path::PathBuf;
use std::process::ExitCode;

use extalia_core::adapters::sqlite::store_path;
use extalia_core::time::now_millis;
use extalia_core::{CoreStore, StoreError};
use extalia_daemon::knowledge::Knowledge;
use extalia_daemon::missions::{DEFAULT_PROFILE, Missions, is_profile_id};
use extalia_daemon::session::{Exit, Session, serve};
use extalia_daemon::skills::Skills;

const USAGE: &str = "usage: extalia-daemon [--data-dir <absolute directory>] [--profile <profile id>] \
     [--vault-root <absolute directory>]";

#[derive(Debug, Default)]
struct Args {
    data_dir: Option<PathBuf>,
    profile: Option<String>,
    vault_root: Option<PathBuf>,
}

fn parse_args(mut args: impl Iterator<Item = OsString>) -> Result<Args, ()> {
    let mut parsed = Args::default();
    while let Some(arg) = args.next() {
        let text = arg.to_str().unwrap_or_default();
        let (name, value) = match text.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(OsString::from(value))),
            _ => (text, None),
        };
        let value = match name {
            "--data-dir" | "--profile" | "--vault-root" => {
                value.or_else(|| args.next()).ok_or(())?
            }
            _ => return Err(()),
        };
        if name == "--vault-root" {
            let path = PathBuf::from(value);
            if parsed.vault_root.is_some() || !path.is_absolute() {
                return Err(());
            }
            parsed.vault_root = Some(path);
        } else if name == "--data-dir" {
            let path = PathBuf::from(value);
            if parsed.data_dir.is_some() || !path.is_absolute() {
                return Err(());
            }
            parsed.data_dir = Some(path);
        } else {
            let profile = value.into_string().map_err(drop)?;
            if parsed.profile.is_some() || !is_profile_id(&profile) {
                return Err(());
            }
            parsed.profile = Some(profile);
        }
    }
    if parsed.vault_root.is_some() && parsed.data_dir.is_none() {
        return Err(());
    }
    Ok(parsed)
}

/// Lock, open, migrate and recover the store, or the exit status of the failure.
fn open(dir: &std::path::Path, profile: String) -> Result<(Missions, Skills), ExitCode> {
    let mut store = CoreStore::open(&store_path(dir)).map_err(|error| {
        eprintln!("extalia-daemon: {error}");
        ExitCode::from(if matches!(error, StoreError::Locked) {
            4
        } else {
            3
        })
    })?;
    match store.recover(&profile, now_millis()) {
        Ok(report) if report != Default::default() => eprintln!(
            "extalia-daemon: recovered {} mission(s) and {} task(s) as unknown \
             ({} expired and {} orphaned lease(s)); nothing is replayed",
            report.missions, report.tasks, report.expired_leases, report.orphaned_leases
        ),
        Ok(_) => {}
        Err(error) => {
            eprintln!("extalia-daemon: recovery failed ({error})");
            return Err(ExitCode::from(3));
        }
    }
    let mut skills = Skills::new(dir, &profile);
    match skills.restore_builtins(&mut store) {
        Ok(report) => {
            if !report.integrity.is_empty() || !report.invalid.is_empty() {
                eprintln!(
                    "extalia-daemon: {} built-in skill(s) failed re-verification and {} no \
                     longer resolve; they stay unavailable",
                    report.integrity.len(),
                    report.invalid.len()
                );
            }
        }
        Err(error) => {
            eprintln!("extalia-daemon: built-in skill verification failed ({error})");
            return Err(ExitCode::from(3));
        }
    }
    match skills.recover(&mut store) {
        Ok(recovered) if !recovered.is_empty() => eprintln!(
            "extalia-daemon: {} interrupted skill inspection(s) returned to quarantine; \
             nothing is replayed",
            recovered.len()
        ),
        Ok(_) => {}
        Err(error) => {
            eprintln!("extalia-daemon: skill recovery failed ({error})");
            return Err(ExitCode::from(3));
        }
    }
    Ok((Missions::new(store, profile), skills))
}

fn main() -> ExitCode {
    let Ok(args) = parse_args(std::env::args_os().skip(1)) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let profile = args.profile.unwrap_or_else(|| DEFAULT_PROFILE.to_owned());
    let vault_root = args.vault_root;
    let opened = args
        .data_dir
        .map(|dir| open(&dir, profile.clone()).map(|opened| (opened, dir)))
        .transpose();
    let mut session = match opened {
        Ok(Some(((missions, skills), dir))) => Session::with_missions(missions)
            .with_skills(skills)
            .with_knowledge({
                let knowledge = Knowledge::new(&dir, &profile);
                match vault_root {
                    Some(root) => knowledge.with_vault_root(root),
                    None => knowledge,
                }
            }),
        Ok(None) => Session::new(),
        Err(code) => return code,
    };
    let outcome = serve(
        io::stdin().lock(),
        BufWriter::new(io::stdout()),
        &mut session,
    );
    if let Some(Err(error)) = session
        .into_missions()
        .map(|missions| missions.into_store().close())
    {
        eprintln!("extalia-daemon: {error}");
    }
    match outcome {
        Ok(Exit::Eof) => ExitCode::SUCCESS,
        Ok(Exit::ProtocolError) => ExitCode::from(1),
        Ok(Exit::Truncated) => {
            eprintln!("extalia-daemon: stdin ended inside a frame");
            ExitCode::from(1)
        }
        Err(error) => {
            eprintln!("extalia-daemon: stdio failed ({})", error.kind());
            ExitCode::from(1)
        }
    }
}
