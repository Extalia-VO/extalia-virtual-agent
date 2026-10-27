//! Learning loop tests. Every test works in its own temporary directory only.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::{Value, json};

use super::*;
use crate::adapters::sqlite::store_path;
use crate::knowledge::{ConflictReason, History, Vault, VaultLimits, read_note, write::is_managed};
use crate::mission::{AgentEvent, MissionCreate, TaskState, TaskTransition, contract};
use crate::sha256::hex_digest;
use crate::skills::{Origin, RevisionState, SkillRegistry};
use crate::time::parse_utc;

const WORKSPACE: &str = "00000000-0000-4000-8000-000000000001";
const LEAD: &str = "00000000-0000-4000-8000-000000000003";
const WORKER: &str = "00000000-0000-4000-8000-000000000004";
const SESSION: &str = "00000000-0000-4000-8000-000000000014";
const USER: &str = "user:local";

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        loop {
            let dir = std::env::temp_dir().join(format!(
                "extalia-learning-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&dir) {
                Ok(()) => return Self(dir),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("cannot create a temporary directory: {error}"),
            }
        }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn now() -> i64 {
    parse_utc("2026-10-24T12:00:00.000Z").unwrap()
}

/// `00000000-0000-4000-8000-<n as 12 hex>`; missions use `n` in the 0x1000 range.
fn uuid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

fn profile(name: &str) -> ProfileId {
    ProfileId::parse(name).unwrap()
}

/// A data directory with its core store.
struct Env {
    dir: TempDir,
    store: CoreStore,
    next_event: u32,
}

impl Env {
    fn new() -> Self {
        let dir = TempDir::new();
        let store = CoreStore::open(&store_path(&dir.0)).unwrap();
        Self {
            dir,
            store,
            next_event: 0x9000,
        }
    }

    fn data(&self) -> PathBuf {
        self.dir.0.clone()
    }

    fn learning(&mut self, name: &str) -> Learning<'_> {
        let data = self.data();
        Learning::new(&mut self.store, &data, profile(name))
    }

    fn vault(&self, name: &str) -> (Vault, History) {
        let profile = profile(name);
        (
            Vault::open_default(&self.dir.0, &profile, VaultLimits::default()).unwrap(),
            History::open(&self.dir.0, &profile).unwrap(),
        )
    }

    fn event_id(&mut self) -> String {
        self.next_event += 1;
        uuid(self.next_event)
    }

    fn mission_event(&mut self, profile: &str, mission: &str, state: &str) {
        let value = json!({ "schemaVersion": 1, "id": self.event_id(), "workspaceId": WORKSPACE,
            "sessionId": SESSION, "missionId": mission, "agentId": LEAD,
            "source": { "runtime": "extalia-native", "channel": "system" },
            "observedAt": "2026-10-24T11:00:00.000Z", "sequence": 1, "confidence": "reported",
            "body": { "type": "mission.state", "state": state } });
        let mut errors = Vec::new();
        let event: AgentEvent = contract::agent_event(&value, "event", &mut errors)
            .unwrap_or_else(|| panic!("{errors:?}"));
        self.store.commit_event(profile, &event, now()).unwrap();
    }

    fn transition(
        &mut self,
        profile: &str,
        mission: &str,
        task: &str,
        from: TaskState,
        to: TaskState,
    ) {
        let transition = TaskTransition {
            mission_id: mission.into(),
            task_id: task.into(),
            event_id: self.event_id(),
            from,
            to,
        };
        self.store
            .transition_task(profile, &transition, now())
            .unwrap();
    }

    /// A mission `n` in `profile` with one task per final state (task ids `n * 16 + i`),
    /// left running when `finish` is false, else completed.
    fn mission(
        &mut self,
        profile: &str,
        n: u32,
        finals: &[TaskState],
        requirements: &[&str],
        finish: bool,
    ) -> (String, Vec<String>) {
        let mission = uuid(0x1000 + n);
        let tasks: Vec<String> = (0..finals.len() as u32)
            .map(|i| uuid(0x2000 + n * 16 + i))
            .collect();
        let task_json: Vec<Value> = tasks
            .iter()
            .map(|id| {
                json!({ "schemaVersion": 1, "id": id, "missionId": mission, "dependsOn": [],
                    "assignedAgentId": WORKER, "state": "queued", "attempt": 0,
                    "requirements": requirements, "evidenceIds": [] })
            })
            .collect();
        let value = json!({
            "mission": { "schemaVersion": 1, "id": mission, "workspaceId": WORKSPACE, "leadAgentId": LEAD,
                "budgetId": "00000000-0000-4000-8000-000000000006", "state": "queued",
                "createdAt": "2026-10-24T10:00:00.000Z", "updatedAt": "2026-10-24T10:00:00.000Z", "version": 1 },
            "graph": { "schemaVersion": 1, "missionId": mission, "tasks": task_json },
        });
        let mut errors = Vec::new();
        let create: MissionCreate = contract::mission_create(&value, "params", &mut errors)
            .unwrap_or_else(|| panic!("{errors:?}"));
        self.store.create_mission(profile, &create, now()).unwrap();
        self.mission_event(profile, &mission, "running");
        for (task, state) in tasks.iter().zip(finals) {
            match state {
                TaskState::Completed | TaskState::Failed => {
                    self.transition(
                        profile,
                        &mission,
                        task,
                        TaskState::Queued,
                        TaskState::Running,
                    );
                    self.transition(profile, &mission, task, TaskState::Running, *state);
                }
                TaskState::Cancelled => {
                    self.transition(
                        profile,
                        &mission,
                        task,
                        TaskState::Queued,
                        TaskState::Cancelled,
                    );
                }
                _ => {}
            }
        }
        if finish {
            self.mission_event(profile, &mission, "completed");
        }
        (mission, tasks)
    }

    /// A finished mission with one completed task whose test gate passed, captured.
    fn verified_experience(&mut self, profile: &str, n: u32) -> i64 {
        let (mission, tasks) = self.mission(profile, n, &[TaskState::Completed], &["Build"], true);
        let mut learning = self.learning(profile);
        learning
            .record_evidence(&gate(&mission, &tasks[0], Claim::Success, n), now())
            .unwrap();
        learning
            .capture_mission(&mission, now())
            .unwrap()
            .experiences[0]
            .id
    }

    /// Every row of every skill table, for "nothing was written" comparisons.
    fn skill_rows(&mut self) -> Vec<String> {
        let conn = self.store.connection();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'skill%' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let mut rows = Vec::new();
        for table in tables {
            let mut statement = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
            let columns = statement.column_count();
            let mut query = statement.query([]).unwrap();
            while let Some(row) = query.next().unwrap() {
                let values: Vec<String> = (0..columns)
                    .map(|i| format!("{:?}", row.get::<_, rusqlite::types::Value>(i).unwrap()))
                    .collect();
                rows.push(format!("{table}: {}", values.join("|")));
            }
        }
        rows
    }
}

