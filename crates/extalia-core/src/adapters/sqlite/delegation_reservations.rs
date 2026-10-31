//! Provisional hierarchical escrow, deliberately absent from daemon/RPC/runtime routes.
//! Caller-supplied seeds are bookkeeping inputs, never verified grants or dispatch authority.
use super::CoreStore;
use crate::control::delegation::{
    compare_delegation_replay, inspect_delegation_extension, validate_delegation_envelope,
};
use crate::mission::{canonical, contract::is_uuid};
use crate::time::parse_utc;
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fmt;

const MAX: i64 = 9_007_199_254_740_991;
const FIELDS: [&str; 4] = [
    "maxWallClockMs",
    "maxTokens",
    "maxToolCalls",
    "maxEstimatedCostMicrousd",
];
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationReservationScope {
    pub profile_id: String,
    pub workspace_id: String,
    pub root_mission_id: String,
    pub root_run_id: String,
}
impl DelegationReservationScope {
    fn valid(&self) -> bool {
        [
            &self.profile_id,
            &self.workspace_id,
            &self.root_mission_id,
            &self.root_run_id,
        ]
        .iter()
        .all(|value| is_uuid(value))
    }
    fn matches(&self, value: &Value) -> bool {
        value["profileId"] == self.profile_id
            && value["workspaceId"] == self.workspace_id
            && value["rootMissionId"] == self.root_mission_id
            && value["rootRunId"] == self.root_run_id
    }
}
#[derive(Debug)]
pub enum DelegationLedgerError {
    Invalid,
    NotFound,
    Conflict,
    Inactive,
    Revoked,
    Exhausted,
    Corrupt,
    Storage(rusqlite::Error),
}
impl fmt::Display for DelegationLedgerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid => "invalid provisional delegation input",
            Self::NotFound => "provisional delegation scope or branch not found",
            Self::Conflict => "provisional delegation version or intent differs",
            Self::Inactive => "provisional delegation clock or window is inactive",
            Self::Revoked => "provisional delegation pool is revoked",
            Self::Exhausted => "provisional delegation allocation is exhausted",
            Self::Corrupt => "provisional delegation ledger invariants failed",
            Self::Storage(_) => "provisional delegation storage failed",
        })
    }
}
impl std::error::Error for DelegationLedgerError {}
impl From<rusqlite::Error> for DelegationLedgerError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Storage(value)
    }
}
type Result<T> = std::result::Result<T, DelegationLedgerError>;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationReservationAck {
    pub pool_id: String,
    pub branch_id: String,
    pub recorded_at: String,
    pub pool_version: u64,
    pub duplicate: bool,
    pub authority_verified: bool,
    pub dispatch_eligible: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationBranchBalance {
    pub branch_id: String,
    pub parent_branch_id: Option<String>,
    pub remaining_descendants: u64,
    pub remaining_budget: Value,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationPoolSnapshot {
    pub pool_id: String,
    pub state_version: u64,
    pub revoked: bool,
    pub observed_ms: i64,
    pub branches: Vec<DelegationBranchBalance>,
    pub authority_verified: bool,
    pub dispatch_eligible: bool,
}
struct Branch {
    parent: Option<String>,
    envelope: Value,
    payload: String,
    slots: i64,
    budget: [i64; 4],
}
struct Receipt {
    parent: String,
    branch: String,
    recorded_at: String,
    version: i64,
}
struct Pool {
    id: String,
    version: i64,
    revoked: bool,
    observed: i64,
    initialized: String,
    seed: Value,
    seed_payload: String,
    branches: BTreeMap<String, Branch>,
    receipts: HashMap<String, Receipt>,
}
fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}
fn integer(value: &Value) -> i64 {
    value.as_i64().unwrap_or_default()
}
fn budget(value: &Value) -> [i64; 4] {
    FIELDS.map(|key| integer(&value["budget"][key]))
}
fn normalized(value: &Value) -> Result<(Value, String)> {
    validate_delegation_envelope(value).map_err(|_| DelegationLedgerError::Invalid)?;
    let payload = canonical::to_string(value);
    if payload.len() > 16_384 {
        return Err(DelegationLedgerError::Invalid);
    }
    let normalized = serde_json::from_str(&payload).map_err(|_| DelegationLedgerError::Invalid)?;
    Ok((normalized, payload))
}
fn stored(payload: &str, digest: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(payload).map_err(|_| DelegationLedgerError::Corrupt)?;
    let (value, normalized) = normalized(&value).map_err(|_| DelegationLedgerError::Corrupt)?;
    if normalized != payload || canonical::digest(&value) != digest {
        return Err(DelegationLedgerError::Corrupt);
    }
    Ok(value)
}
fn finish(tx: Transaction<'_>, inject: bool) -> Result<()> {
    if inject {
        return Err(DelegationLedgerError::Storage(
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR),
                None,
            ),
        ));
    }
    tx.commit()?;
    Ok(())
}
fn active(value: &Value, now: i64) -> bool {
    parse_utc(value["issuedAt"].as_str().unwrap_or_default()).is_some_and(|issued| now >= issued)
        && parse_utc(value["expiresAt"].as_str().unwrap_or_default())
            .is_some_and(|expiry| now < expiry)
}
fn ack(
    pool: &Pool,
    branch: &str,
    at: &str,
    version: i64,
    duplicate: bool,
) -> DelegationReservationAck {
    DelegationReservationAck {
        pool_id: pool.id.clone(),
        branch_id: branch.to_owned(),
        recorded_at: at.to_owned(),
        pool_version: version as u64,
        duplicate,
        authority_verified: false,
        dispatch_eligible: false,
    }
}
fn snapshot(pool: &Pool) -> DelegationPoolSnapshot {
    DelegationPoolSnapshot {
        pool_id: pool.id.clone(),
        state_version: pool.version as u64,
        revoked: pool.revoked,
        observed_ms: pool.observed,
        branches: pool
            .branches
            .iter()
            .map(|(id, branch)| DelegationBranchBalance {
                branch_id: id.clone(),
                parent_branch_id: branch.parent.clone(),
                remaining_descendants: branch.slots as u64,
                remaining_budget: Value::Object(
                    FIELDS
                        .iter()
                        .zip(branch.budget)
                        .map(|(key, value)| ((*key).to_owned(), json!(value)))
                        .collect(),
                ),
            })
            .collect(),
        authority_verified: false,
        dispatch_eligible: false,
    }
}

