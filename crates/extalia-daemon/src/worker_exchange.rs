//! Pure health exchange for one byte stream. Caller time is a claim; production use
//! still needs an independent watchdog and process supervision/settlement evidence.

use crate::worker_protocol::{ErrorCode, Frame, valid_version};

pub const MAX_ISSUED_REQUESTS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    AwaitingHello,
    Ready,
    Pending,
    Retired,
}

/// Fixed local diagnostic codes; no worker text or physical-settlement claims.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseReason {
    InvalidConfiguration,
    InvalidFrame,
    ProtocolViolation,
    VersionMismatch,
    CorrelationMismatch,
    DeadlineExpired,
    ClockRegression,
    ClockOverflow,
    RequestIdReused,
    RequestLimit,
    FramingFailed,
    Eof,
    Retired,
}

/// Data accepted from a worker, never permission or proof of stopped execution.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notice {
    Hello,
    Response,
    Error { code: ErrorCode },
}

pub struct Exchange {
    expected_version: String,
    phase: Phase,
    last_now: u64,
    expires_at: Option<u64>,
    pending_id: Option<String>,
    issued_ids: Vec<String>,
}

impl Exchange {
    pub fn new(
        expected_version: &str,
        now_ms: u64,
        handshake_timeout_ms: u64,
    ) -> Result<Self, CloseReason> {
        if !valid_version(expected_version)
            || !(1..=crate::worker_protocol::MAX_DEADLINE_MS).contains(&handshake_timeout_ms)
        {
            return Err(CloseReason::InvalidConfiguration);
        }
        let expires_at = now_ms
            .checked_add(handshake_timeout_ms)
            .ok_or(CloseReason::ClockOverflow)?;
        Ok(Self {
            expected_version: expected_version.to_owned(),
            phase: Phase::AwaitingHello,
            last_now: now_ms,
            expires_at: Some(expires_at),
            pending_id: None,
            issued_ids: Vec::new(),
        })
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn physical_settlement_verified(&self) -> bool {
        false
    }

    fn retire(&mut self, reason: CloseReason) -> CloseReason {
        self.phase = Phase::Retired;
        self.expires_at = None;
        self.pending_id = None;
        reason
    }

    pub fn tick(&mut self, now: u64) -> Result<(), CloseReason> {
        if self.phase == Phase::Retired {
            return Err(CloseReason::Retired);
        }
        if now < self.last_now {
            return Err(self.retire(CloseReason::ClockRegression));
        }
        self.last_now = now;
        if self.expires_at.is_some_and(|deadline| now >= deadline) {
            return Err(self.retire(CloseReason::DeadlineExpired));
        }
        Ok(())
    }

    pub fn receive(&mut self, frame: Frame, now: u64) -> Result<Notice, CloseReason> {
        self.tick(now)?;
        if !frame.valid() {
            return Err(self.retire(CloseReason::InvalidFrame));
        }
        match (self.phase, frame) {
            (Phase::AwaitingHello, Frame::Hello { worker_version }) => {
                if worker_version != self.expected_version {
                    return Err(self.retire(CloseReason::VersionMismatch));
                }
                self.phase = Phase::Ready;
                self.expires_at = None;
                Ok(Notice::Hello)
            }
            (
                Phase::Pending,
                Frame::Response {
                    request_id,
                    worker_version,
                },
            ) => {
                if self.pending_id.as_deref() != Some(request_id.as_str()) {
                    return Err(self.retire(CloseReason::CorrelationMismatch));
                }
                if worker_version != self.expected_version {
                    return Err(self.retire(CloseReason::VersionMismatch));
                }
                self.complete();
                Ok(Notice::Response)
            }
            (Phase::Pending, Frame::Error { request_id, code }) => {
                if self.pending_id.as_deref() != Some(request_id.as_str()) {
                    return Err(self.retire(CloseReason::CorrelationMismatch));
                }
                // Error data, including an unsolicited cancelled claim, never
                // restores protocol admission or proves physical settlement.
                self.retire(CloseReason::Retired);
                Ok(Notice::Error { code })
            }
            _ => Err(self.retire(CloseReason::ProtocolViolation)),
        }
    }

    fn complete(&mut self) {
        self.phase = Phase::Ready;
        self.pending_id = None;
        self.expires_at = None;
    }

    /// Admit one health request with a relative duration; equality expires first.
    /// All 64 lifetime IDs remain reserved, including completed requests.
    pub fn request(&mut self, id: &str, deadline_ms: u64, now: u64) -> Result<Frame, CloseReason> {
        self.tick(now)?;
        if self.phase != Phase::Ready {
            return Err(self.retire(CloseReason::ProtocolViolation));
        }
        // Validate before allocating from caller strings.
        if !crate::worker_protocol::valid_request_id(id)
            || !(1..=crate::worker_protocol::MAX_DEADLINE_MS).contains(&deadline_ms)
        {
            return Err(self.retire(CloseReason::InvalidFrame));
        }
        if self.issued_ids.iter().any(|previous| previous == id) {
            return Err(self.retire(CloseReason::RequestIdReused));
        }
        if self.issued_ids.len() == MAX_ISSUED_REQUESTS {
            return Err(self.retire(CloseReason::RequestLimit));
        }
        let expires_at = now
            .checked_add(deadline_ms)
            .ok_or_else(|| self.retire(CloseReason::ClockOverflow))?;
        let request_id = id.to_owned();
        self.issued_ids.push(request_id.clone());
        self.pending_id = Some(request_id.clone());
        self.expires_at = Some(expires_at);
        self.phase = Phase::Pending;
        Ok(Frame::Request {
            request_id,
            deadline_ms,
        })
    }

    /// Return cancellation data and retire immediately, without claiming a stop.
    pub fn cancel(&mut self, now: u64) -> Result<Frame, CloseReason> {
        self.tick(now)?;
        if self.phase != Phase::Pending {
            return Err(self.retire(CloseReason::ProtocolViolation));
        }
        let request_id = self
            .pending_id
            .take()
            .expect("pending phase has request identity");
        self.retire(CloseReason::Retired);
        Ok(Frame::Cancel { request_id })
    }

    pub fn framing_failed(&mut self) {
        self.retire(CloseReason::FramingFailed);
    }

    pub fn eof(&mut self) {
        self.retire(CloseReason::Eof);
    }
}