fn digest_of(n: u32) -> String {
    hex_digest(format!("artifact {n}").as_bytes())
}

fn gate<'a>(mission: &'a str, task: &'a str, claim: Claim, n: u32) -> EvidenceInput<'a> {
    let digest: &'static str = Box::leak(digest_of(n).into_boxed_str());
    EvidenceInput {
        mission_id: mission,
        task_id: task,
        kind: EvidenceKind::TestGate,
        claim,
        digest,
        reference: "gate:integration-1",
        excerpt: Some("12 passed"),
        recorded_by: "extalia:integration",
    }
}

fn evidence<'a>(
    mission: &'a str,
    task: &'a str,
    kind: EvidenceKind,
    claim: Claim,
    n: u32,
    recorded_by: &'a str,
) -> EvidenceInput<'a> {
    EvidenceInput {
        kind,
        recorded_by,
        ..gate(mission, task, claim, n)
    }
}

fn knowledge<'a>(
    ids: &'a [i64],
    target: Option<&'a str>,
    finding: &'a str,
) -> KnowledgeProposal<'a> {
    KnowledgeProposal {
        title: "Run migrations before seeding",
        finding,
        target_path: target,
        experience_ids: ids,
        rationale: "Two verified runs needed the order.",
        component: "lead",
    }
}

fn skill(ids: &[i64]) -> SkillProposal<'_> {
    SkillProposal {
        name: "seed-after-migrate",
        description: "Run database migrations before seeding test data",
        instructions: "1. Run the migrations.\n2. Seed the test data.\n",
        experience_ids: ids,
        rationale: "Learned from verified runs.",
        component: "lead",
    }
}

fn decision<'a>(candidate: &'a Candidate, principal: &'a str) -> DecisionRequest<'a> {
    DecisionRequest {
        candidate_id: candidate.id,
        principal,
        proposal_digest: &candidate.proposal_digest,
        note: None,
    }
}

#[test]
fn capture_requires_a_finished_mission_and_is_idempotent() {
    let mut env = Env::new();
    let finals = [
        TaskState::Completed,
        TaskState::Failed,
        TaskState::Cancelled,
    ];
    let (running, _) = env.mission("work", 1, &finals, &["Build"], false);
    assert!(matches!(
        env.learning("work").capture_mission(&running, now()),
        Err(LearningError::Denied("mission_not_finished"))
    ));
    assert!(matches!(
        env.learning("work").capture_mission(&uuid(0x1fff), now()),
        Err(LearningError::NotFound)
    ));

    let (mission, tasks) = env.mission("work", 2, &finals, &["Build", "Test"], true);
    let mut learning = env.learning("work");
    let first = learning.capture_mission(&mission, now()).unwrap();
    assert_eq!(first.created, 2);
    assert_eq!(
        first.skipped,
        [tasks[2].clone()],
        "a cancelled task has no result"
    );
    let outcomes: Vec<_> = first
        .experiences
        .iter()
        .map(|e| (e.task_id.as_str(), e.task_state, e.outcome, e.basis))
        .collect();
    assert_eq!(
        outcomes,
        [
            (
                tasks[0].as_str(),
                TaskState::Completed,
                Outcome::Success,
                Basis::Unverified
            ),
            (
                tasks[1].as_str(),
                TaskState::Failed,
                Outcome::Failure,
                Basis::Unverified
            ),
        ],
        "a native report alone is never verified"
    );
    let experience = &first.experiences[0];
    assert_eq!(experience.workspace_id, WORKSPACE);
    assert_eq!(experience.agent_id.as_deref(), Some(WORKER));
    assert!(
        experience
            .summary
            .contains("Requirements:\n- Build\n- Test\n")
    );
    let recorded = learning.evidence(&tasks[0]).unwrap();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].kind, EvidenceKind::TaskResult);
    assert_eq!(recorded[0].trust, TrustStatus::Unverified);
    assert_eq!(recorded[0].reference, format!("task:{}", tasks[0]));
    assert_eq!(experience.evidence_ids, [recorded[0].id]);

    let again = learning.capture_mission(&mission, now() + 1_000).unwrap();
    assert_eq!(again.created, 0);
    assert_eq!(again.experiences, first.experiences);
    assert_eq!(
        learning.evidence(&tasks[0]).unwrap().len(),
        1,
        "no duplicate task result"
    );
    assert_eq!(learning.experiences(&mission).unwrap(), first.experiences);
}

