//! Live expiry is execution uncertainty, never proof of physical settlement.
//! Reaping quarantines a bounded batch atomically, with no synthetic journal activity.

use rusqlite::{TransactionBehavior, params};

use super::CoreStore;
use super::mission_snapshot::snapshot_in_transaction;
use super::missions::{
    RecoveryReport, finish, later, load_mission, load_task, save_mission, save_task,
};
use crate::mission::{MAX_REAP_MISSIONS_PER_TICK, MissionError, MissionState, TaskState};
use crate::time::{format_utc, parse_utc};

const fn corrupt() -> MissionError {
    MissionError::Corrupt("live reaper invariants")
}

impl CoreStore {
    /// Quarantine at most 16 missions with genuinely expired leases in this profile.
    /// Every in-flight sibling becomes unknown and loses its lease; queued and
    /// terminal task payloads stay unchanged. An affected mission's version advances
    /// once even if it was already recovering. No event, retry or result is created.
    ///
    /// `expired_leases` counts expired leases cleared; `orphaned_leases` counts the
    /// other, unexpired sibling leases cleared due the same mission uncertainty.
    /// Any invalid selected record or write failure rolls back the complete batch.
    pub fn reap_expired_leases(
        &mut self,
        profile: &str,
        now: i64,
    ) -> Result<RecoveryReport, MissionError> {
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now_text = format_utc(now);
        if parse_utc(&now_text) != Some(now) {
            return Err(MissionError::Invalid("invalid reaper time"));
        }
        // SQLite chooses a bounded candidate batch, including unparseable timestamps
        // so corruption is refused. Its date comparison is only a prefilter: every
        // selected timestamp is independently parsed and compared as integer UTC ms.
        let candidates = tx.prepare(
            "SELECT t.mission_id FROM leases l LEFT JOIN tasks t ON t.profile_id = l.profile_id AND t.task_id = l.task_id
             WHERE l.profile_id = ?1 AND (julianday(l.expires_at) IS NULL OR julianday(l.expires_at) <= julianday(?2))
             GROUP BY t.mission_id ORDER BY min(l.expires_at), t.mission_id LIMIT ?3"
        )?.query_map(params![profile, now_text, MAX_REAP_MISSIONS_PER_TICK as i64], |row| row.get::<_, Option<String>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut prepared = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let mission_id = candidate.ok_or_else(corrupt)?;
            let snapshot =
                snapshot_in_transaction(&tx, profile, &mission_id).map_err(
                    |error| match error {
                        MissionError::NotFound | MissionError::Invalid(_) => corrupt(),
                        other => other,
                    },
                )?;
            if snapshot.state.terminal() {
                return Err(corrupt());
            }
            let mut expired = 0;
            let mut orphaned = 0;
            for lease in &snapshot.leases {
                let acquired = parse_utc(&lease.acquired_at).ok_or_else(corrupt)?;
                let expires = parse_utc(&lease.expires_at).ok_or_else(corrupt)?;
                if expires <= acquired {
                    return Err(corrupt());
                }
                if expires <= now {
                    expired += 1;
                } else {
                    orphaned += 1;
                }
            }
            if expired == 0 {
                continue;
            }
            let mut mission = load_mission(&tx, profile, &mission_id)?;
            mission.state = MissionState::Recovering;
            mission.version = mission
                .version
                .checked_add(1)
                .filter(|version| *version < (1 << 53))
                .ok_or(MissionError::Capacity("mission version"))?;
            mission.updated_at = later(now, &mission.updated_at);
            let tasks = snapshot
                .tasks
                .iter()
                .filter(|task| task.state.in_flight())
                .map(|task| load_task(&tx, profile, &mission_id, &task.task_id))
                .collect::<Result<Vec<_>, _>>()?;
            if tasks.is_empty() {
                return Err(corrupt());
            }
            prepared.push((mission, tasks, expired, orphaned, snapshot.leases.len()));
        }
        let mut report = RecoveryReport::default();
        for (mission, tasks, expired, orphaned, lease_count) in prepared {
            for mut task in tasks {
                task.state = TaskState::Unknown;
                task.lease_id = None;
                save_task(&tx, profile, &task, &now_text)?;
                report.tasks += 1;
            }
            let deleted = tx.execute(
                "DELETE FROM leases WHERE profile_id = ?1 AND task_id IN (SELECT task_id FROM tasks WHERE profile_id = ?1 AND mission_id = ?2)",
                params![profile, mission.id],
            )?;
            if deleted != lease_count {
                return Err(corrupt());
            }
            save_mission(&tx, profile, &mission)?;
            report.missions += 1;
            report.expired_leases += expired;
            report.orphaned_leases += orphaned;
        }
        finish(tx, inject)?;
        Ok(report)
    }
}
