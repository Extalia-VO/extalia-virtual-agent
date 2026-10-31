//! Slice A dispatch: the daemon instance's profile and core store (ADR 0019, ADR 0024).
//! The profile is fixed when the daemon starts; the wire carries no profile ID, so a host
//! can only reach the profile its daemon was started for.

use extalia_core::CoreStore;
use extalia_core::adapters::sqlite::missions::RecoveryReport;
use extalia_core::mission::MissionError;
use extalia_core::time::now_millis;

use crate::wire::{ErrorCode, Op, RequestParams, ResponseResult};

/// Operations served when a core store is open, advertised in the `hello` result.
pub const CAPABILITIES: [Op; 12] = [
    Op::MissionCreate,
    Op::MissionSnapshot,
    Op::MissionExecutions,
    Op::MissionRecoveryReview,
    Op::ExecutionObserve,
    Op::ExecutionRecordLocalDrain,
    Op::MissionHeartbeat,
    Op::TaskTransition,
    Op::EventCommit,
    Op::PlanningBegin,
    Op::PlanningObserve,
    Op::PlanningInspect,
];
/// Profile of a daemon started without `--profile` (ADR 0024).
pub const DEFAULT_PROFILE: &str = "default";

/// `^[a-z0-9][a-z0-9-]{0,63}$` (ADR 0024).
pub fn is_profile_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..]
            .iter()
            .all(|&byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// The open store of one profile.
#[derive(Debug)]
pub struct Missions {
    store: CoreStore,
    profile: String,
    failed: bool,
}

impl Missions {
    /// `profile` must satisfy [`is_profile_id`].
    pub fn new(store: CoreStore, profile: String) -> Self {
        assert!(is_profile_id(&profile), "invalid profile ID");
        Self {
            store,
            profile,
            failed: false,
        }
    }

    pub fn into_store(self) -> CoreStore {
        self.store
    }

    /// The open store, shared with the skill registry of the same profile.
    pub(crate) fn store_mut(&mut self) -> &mut CoreStore {
        &mut self.store
    }

    /// A failed reaper permanently fences this connection's mutations.
    pub fn available(&self) -> bool {
        !self.failed
    }

    pub(crate) fn fail(&mut self) {
        self.failed = true;
    }

    /// Independent of request traffic; the core bounds each atomic tick.
    pub fn reap_expired(&mut self, now: i64) -> Result<RecoveryReport, ErrorCode> {
        if self.failed {
            return Err(ErrorCode::StorageFailure);
        }
        self.store
            .reap_expired_leases(&self.profile, now)
            .map_err(|error| {
                self.failed = true;
                eprintln!(
                    "extalia-daemon: lease reaper failed ({error}); mission execution fenced"
                );
                ErrorCode::StorageFailure
            })
    }

    /// Run one slice A request. Failures write nothing; their reason goes to stderr only.
    pub fn handle(&mut self, params: &RequestParams) -> Result<ResponseResult, ErrorCode> {
        if self.failed
            && !matches!(
                params,
                RequestParams::MissionSnapshot { .. }
                    | RequestParams::PlanningInspect { .. }
                    | RequestParams::MissionExecutions { .. }
                    | RequestParams::MissionRecoveryReview { .. }
            )
        {
            return Err(ErrorCode::StorageFailure);
        }
        let profile = self.profile.as_str();
        let now = now_millis();
        let outcome = match params {
            RequestParams::PlanningBegin(begin) => self
                .store
                .begin_planning(profile, begin, now)
                .map(ResponseResult::PlanningBegin),
            RequestParams::PlanningObserve(observation) => self
                .store
                .observe_planning(profile, observation, now)
                .map(ResponseResult::PlanningObserve),
            RequestParams::PlanningInspect { invocation_id } => self
                .store
                .inspect_planning(profile, invocation_id)
                .map(ResponseResult::PlanningInspect),
            RequestParams::MissionCreate(create) => self
                .store
                .create_mission(profile, create, now)
                .map(ResponseResult::MissionCreate),
            RequestParams::MissionSnapshot { mission_id } => self
                .store
                .mission_snapshot(profile, mission_id)
                .map(ResponseResult::MissionSnapshot),
            RequestParams::MissionRecoveryReview { mission_id } => self
                .store
                .mission_recovery_review(profile, mission_id)
                .map(ResponseResult::MissionRecoveryReview),
            RequestParams::MissionExecutions { mission_id } => self
                .store
                .list_mission_executions(profile, mission_id)
                .map(ResponseResult::MissionExecutions),
            RequestParams::ExecutionObserve(observation) => self
                .store
                .observe_execution(profile, observation, now)
                .map(ResponseResult::ExecutionObserve),
            RequestParams::ExecutionRecordLocalDrain(drain) => self
                .store
                .record_local_drain(profile, drain, now)
                .map(ResponseResult::ExecutionRecordLocalDrain),
            RequestParams::MissionHeartbeat(heartbeat) => self
                .store
                .heartbeat_mission(profile, heartbeat, now)
                .map(ResponseResult::MissionHeartbeat),
            RequestParams::TaskTransition(transition) => self
                .store
                .transition_task(profile, transition, now)
                .map(ResponseResult::TaskTransition),
            RequestParams::EventCommit(event) => self
                .store
                .commit_event(profile, event, now)
                .map(ResponseResult::EventCommit),
            _ => return Err(ErrorCode::Internal),
        };
        outcome.map_err(|error| {
            eprintln!("extalia-daemon: {} refused ({error})", params.op().as_str());
            code(&error)
        })
    }
}

/// Stable wire code of a store failure (`DAEMON_ERROR_CODES`).
pub fn code(error: &MissionError) -> ErrorCode {
    match error {
        MissionError::Invalid(_) => ErrorCode::InvalidRequest,
        MissionError::NotFound => ErrorCode::NotFound,
        MissionError::Conflict(_) => ErrorCode::Conflict,
        MissionError::Capacity(_) => ErrorCode::CapacityExceeded,
        MissionError::Storage(_) | MissionError::Corrupt(_) => ErrorCode::StorageFailure,
    }
}