#[test]
fn verified_evidence_decides_the_basis_and_observed_claims_never_do() {
    let mut env = Env::new();
    let finals = [TaskState::Completed; 5];
    let (mission, t) = env.mission("work", 1, &finals, &["Build"], true);
    let mut learning = env.learning("work");
    let observed = |task, n| {
        evidence(
            &mission,
            task,
            EvidenceKind::ObservedClaim,
            Claim::Success,
            n,
            "extalia:observer",
        )
    };
    let confirm = |task, claim, n| {
        evidence(
            &mission,
            task,
            EvidenceKind::UserConfirmation,
            claim,
            n,
            USER,
        )
    };
    // 0: gate passed; 1: user confirmed; 2: gate passed but the user says it failed;
    // 3: only an observed claim of success; 4: gate failed although the task completed.
    learning
        .record_evidence(&gate(&mission, &t[0], Claim::Success, 1), now())
        .unwrap();
    learning
        .record_evidence(&confirm(&t[1], Claim::Success, 2), now())
        .unwrap();
    learning
        .record_evidence(&gate(&mission, &t[2], Claim::Success, 3), now())
        .unwrap();
    learning
        .record_evidence(&confirm(&t[2], Claim::Failure, 4), now())
        .unwrap();
    let claim = learning
        .record_evidence(&observed(&t[3], 5), now())
        .unwrap();
    assert_eq!(claim.trust, TrustStatus::Untrusted);
    learning
        .record_evidence(&gate(&mission, &t[4], Claim::Failure, 6), now())
        .unwrap();
    let report = learning.capture_mission(&mission, now()).unwrap();
    let derived: Vec<_> = report
        .experiences
        .iter()
        .map(|e| (e.outcome, e.basis))
        .collect();
    assert_eq!(
        derived,
        [
            (Outcome::Success, Basis::VerifiedByExtalia),
            (Outcome::Success, Basis::UserConfirmed),
            (Outcome::Disputed, Basis::Unverified),
            (Outcome::Success, Basis::Unverified),
            (Outcome::Failure, Basis::VerifiedByExtalia),
        ]
    );
    // The observed claim is cited (provenance) but stays untrusted.
    assert_eq!(report.experiences[3].evidence_ids.len(), 2);
    assert!(
        report.experiences[3]
            .summary
            .contains("observed_claim success (untrusted)")
    );
}

#[test]
fn evidence_rules_and_principals() {
    let mut env = Env::new();
    let (mission, t) = env.mission("work", 1, &[TaskState::Completed], &["Build"], false);
    let (other, u) = env.mission("work", 2, &[TaskState::Completed], &["Build"], false);
    let mut learning = env.learning("work");
    let denied = |result: Result<EvidenceRecord, LearningError>| match result {
        Err(LearningError::Denied(reason)) => reason,
        other => panic!("expected a refusal, got {other:?}"),
    };
    let base = gate(&mission, &t[0], Claim::Success, 1);
    let cases = [
        (
            EvidenceInput {
                kind: EvidenceKind::TaskResult,
                ..base.clone()
            },
            "task_result_is_captured",
        ),
        (
            EvidenceInput {
                kind: EvidenceKind::UserConfirmation,
                ..base.clone()
            },
            "principal_not_user",
        ),
        (
            EvidenceInput {
                recorded_by: USER,
                ..base.clone()
            },
            "principal_not_extalia",
        ),
        (
            EvidenceInput {
                recorded_by: "extalia:",
                ..base.clone()
            },
            "principal_not_extalia",
        ),
        (
            EvidenceInput {
                recorded_by: "agent:worker",
                ..base.clone()
            },
            "principal_not_extalia",
        ),
        (
            EvidenceInput {
                kind: EvidenceKind::ObservedClaim,
                recorded_by: "user:x",
                ..base.clone()
            },
            "principal_not_extalia",
        ),
        (
            EvidenceInput {
                digest: "ABC",
                ..base.clone()
            },
            "invalid_digest",
        ),
        (
            EvidenceInput {
                reference: "two\nlines",
                ..base.clone()
            },
            "invalid_reference",
        ),
        (
            EvidenceInput {
                excerpt: Some("bell\u{7}"),
                ..base.clone()
            },
            "invalid_excerpt",
        ),
    ];
    for (input, reason) in cases {
        assert_eq!(denied(learning.record_evidence(&input, now())), reason);
    }
    let long = "r".repeat(MAX_REF_BYTES + 1);
    assert_eq!(
        denied(learning.record_evidence(
            &EvidenceInput {
                reference: &long,
                ..base.clone()
            },
            now()
        )),
        "reference_too_long"
    );
    // The task must belong to the named mission of this profile.
    assert!(matches!(
        learning.record_evidence(&gate(&other, &t[0], Claim::Success, 1), now()),
        Err(LearningError::NotFound)
    ));
    assert!(matches!(
        learning.record_evidence(&gate(&mission, &u[0], Claim::Success, 1), now()),
        Err(LearningError::NotFound)
    ));
    let first = learning.record_evidence(&base, now()).unwrap();
    assert_eq!(first.trust, TrustStatus::Verified);
    assert_eq!(
        learning.record_evidence(&base, now() + 5).unwrap(),
        first,
        "idempotent"
    );
    assert_eq!(
        denied(learning.record_evidence(&gate(&mission, &t[0], Claim::Failure, 1), now())),
        "evidence_conflict"
    );
    for n in 2..=MAX_EVIDENCE_PER_TASK as u32 {
        learning
            .record_evidence(&gate(&mission, &t[0], Claim::Success, n), now())
            .unwrap();
    }
    assert_eq!(
        denied(learning.record_evidence(&gate(&mission, &t[0], Claim::Success, 999), now())),
        "too_much_evidence"
    );
}