/// Validate payloads, immutable receipts and conservation of every branch before exposing balances.
fn load(tx: &Transaction<'_>, scope: &DelegationReservationScope) -> Result<Pool> {
    let row = tx.query_row("SELECT pool_id,state_version,revoked,observed_ms,initialized_at,seed_digest,seed_payload,kind FROM delegation_pools WHERE profile_id=?1 AND workspace_id=?2 AND root_mission_id=?3 AND root_run_id=?4",
        params![scope.profile_id,scope.workspace_id,scope.root_mission_id,scope.root_run_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?,row.get::<_,i64>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?))).optional()?.ok_or(DelegationLedgerError::NotFound)?;
    let seed = stored(&row.6, &row.5)?;
    let initialized = parse_utc(&row.4).ok_or(DelegationLedgerError::Corrupt)?;
    if !scope.matches(&seed)
        || text(&seed, "delegationId") != row.0
        || seed["lineage"]
            .as_array()
            .is_none_or(|lineage| lineage.len() != 1)
        || row.7 != "provisional"
        || !(1..=MAX).contains(&row.1)
        || !matches!(row.2, 0 | 1)
        || row.3 < initialized
        || !active(&seed, initialized)
    {
        return Err(DelegationLedgerError::Corrupt);
    }
    let mut pool = Pool {
        id: row.0,
        version: row.1,
        revoked: row.2 == 1,
        observed: row.3,
        initialized: row.4,
        seed,
        seed_payload: row.6,
        branches: BTreeMap::new(),
        receipts: HashMap::new(),
    };
    let branches = tx.prepare("SELECT branch_id,parent_branch_id,task_id,idempotency_key,envelope_digest,envelope_payload,slots_remaining,wall_ms_remaining,tokens_remaining,tools_remaining,cost_remaining FROM delegation_branches WHERE profile_id=?1 AND pool_id=?2 LIMIT 1002")?
        .query_map(params![scope.profile_id,pool.id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,i64>(6)?,[row.get::<_,i64>(7)?,row.get::<_,i64>(8)?,row.get::<_,i64>(9)?,row.get::<_,i64>(10)?])))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if branches.is_empty() || branches.len() > 1_001 {
        return Err(DelegationLedgerError::Corrupt);
    }
    for (id, parent, task, key, digest, payload, slots, remaining) in branches {
        let envelope = stored(&payload, &digest)?;
        if !scope.matches(&envelope)
            || id != text(&envelope, "delegationId")
            || task != text(&envelope, "taskId")
            || key != text(&envelope, "idempotencyKey")
            || !(0..=1_000).contains(&slots)
            || remaining.iter().any(|value| !(0..=MAX).contains(value))
        {
            return Err(DelegationLedgerError::Corrupt);
        }
        pool.branches.insert(
            id,
            Branch {
                parent,
                envelope,
                payload,
                slots,
                budget: remaining,
            },
        );
    }
    let root = pool
        .branches
        .get(&pool.id)
        .ok_or(DelegationLedgerError::Corrupt)?;
    if root.parent.is_some() || root.payload != pool.seed_payload {
        return Err(DelegationLedgerError::Corrupt);
    }
    let receipts=tx.prepare("SELECT branch_id,parent_branch_id,idempotency_key,pool_version,recorded_at,intent_digest,intent_payload FROM delegation_reservations WHERE profile_id=?1 AND pool_id=?2 LIMIT 1001")?
        .query_map(params![scope.profile_id,pool.id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if receipts.len() + 1 != pool.branches.len()
        || pool.version != 1 + receipts.len() as i64 + i64::from(pool.revoked)
    {
        return Err(DelegationLedgerError::Corrupt);
    }
    let mut expected: BTreeMap<String, (i64, [i64; 4])> = pool
        .branches
        .iter()
        .map(|(id, branch)| {
            (
                id.clone(),
                (
                    integer(&branch.envelope["childRemaining"]),
                    budget(&branch.envelope),
                ),
            )
        })
        .collect();
    for (id, parent, key, version, recorded_at, digest, payload) in receipts {
        let branch = pool
            .branches
            .get(&id)
            .ok_or(DelegationLedgerError::Corrupt)?;
        let ancestor = pool
            .branches
            .get(&parent)
            .ok_or(DelegationLedgerError::Corrupt)?;
        stored(&payload, &digest)?;
        let time = parse_utc(&recorded_at).ok_or(DelegationLedgerError::Corrupt)?;
        if id == pool.id
            || branch.parent.as_ref() != Some(&parent)
            || branch.payload != payload
            || key != text(&branch.envelope, "idempotencyKey")
            || !(2..=pool.version).contains(&version)
            || time < initialized
            || time > pool.observed
            || inspect_delegation_extension(&ancestor.envelope, &branch.envelope, &recorded_at)
                .is_err()
        {
            return Err(DelegationLedgerError::Corrupt);
        }
        let remaining = expected
            .get_mut(&parent)
            .ok_or(DelegationLedgerError::Corrupt)?;
        remaining.0 = remaining
            .0
            .checked_sub(1 + integer(&branch.envelope["childRemaining"]))
            .filter(|value| *value >= 0)
            .ok_or(DelegationLedgerError::Corrupt)?;
        for (target, allocation) in remaining.1.iter_mut().zip(budget(&branch.envelope)) {
            *target = target
                .checked_sub(allocation)
                .filter(|value| *value >= 0)
                .ok_or(DelegationLedgerError::Corrupt)?;
        }
        if pool
            .receipts
            .insert(
                key,
                Receipt {
                    parent,
                    branch: id,
                    recorded_at,
                    version,
                },
            )
            .is_some()
        {
            return Err(DelegationLedgerError::Corrupt);
        }
    }
    for (id, branch) in &pool.branches {
        if expected.get(id) != Some(&(branch.slots, branch.budget))
            || (id != &pool.id && branch.parent.is_none())
        {
            return Err(DelegationLedgerError::Corrupt);
        }
    }
    let mut chronology: Vec<&Receipt> = pool.receipts.values().collect();
    chronology.sort_by_key(|receipt| receipt.version);
    let by_branch: HashMap<&str, &Receipt> = pool
        .receipts
        .values()
        .map(|receipt| (receipt.branch.as_str(), receipt))
        .collect();
    let mut previous_time = initialized;
    for (index, receipt) in chronology.iter().enumerate() {
        let time = parse_utc(&receipt.recorded_at).ok_or(DelegationLedgerError::Corrupt)?;
        let parent_version = if receipt.parent == pool.id {
            1
        } else {
            by_branch
                .get(receipt.parent.as_str())
                .ok_or(DelegationLedgerError::Corrupt)?
                .version
        };
        if receipt.version != index as i64 + 2
            || time < previous_time
            || parent_version >= receipt.version
        {
            return Err(DelegationLedgerError::Corrupt);
        }
        previous_time = time;
    }
    Ok(pool)
}
fn observe(
    tx: &Transaction<'_>,
    scope: &DelegationReservationScope,
    pool: &mut Pool,
    now: i64,
) -> Result<()> {
    if now > pool.observed {
        tx.execute(
            "UPDATE delegation_pools SET observed_ms=?1 WHERE profile_id=?2 AND pool_id=?3",
            params![now, scope.profile_id, pool.id],
        )?;
        pool.observed = now;
    }
    Ok(())
}
fn insert_branch(
    tx: &Transaction<'_>,
    scope: &DelegationReservationScope,
    pool_id: &str,
    parent: Option<&str>,
    envelope: &Value,
    payload: &str,
) -> Result<()> {
    let caps = budget(envelope);
    tx.execute("INSERT INTO delegation_branches (profile_id,pool_id,branch_id,parent_branch_id,task_id,idempotency_key,envelope_digest,envelope_payload,slots_remaining,wall_ms_remaining,tokens_remaining,tools_remaining,cost_remaining) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![scope.profile_id,pool_id,text(envelope,"delegationId"),parent,text(envelope,"taskId"),text(envelope,"idempotencyKey"),canonical::digest(envelope),payload,integer(&envelope["childRemaining"]),caps[0],caps[1],caps[2],caps[3]])?;
    Ok(())
}

impl CoreStore {
    /// Explicit caller boundary for a provisional pool, not an authority/bootstrap endpoint.
    /// A changed seed in an existing run conflicts; no implicit replenishment or generation reset.
    pub fn initialize_delegation_pool(
        &mut self,
        scope: &DelegationReservationScope,
        seed: &Value,
        now: &str,
    ) -> Result<DelegationReservationAck> {
        let (seed, payload) = normalized(seed)?;
        let time = parse_utc(now).ok_or(DelegationLedgerError::Invalid)?;
        if !scope.valid()
            || !scope.matches(&seed)
            || seed["lineage"]
                .as_array()
                .is_none_or(|items| items.len() != 1)
        {
            return Err(DelegationLedgerError::Invalid);
        }
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        match load(&tx, scope) {
            Ok(mut pool) => {
                observe(&tx, scope, &mut pool, time)?;
                if pool.seed_payload != payload {
                    finish(tx, inject)?;
                    return Err(DelegationLedgerError::Conflict);
                }
                let result = ack(&pool, &pool.id, &pool.initialized, 1, true);
                finish(tx, inject)?;
                return Ok(result);
            }
            Err(DelegationLedgerError::NotFound) => {}
            Err(error) => return Err(error),
        }
        if !active(&seed, time) {
            return Err(DelegationLedgerError::Inactive);
        }
        let id = text(&seed, "delegationId");
        if tx.query_row(
            "SELECT count(*) FROM delegation_pools WHERE pool_id=?1",
            [&id],
            |row| row.get::<_, i64>(0),
        )? != 0
        {
            return Err(DelegationLedgerError::Conflict);
        }
        tx.execute("INSERT INTO delegation_pools (pool_id,profile_id,workspace_id,root_mission_id,root_run_id,kind,state_version,revoked,observed_ms,initialized_at,seed_digest,seed_payload) VALUES (?1,?2,?3,?4,?5,'provisional',1,0,?6,?7,?8,?9)",params![id,scope.profile_id,scope.workspace_id,scope.root_mission_id,scope.root_run_id,time,now,canonical::digest(&seed),payload])?;
        insert_branch(&tx, scope, &id, None, &seed, &payload)?;
        let pool = load(&tx, scope)?;
        let result = ack(&pool, &id, now, 1, false);
        finish(tx, inject)?;
        Ok(result)
    }
    /// Atomically carve a subtree and persist its exact receipt. Never admits execution.
    /// Refused known-scope operations may persist only a conservative clock observation.
    pub fn reserve_delegation(
        &mut self,
        scope: &DelegationReservationScope,
        parent_id: &str,
        child: &Value,
        expected_version: u64,
        now: &str,
    ) -> Result<DelegationReservationAck> {
        let (child, payload) = normalized(child)?;
        let time = parse_utc(now).ok_or(DelegationLedgerError::Invalid)?;
        if !scope.valid()
            || !scope.matches(&child)
            || !is_uuid(parent_id)
            || !(1..=MAX as u64).contains(&expected_version)
        {
            return Err(DelegationLedgerError::Invalid);
        }
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut pool = load(&tx, scope)?;
        let backwards = time < pool.observed;
        observe(&tx, scope, &mut pool, time)?;
        let key = text(&child, "idempotencyKey");
        if let Some(saved) = pool.receipts.get(&key) {
            let branch = pool
                .branches
                .get(&saved.branch)
                .ok_or(DelegationLedgerError::Corrupt)?;
            if saved.parent != parent_id
                || compare_delegation_replay(&branch.envelope, &child).is_err()
            {
                finish(tx, inject)?;
                return Err(DelegationLedgerError::Conflict);
            }
            let result = ack(
                &pool,
                &saved.branch,
                &saved.recorded_at,
                saved.version,
                true,
            );
            finish(tx, inject)?;
            return Ok(result);
        }
        let check = (|| -> Result<()> {
            if backwards {
                return Err(DelegationLedgerError::Inactive);
            }
            if pool.revoked {
                return Err(DelegationLedgerError::Revoked);
            }
            if pool.version != expected_version as i64 || pool.version == MAX {
                return Err(DelegationLedgerError::Conflict);
            }
            if !active(&pool.seed, time) {
                return Err(DelegationLedgerError::Inactive);
            }
            let parent = pool
                .branches
                .get(parent_id)
                .ok_or(DelegationLedgerError::NotFound)?;
            if !active(&parent.envelope, time) || !active(&child, time) {
                return Err(DelegationLedgerError::Inactive);
            }
            if inspect_delegation_extension(&parent.envelope, &child, now).is_err() {
                return Err(DelegationLedgerError::Invalid);
            }
            if pool.branches.contains_key(&text(&child, "delegationId"))
                || pool.branches.values().any(|branch| {
                    branch.envelope["taskId"] == child["taskId"]
                        || branch.envelope["idempotencyKey"] == child["idempotencyKey"]
                })
            {
                return Err(DelegationLedgerError::Conflict);
            }
            let needed = 1 + integer(&child["childRemaining"]);
            if parent.slots < needed
                || parent
                    .budget
                    .iter()
                    .zip(budget(&child))
                    .any(|(remaining, allocation)| *remaining < allocation)
            {
                return Err(DelegationLedgerError::Exhausted);
            }
            Ok(())
        })();
        if let Err(error) = check {
            finish(tx, inject)?;
            return Err(error);
        }
        let caps = budget(&child);
        let needed = 1 + integer(&child["childRemaining"]);
        let version = pool.version + 1;
        let changed=tx.execute("UPDATE delegation_branches SET slots_remaining=slots_remaining-?1,wall_ms_remaining=wall_ms_remaining-?2,tokens_remaining=tokens_remaining-?3,tools_remaining=tools_remaining-?4,cost_remaining=cost_remaining-?5 WHERE profile_id=?6 AND pool_id=?7 AND branch_id=?8 AND slots_remaining>=?1 AND wall_ms_remaining>=?2 AND tokens_remaining>=?3 AND tools_remaining>=?4 AND cost_remaining>=?5",params![needed,caps[0],caps[1],caps[2],caps[3],scope.profile_id,pool.id,parent_id])?;
        if changed != 1 {
            return Err(DelegationLedgerError::Corrupt);
        }
        let changed=tx.execute("UPDATE delegation_pools SET state_version=?1 WHERE profile_id=?2 AND pool_id=?3 AND state_version=?4 AND revoked=0",params![version,scope.profile_id,pool.id,pool.version])?;
        if changed != 1 {
            return Err(DelegationLedgerError::Conflict);
        }
        insert_branch(&tx, scope, &pool.id, Some(parent_id), &child, &payload)?;
        let id = text(&child, "delegationId");
        tx.execute("INSERT INTO delegation_reservations (profile_id,pool_id,branch_id,parent_branch_id,idempotency_key,pool_version,recorded_at,intent_digest,intent_payload) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![scope.profile_id,pool.id,id,parent_id,key,version,now,canonical::digest(&child),payload])?;
        let verified = load(&tx, scope)?;
        let result = ack(&verified, &id, now, version, false);
        finish(tx, inject)?;
        Ok(result)
    }
    /// One-way whole-pool stop. Allocations are retained, never refunded or reactivated.
    pub fn revoke_delegation_pool(
        &mut self,
        scope: &DelegationReservationScope,
        expected_version: u64,
        now: &str,
    ) -> Result<DelegationPoolSnapshot> {
        let time = parse_utc(now).ok_or(DelegationLedgerError::Invalid)?;
        if !scope.valid() || !(1..=MAX as u64).contains(&expected_version) {
            return Err(DelegationLedgerError::Invalid);
        }
        let inject = self.inject_failure();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut pool = load(&tx, scope)?;
        observe(&tx, scope, &mut pool, time)?;
        if pool.version != expected_version as i64 || (!pool.revoked && pool.version == MAX) {
            finish(tx, inject)?;
            return Err(DelegationLedgerError::Conflict);
        }
        if !pool.revoked {
            let changed = tx.execute("UPDATE delegation_pools SET revoked=1,state_version=state_version+1 WHERE profile_id=?1 AND pool_id=?2 AND state_version=?3",params![scope.profile_id,pool.id,pool.version])?;
            if changed != 1 {
                return Err(DelegationLedgerError::Conflict);
            }
        }
        let result = snapshot(&load(&tx, scope)?);
        finish(tx, inject)?;
        Ok(result)
    }
    /// Scoped bookkeeping snapshot; it does not report current grant validity or work settlement.
    pub fn inspect_delegation_pool(
        &mut self,
        scope: &DelegationReservationScope,
    ) -> Result<DelegationPoolSnapshot> {
        if !scope.valid() {
            return Err(DelegationLedgerError::Invalid);
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let result = snapshot(&load(&tx, scope)?);
        tx.commit()?;
        Ok(result)
    }
}
