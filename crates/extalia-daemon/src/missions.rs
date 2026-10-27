//! Slice A dispatch: the daemon instance's profile and core store (ADR 0019, ADR 0024).
//! The profile is fixed when the daemon starts; the wire carries no profile ID, so a host
//! can only reach the profile its daemon was started for.

use extalia_core::CoreStore;
use extalia_core::mission::MissionError;
use extalia_core::time::now_millis;

use crate::wire::{ErrorCode, Op, RequestParams, ResponseResult};

/// Operations served when a core store is open, advertised in the `hello` result.
pub const CAPABILITIES: [Op; 4] = [
    Op::MissionCreate,
    Op::MissionSnapshot,
    Op::TaskTransition,
    Op::EventCommit,
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
}

impl Missions {
    /// `profile` must satisfy [`is_profile_id`].
    pub fn new(store: CoreStore, profile: String) -> Self {
        assert!(is_profile_id(&profile), "invalid profile ID");
        Self { store, profile }
    }

    pub fn into_store(self) -> CoreStore {
        self.store
    }

    /// The open store, shared with the skill registry of the same profile.
    pub fn store_mut(&mut self) -> &mut CoreStore {
        &mut self.store
    }

    /// Run one slice A request. Failures write nothing; their reason goes to stderr only.
    pub fn handle(&mut self, params: &RequestParams) -> Result<ResponseResult, ErrorCode> {
        let profile = self.profile.as_str();
        let now = now_millis();
        let outcome = match params {
            RequestParams::MissionCreate(create) => self
                .store
                .create_mission(profile, create, now)
                .map(ResponseResult::MissionCreate),
            RequestParams::MissionSnapshot { mission_id } => self
                .store
                .mission_snapshot(profile, mission_id)
                .map(ResponseResult::MissionSnapshot),
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