#[test]
fn credentials_are_masked_and_summaries_bounded() {
    let mut env = Env::new();
    let secret = "api_key=abcdef1234567890"; // extalia-allow-secret
    let long: Vec<String> = (0..10)
        .map(|i| format!("{i}{}", "x".repeat(1_000)))
        .collect();
    let mut requirements = vec![secret];
    requirements.extend(long.iter().map(String::as_str));
    let (mission, t) = env.mission("work", 1, &[TaskState::Completed], &requirements, true);
    let mut learning = env.learning("work");
    let reference = "https://bob:hunter2pass@example.com/log"; // extalia-allow-secret
    let excerpt = "token: abcdefghijkl1234 passed"; // extalia-allow-secret
    let record = learning
        .record_evidence(
            &EvidenceInput {
                reference,
                excerpt: Some(excerpt),
                ..gate(&mission, &t[0], Claim::Success, 1)
            },
            now(),
        )
        .unwrap();
    assert_eq!(record.reference, "https://[redacted]@example.com/log");
    assert!(
        !record
            .excerpt
            .as_deref()
            .unwrap()
            .contains("abcdefghijkl1234")
    );
    assert_eq!(record.masked_count, 2);
    let experience = learning
        .capture_mission(&mission, now())
        .unwrap()
        .experiences
        .remove(0);
    assert!(!experience.summary.contains("abcdef1234567890"));
    assert!(experience.summary.contains("api_key=[redacted]"));
    assert!(experience.masked_count >= 1);
    assert!(experience.summary.len() <= MAX_SUMMARY_BYTES);
    assert!(experience.summary.ends_with('…'));
    // Nothing unmasked reached the store.
    let conn = env.store.connection();
    let leaked: i64 = conn
        .query_row(
            "SELECT count(*) FROM learning_experiences WHERE summary LIKE '%abcdef1234567890%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(leaked, 0);
}

#[test]
fn assessment_rules() {
    use Basis::{Unverified, UserConfirmed, VerifiedByExtalia};
    use Outcome::{Disputed, Failure, Success};
    let reason = |items: &[(Outcome, Basis)]| assess(items).reason;
    assert_eq!(
        reason(&[(Success, Unverified), (Success, Unverified)]),
        Some("no_verified_evidence")
    );
    assert_eq!(
        reason(&[(Success, VerifiedByExtalia)]),
        Some("too_few_verified")
    );
    assert_eq!(
        reason(&[(Success, VerifiedByExtalia), (Success, UserConfirmed)]),
        None
    );
    assert_eq!(
        reason(&[
            (Success, VerifiedByExtalia),
            (Success, UserConfirmed),
            (Disputed, Unverified)
        ]),
        Some("disputed_evidence")
    );
    assert_eq!(
        reason(&[
            (Success, VerifiedByExtalia),
            (Success, UserConfirmed),
            (Failure, VerifiedByExtalia),
            (Failure, UserConfirmed)
        ]),
        Some("contradicted")
    );
    assert_eq!(
        assess(&[
            (Success, VerifiedByExtalia),
            (Success, Unverified),
            (Success, UserConfirmed)
        ]),
        Assessment {
            verified: 2,
            samples: 3,
            reason: None
        }
    );
    assert_eq!(MIN_VERIFIED_EXPERIENCES, 2);
}

#[test]
fn observed_claims_alone_are_insufficient_evidence() {
    let mut env = Env::new();
    let mut ids = Vec::new();
    for n in 1..=3 {
        let (mission, t) = env.mission("work", n, &[TaskState::Completed], &["Build"], true);
        let mut learning = env.learning("work");
        learning
            .record_evidence(
                &evidence(
                    &mission,
                    &t[0],
                    EvidenceKind::ObservedClaim,
                    Claim::Success,
                    n,
                    "extalia:observer",
                ),
                now(),
            )
            .unwrap();
        ids.push(
            learning
                .capture_mission(&mission, now())
                .unwrap()
                .experiences[0]
                .id,
        );
    }
    let (vault, history) = env.vault("work");
    let mut learning = env.learning("work");
    let candidate = learning
        .propose_knowledge(&vault, &knowledge(&ids, None, "All tests pass."), now())
        .unwrap();
    assert_eq!(candidate.state, CandidateState::InsufficientEvidence);
    assert_eq!(candidate.reason.as_deref(), Some("no_verified_evidence"));
    assert_eq!((candidate.verified_count, candidate.sample_count), (0, 3));
    assert!(candidate.proposal.contains("verification: unverified"));
    assert_eq!(
        candidate.evidence_ids.len(),
        6,
        "observed claims and task results are cited"
    );
    assert!(matches!(
        learning.accept_knowledge(&decision(&candidate, USER), &vault, &history, now()),
        Err(LearningError::WrongState(
            CandidateState::InsufficientEvidence
        ))
    ));
    let skill_candidate = learning.propose_skill(&skill(&ids), now()).unwrap();
    assert_eq!(skill_candidate.state, CandidateState::InsufficientEvidence);
    assert!(matches!(
        learning.accept_skill(&decision(&skill_candidate, USER), now()),
        Err(LearningError::WrongState(
            CandidateState::InsufficientEvidence
        ))
    ));
    assert!(
        read_note(&vault, &candidate.target_ref).unwrap().is_none(),
        "nothing written"
    );
    assert!(!learning.skill_inbox().exists(), "nothing staged");
    // The user may still dismiss it.
    assert_eq!(
        learning.reject(&decision(&candidate, USER), now()).unwrap(),
        DecisionOutcome::Rejected
    );
    assert_eq!(
        learning.candidate(candidate.id).unwrap().state,
        CandidateState::Rejected
    );
}

#[test]
fn only_the_local_user_decides_and_must_cite_the_digest() {
    let mut env = Env::new();
    let ids = [
        env.verified_experience("work", 1),
        env.verified_experience("work", 2),
    ];
    let (vault, history) = env.vault("work");
    let mut learning = env.learning("work");
    let candidate = learning
        .propose_knowledge(&vault, &knowledge(&ids, None, "Order matters."), now())
        .unwrap();
    assert_eq!(candidate.state, CandidateState::Proposed);
    assert_eq!(candidate.proposed_by, "extalia:lead");
    for principal in [
        "extalia:learning",
        "extalia:lead",
        "agent:lead",
        "model:gpt",
        "policy:auto",
        "user:",
        "",
        "user:../x",
    ] {
        assert!(
            matches!(
                learning.accept_knowledge(
                    &decision(&candidate, principal),
                    &vault,
                    &history,
                    now()
                ),
                Err(LearningError::Denied("principal_not_user"))
            ),
            "{principal}"
        );
        assert!(matches!(
            learning.reject(&decision(&candidate, principal), now()),
            Err(LearningError::Denied("principal_not_user"))
        ));
    }
    let stale = DecisionRequest {
        proposal_digest: "0000000000000000000000000000000000000000000000000000000000000000",
        ..decision(&candidate, USER)
    };
    assert!(matches!(
        learning.accept_knowledge(&stale, &vault, &history, now()),
        Err(LearningError::Denied("proposal_digest_mismatch"))
    ));
    assert!(matches!(
        learning.accept_skill(&decision(&candidate, USER), now()),
        Err(LearningError::Denied("wrong_kind"))
    ));
    assert_eq!(
        learning.candidate(candidate.id).unwrap().state,
        CandidateState::Proposed
    );
    let noted = DecisionRequest {
        note: Some("Reviewed."),
        ..decision(&candidate, USER)
    };
    assert!(matches!(
        learning
            .accept_knowledge(&noted, &vault, &history, now())
            .unwrap(),
        DecisionOutcome::Written { .. }
    ));
    let decided = learning.candidate(candidate.id).unwrap();
    assert_eq!(decided.state, CandidateState::Accepted);
    assert_eq!(decided.decided_by.as_deref(), Some(USER));
    assert!(matches!(
        learning.reject(&decision(&candidate, USER), now()),
        Err(LearningError::WrongState(CandidateState::Accepted))
    ));
    let history_rows: Vec<_> = learning
        .decisions(candidate.id)
        .unwrap()
        .into_iter()
        .map(|d| (d.action, d.principal, d.note))
        .collect();
    assert_eq!(
        history_rows,
        [
            (DecisionAction::Propose, "extalia:lead".to_owned(), None),
            (
                DecisionAction::Accept,
                USER.to_owned(),
                Some("Reviewed.".to_owned())
            ),
        ]
    );
}

#[test]
fn accepting_knowledge_writes_only_managed_notes() {
    let mut env = Env::new();
    let ids = [
        env.verified_experience("work", 1),
        env.verified_experience("work", 2),
    ];
    let (vault, history) = env.vault("work");
    let root = env.dir.0.join("vaults").join("work");
    let mut learning = env.learning("work");

    // Folders outside the learning taxonomy are refused.
    for target in [
        "Skills/x.md",
        "Decisions/x.md",
        "x.md",
        "Projects/a/b.md",
        "Knowledge/../x.md",
    ] {
        assert!(
            matches!(
                learning.propose_knowledge(&vault, &knowledge(&ids, Some(target), "x"), now()),
                Err(LearningError::Denied(_))
            ),
            "{target}"
        );
    }

    // A new managed note: proposed without writing, written on accept.
    let fresh = learning
        .propose_knowledge(
            &vault,
            &knowledge(&ids, None, "Run migrations first."),
            now(),
        )
        .unwrap();
    assert_eq!(
        fresh.target_ref,
        "Knowledge/run-migrations-before-seeding.md"
    );
    assert_eq!(fresh.base_sha256, None);
    assert!(is_managed(&fresh.proposal));
    assert!(fresh.proposal.contains("verification: verified"));
    assert!(!root.join(&fresh.target_ref).exists());
    let written = learning
        .accept_knowledge(&decision(&fresh, USER), &vault, &history, now())
        .unwrap();
    assert_eq!(
        written,
        DecisionOutcome::Written {
            path: fresh.target_ref.clone(),
            sha256: fresh.proposal_digest.clone()
        }
    );
    assert_eq!(
        fs::read_to_string(root.join(&fresh.target_ref)).unwrap(),
        fresh.proposal
    );
    let journal = history.entries(&fresh.target_ref).unwrap();
    assert_eq!(journal.len(), 1);
    assert_eq!(journal[0].author, "extalia:learning");

    // A merge into that managed note keeps its text; a human edit after the proposal turns
    // the accept into a conflict copy and keeps the edit.
    let merge = learning
        .propose_knowledge(
            &vault,
            &knowledge(&ids, None, "Also clear the cache."),
            now(),
        )
        .unwrap();
    assert!(merge.proposal.starts_with(&fresh.proposal));
    assert_eq!(
        merge.base_sha256.as_deref(),
        Some(fresh.proposal_digest.as_str())
    );
    let edited = format!("{}\nMy own line.\n", fresh.proposal);
    fs::write(root.join(&fresh.target_ref), &edited).unwrap();
    let DecisionOutcome::Conflict {
        conflict_path,
        reason,
    } = learning
        .accept_knowledge(&decision(&merge, USER), &vault, &history, now())
        .unwrap()
    else {
        panic!("expected a conflict");
    };
    assert_eq!(reason, ConflictReason::HashMismatch);
    assert_eq!(
        fs::read_to_string(root.join(&fresh.target_ref)).unwrap(),
        edited
    );
    assert!(root.join(&conflict_path).exists());
    assert_eq!(
        learning.candidate(merge.id).unwrap().state,
        CandidateState::Proposed
    );

    // A user note is never replaced: the accept leaves a conflict copy next to it.
    fs::write(root.join("Knowledge/Mine.md"), "# Mine\nUser text.\n").unwrap();
    let user = learning
        .propose_knowledge(
            &vault,
            &knowledge(&ids, Some("Knowledge/Mine.md"), "Use it."),
            now(),
        )
        .unwrap();
    assert_eq!(user.base_sha256, Some(hex_digest(b"# Mine\nUser text.\n")));
    assert!(is_managed(&user.proposal), "a standalone managed proposal");
    let DecisionOutcome::Conflict {
        conflict_path,
        reason,
    } = learning
        .accept_knowledge(&decision(&user, USER), &vault, &history, now())
        .unwrap()
    else {
        panic!("expected a conflict");
    };
    assert_eq!(reason, ConflictReason::NotManaged);
    assert_eq!(
        fs::read_to_string(root.join("Knowledge/Mine.md")).unwrap(),
        "# Mine\nUser text.\n"
    );
    let copy = fs::read_to_string(root.join(&conflict_path)).unwrap();
    assert!(
        !is_managed(&copy),
        "a conflict copy never becomes auto-updatable"
    );
    let actions: Vec<_> = learning
        .decisions(user.id)
        .unwrap()
        .into_iter()
        .map(|d| (d.action, d.to_state, d.outcome_ref))
        .collect();
    assert_eq!(
        actions,
        [
            (DecisionAction::Propose, CandidateState::Proposed, None),
            (
                DecisionAction::Conflict,
                CandidateState::Proposed,
                Some(conflict_path)
            ),
        ]
    );
}

#[test]
fn proposals_supersede_and_repeat_idempotently() {
    let mut env = Env::new();
    let ids = [
        env.verified_experience("work", 1),
        env.verified_experience("work", 2),
    ];
    let (vault, _) = env.vault("work");
    let mut learning = env.learning("work");
    let first = learning
        .propose_knowledge(&vault, &knowledge(&ids, None, "One."), now())
        .unwrap();
    let repeat = learning
        .propose_knowledge(&vault, &knowledge(&ids, None, "One."), now())
        .unwrap();
    assert_eq!(repeat.id, first.id);
    let second = learning
        .propose_knowledge(&vault, &knowledge(&ids, None, "Two."), now())
        .unwrap();
    assert_ne!(second.id, first.id);
    let old = learning.candidate(first.id).unwrap();
    assert_eq!(old.state, CandidateState::Superseded);
    assert_eq!(old.decided_by, None);
    let actions: Vec<_> = learning
        .decisions(first.id)
        .unwrap()
        .into_iter()
        .map(|d| (d.action, d.principal))
        .collect();
    assert_eq!(
        actions,
        [
            (DecisionAction::Propose, "extalia:lead".to_owned()),
            (DecisionAction::Supersede, LEARNING_PRINCIPAL.to_owned()),
        ]
    );
    assert_eq!(
        learning
            .candidates(Some(CandidateState::Proposed))
            .unwrap()
            .iter()
            .map(|c| c.id)
            .collect::<Vec<_>>(),
        [second.id]
    );
}

#[test]
fn contradicting_evidence_revalidates_before_an_accept() {
    let mut env = Env::new();
    let ids = [
        env.verified_experience("work", 1),
        env.verified_experience("work", 2),
    ];
    let (vault, history) = env.vault("work");
    let mut learning = env.learning("work");
    let candidate = learning
        .propose_knowledge(&vault, &knowledge(&ids, None, "Order matters."), now())
        .unwrap();
    assert_eq!(candidate.state, CandidateState::Proposed);
    // The user later says the first run actually failed: verified evidence disagrees.
    let experience = learning.experiences(&uuid(0x1001)).unwrap().remove(0);
    learning
        .record_evidence(
            &evidence(
                &experience.mission_id,
                &experience.task_id,
                EvidenceKind::UserConfirmation,
                Claim::Failure,
                77,
                USER,
            ),
            now(),
        )
        .unwrap();
    assert_eq!(
        learning
            .accept_knowledge(&decision(&candidate, USER), &vault, &history, now())
            .unwrap(),
        DecisionOutcome::Revalidated {
            reason: "disputed_evidence"
        }
    );
    let stored = learning.candidate(candidate.id).unwrap();
    assert_eq!(stored.state, CandidateState::InsufficientEvidence);
    assert_eq!(stored.reason.as_deref(), Some("disputed_evidence"));
    assert!(
        read_note(&vault, &candidate.target_ref).unwrap().is_none(),
        "nothing written"
    );
    // The experience row itself is the immutable snapshot taken at capture.
    assert_eq!(
        learning.experiences(&uuid(0x1001)).unwrap()[0].basis,
        Basis::VerifiedByExtalia
    );
}

#[test]
fn skill_candidates_only_reach_the_inbox_and_never_the_skill_tables() {
    let mut env = Env::new();
    let ids = [
        env.verified_experience("work", 1),
        env.verified_experience("work", 2),
    ];
    let before = env.skill_rows();
    let mut learning = env.learning("work");
    for bad in ["Bad Name", "", "../x"] {
        assert!(matches!(
            learning.propose_skill(
                &SkillProposal {
                    name: bad,
                    ..skill(&ids)
                },
                now()
            ),
            Err(LearningError::Denied("invalid_skill_name"))
        ));
    }
    let candidate = learning.propose_skill(&skill(&ids), now()).unwrap();
    assert_eq!(candidate.state, CandidateState::Proposed);
    assert_eq!(candidate.target_ref, "seed-after-migrate");
    let staging = candidate.staging_ref.clone().unwrap();
    assert_eq!(
        staging,
        format!(
            "skill-inbox/seed-after-migrate-{}",
            &candidate.proposal_digest[..12]
        )
    );
    assert!(
        !learning.skill_inbox().exists(),
        "a proposal writes nothing"
    );
    let DecisionOutcome::Staged {
        package_dir,
        staging_ref,
    } = learning
        .accept_skill(&decision(&candidate, USER), now())
        .unwrap()
    else {
        panic!("expected a staged package");
    };
    assert_eq!(staging_ref, staging);
    let names: Vec<_> = fs::read_dir(&package_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(
        names,
        ["SKILL.md"],
        "no manifest, so no declared permissions"
    );
    assert_eq!(
        fs::read_to_string(package_dir.join("SKILL.md")).unwrap(),
        candidate.proposal
    );
    assert_eq!(
        learning.candidate(candidate.id).unwrap().state,
        CandidateState::Accepted
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&package_dir), 0o700);
        assert_eq!(mode(&package_dir.join("SKILL.md")), 0o600);
    }
    assert_eq!(
        env.skill_rows(),
        before,
        "learning never writes skill tables"
    );

    // The normal W3 flow takes it from there: quarantined, never active.
    let data = env.data();
    let mut registry = SkillRegistry::new(&mut env.store, &data, profile("work"));
    let receipt = registry
        .import(&package_dir, Origin::Generated, "learning:1", now())
        .unwrap();
    assert_eq!(receipt.state, RevisionState::Quarantined);
    assert!(registry.active("seed-after-migrate").unwrap().is_none());
}

