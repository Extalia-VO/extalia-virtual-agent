//! Task and mission state transition tables shared with `@extalia/protocol`
//! (`TASK_TRANSITIONS`, `MISSION_TRANSITIONS` in `packages/protocol/src/transitions.ts`).
//! The generated `packages/protocol/schemas/transitions.json` is embedded at compile time
//! and parsed once, so the daemon and the TypeScript side cannot drift; the drift check of
//! `tooling/generate-schemas.mjs` keeps the file equal to the TypeScript tables.

use std::sync::OnceLock;

use serde_json::Value;

use super::{MissionState, TaskState};

/// `packages/protocol/schemas/transitions.json`.
const SOURCE: &str = include_str!("../../../../packages/protocol/schemas/transitions.json");

/// The targets of each state, indexed by the state's position in `all` (declaration order).
fn load<S: Copy>(
    key: &str,
    all: &[S],
    name: fn(S) -> &'static str,
    parse: fn(&str) -> Option<S>,
) -> Vec<Vec<S>> {
    let root: Value = serde_json::from_str(SOURCE).expect("transitions.json is JSON");
    let table = root[key]
        .as_object()
        .expect("transitions.json has the table");
    assert_eq!(table.len(), all.len(), "transitions.json lists every state");
    all.iter()
        .map(|&from| {
            table
                .get(name(from))
                .and_then(Value::as_array)
                .expect("transitions.json lists the state")
                .iter()
                .map(|to| {
                    to.as_str()
                        .and_then(parse)
                        .expect("transitions.json names a known state")
                })
                .collect()
        })
        .collect()
}

/// Whether the task table lists `from -> to`.
pub(super) fn task_allows(from: TaskState, to: TaskState) -> bool {
    static TABLE: OnceLock<Vec<Vec<TaskState>>> = OnceLock::new();
    TABLE.get_or_init(|| load("task", TaskState::ALL, TaskState::as_str, TaskState::parse))
        [from as usize]
        .contains(&to)
}

/// Whether the mission table lists `from -> to`.
pub(super) fn mission_allows(from: MissionState, to: MissionState) -> bool {
    static TABLE: OnceLock<Vec<Vec<MissionState>>> = OnceLock::new();
    TABLE.get_or_init(|| {
        load(
            "mission",
            MissionState::ALL,
            MissionState::as_str,
            MissionState::parse,
        )
    })[from as usize]
        .contains(&to)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// The committed file, read from disk independently of the embedded copy.
    fn committed() -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/protocol/schemas/transitions.json");
        let text = std::fs::read_to_string(path).expect("read transitions.json");
        assert_eq!(text, SOURCE, "the embedded table is the committed file");
        serde_json::from_str(&text).expect("transitions.json is JSON")
    }

    fn listed(table: &Value, from: &str, to: &str) -> bool {
        table[from]
            .as_array()
            .expect("listed state")
            .iter()
            .any(|state| state == to)
    }

    #[test]
    fn tables_equal_the_shared_json() {
        let json = committed();
        let (tasks, missions) = (&json["task"], &json["mission"]);
        assert_eq!(
            tasks.as_object().map(|table| table.len()),
            Some(TaskState::ALL.len())
        );
        assert_eq!(
            missions.as_object().map(|table| table.len()),
            Some(MissionState::ALL.len())
        );
        for &from in TaskState::ALL {
            for &to in TaskState::ALL {
                assert_eq!(
                    from.can_transition_to(to),
                    listed(tasks, from.as_str(), to.as_str()),
                    "task {} -> {}",
                    from.as_str(),
                    to.as_str()
                );
            }
        }
        for &from in MissionState::ALL {
            for &to in MissionState::ALL {
                assert_eq!(
                    from.can_transition_to(to),
                    listed(missions, from.as_str(), to.as_str()),
                    "mission {} -> {}",
                    from.as_str(),
                    to.as_str()
                );
            }
        }
    }

    #[test]
    fn unresolved_and_finished_states_never_resume() {
        use TaskState::{Queued, Running, Unknown};
        for &state in TaskState::ALL {
            assert!(!state.can_transition_to(state), "task self-transition");
            if state.terminal() {
                assert!(
                    TaskState::ALL
                        .iter()
                        .all(|&to| !state.can_transition_to(to))
                );
            }
        }
        // ADR 0013: unknown work is resolved, never replayed.
        assert!(!Unknown.can_transition_to(Queued) && !Unknown.can_transition_to(Running));
        for &state in MissionState::ALL {
            assert!(!state.can_transition_to(state), "mission self-transition");
            if state.terminal() {
                assert!(
                    MissionState::ALL
                        .iter()
                        .all(|&to| !state.can_transition_to(to))
                );
            }
        }
        assert!(
            MissionState::ALL
                .iter()
                .all(|&to| { !MissionState::Recovering.can_transition_to(to) || to.terminal() })
        );
    }
}