#[test]
fn a_foreign_file_in_the_inbox_refuses_the_stage() {
    let mut env = Env::new();
    let ids = [
        env.verified_experience("work", 1),
        env.verified_experience("work", 2),
    ];
    let mut learning = env.learning("work");
    let candidate = learning.propose_skill(&skill(&ids), now()).unwrap();
    let dir = learning
        .skill_inbox()
        .parent()
        .unwrap()
        .join(candidate.staging_ref.as_deref().unwrap());
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("run.sh"), "#!/bin/sh\n").unwrap();
    assert!(matches!(
        learning.accept_skill(&decision(&candidate, USER), now()),
        Err(LearningError::Denied("inbox_occupied"))
    ));
    assert_eq!(
        learning.candidate(candidate.id).unwrap().state,
        CandidateState::Proposed
    );
}

#[test]
fn profiles_are_isolated() {
    let mut env = Env::new();
    let ids = [
        env.verified_experience("work", 1),
        env.verified_experience("work", 2),
    ];
    let (mission, t) = env.mission("work", 3, &[TaskState::Completed], &["Build"], true);
    let (vault, _) = env.vault("work");
    let (home_vault, home_history) = env.vault("home");
    let candidate = env
        .learning("work")
        .propose_knowledge(&vault, &knowledge(&ids, None, "Work only."), now())
        .unwrap();
    let mut home = env.learning("home");
    assert!(matches!(
        home.capture_mission(&mission, now()),
        Err(LearningError::NotFound)
    ));
    assert!(matches!(
        home.record_evidence(&gate(&mission, &t[0], Claim::Success, 9), now()),
        Err(LearningError::NotFound)
    ));
    assert!(home.experiences(&uuid(0x1001)).unwrap().is_empty());
    assert!(home.evidence(&t[0]).unwrap().is_empty());
    assert!(matches!(
        home.propose_knowledge(&home_vault, &knowledge(&ids, None, "Leak."), now()),
        Err(LearningError::NotFound)
    ));
    assert!(matches!(
        home.propose_skill(&skill(&ids), now()),
        Err(LearningError::NotFound)
    ));
    assert!(matches!(
        home.candidate(candidate.id),
        Err(LearningError::NotFound)
    ));
    assert!(matches!(
        home.decisions(candidate.id),
        Err(LearningError::NotFound)
    ));
    assert!(home.candidates(None).unwrap().is_empty());
    assert!(matches!(
        home.reject(&decision(&candidate, USER), now()),
        Err(LearningError::NotFound)
    ));
    // Another profile's vault or history is refused outright.
    assert!(matches!(
        home.propose_knowledge(&vault, &knowledge(&[1], None, "x"), now()),
        Err(LearningError::WrongProfile)
    ));
    let mut work = env.learning("work");
    assert!(matches!(
        work.accept_knowledge(
            &decision(&candidate, USER),
            &home_vault,
            &home_history,
            now()
        ),
        Err(LearningError::WrongProfile)
    ));
    assert!(matches!(
        work.accept_knowledge(&decision(&candidate, USER), &vault, &home_history, now()),
        Err(LearningError::WrongProfile)
    ));
    assert_eq!(
        work.candidate(candidate.id).unwrap().state,
        CandidateState::Proposed
    );
}

#[test]
fn the_schema_keeps_history_append_only_and_decisions_with_users() {
    let mut env = Env::new();
    let ids = [
        env.verified_experience("work", 1),
        env.verified_experience("work", 2),
    ];
    let candidate = env
        .learning("work")
        .propose_skill(&skill(&ids), now())
        .unwrap();
    let conn = env.store.connection();
    for sql in [
        "UPDATE learning_experiences SET summary = 'x'",
        "DELETE FROM learning_experiences",
        "UPDATE learning_evidence SET trust_status = 'verified'",
        "DELETE FROM learning_evidence",
        "DELETE FROM learning_experience_evidence",
        "DELETE FROM learning_candidate_experiences",
        "DELETE FROM learning_candidate_evidence",
        "UPDATE learning_candidate_decisions SET principal = 'user:x'",
        "DELETE FROM learning_candidate_decisions",
        "DELETE FROM learning_candidates",
        "UPDATE learning_candidates SET proposal = 'x'",
        "UPDATE learning_candidates SET rationale = 'x'",
        // A state change without its decision record.
        "UPDATE learning_candidates SET state = 'accepted', decided_at = 't', decided_by = 'user:local'",
        "UPDATE learning_candidates SET state = 'rejected', decided_at = 't', decided_by = 'user:local'",
        // Agents and Extalia cannot decide.
        "UPDATE learning_candidates SET state = 'accepted', decided_at = 't', decided_by = 'extalia:lead'",
    ] {
        assert!(conn.execute(sql, []).is_err(), "{sql}");
    }
    let id = candidate.id;
    let digest = &candidate.proposal_digest;
    let insert = |action: &str, principal: &str, from: &str, to: &str, digest: &str| {
        conn.execute(
            "INSERT INTO learning_candidate_decisions (profile_id, candidate_id, action, from_state,
               to_state, principal, proposal_digest, at) VALUES ('work', ?1, ?2, ?3, ?4, ?5, ?6, 't')",
            rusqlite::params![id, action, from, to, principal, digest],
        )
    };
    assert!(insert("accept", "extalia:lead", "proposed", "accepted", digest).is_err());
    assert!(insert("accept", "agent:x", "proposed", "accepted", digest).is_err());
    assert!(insert("supersede", "user:local", "proposed", "superseded", digest).is_err());
    assert!(
        insert(
            "accept",
            "user:local",
            "proposed",
            "accepted",
            &"0".repeat(64)
        )
        .is_err()
    );
    assert!(
        insert(
            "accept",
            "user:local",
            "insufficient_evidence",
            "accepted",
            digest
        )
        .is_err()
    );
    // Evidence trust is fixed by its kind.
    let task = uuid(0x2000 + 16);
    let mission = uuid(0x1001);
    for (kind, trust, by) in [
        ("observed_claim", "verified", "extalia:observer"),
        ("task_result", "verified", "extalia:learning"),
        ("user_confirmation", "verified", "extalia:lead"),
        ("test_gate", "verified", "user:local"),
    ] {
        assert!(
            conn.execute(
                "INSERT INTO learning_evidence (profile_id, mission_id, task_id, kind, claim,
                   trust_status, digest, ref, masked_count, recorded_by, observed_at)
                 VALUES ('work', ?1, ?2, ?3, 'success', ?4, ?5, 'r', 0, ?6, 't')",
                rusqlite::params![mission, task, kind, trust, "1".repeat(64), by],
            )
            .is_err(),
            "{kind}"
        );
    }
    // Cross-profile references are impossible.
    assert!(
        conn.execute(
            "INSERT INTO learning_candidate_experiences (profile_id, candidate_id, experience_id)
             VALUES ('home', ?1, ?2)",
            rusqlite::params![id, ids[0]],
        )
        .is_err()
    );
}
