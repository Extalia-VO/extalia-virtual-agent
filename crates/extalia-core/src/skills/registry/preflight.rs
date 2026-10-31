//! A coherent SQL snapshot and bounded observation of actual staged bytes. No writes,
//! state transitions, scanner runs, approval consumption or execution authorization.
use super::snapshot::{Snapshot, context_bounded, revision_id_ok};
use super::*;
use crate::skills::resolver::{self, PreflightReport, ResolverLimits};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct RegistryPreflightRequest {
    pub root_revision_id: String,
    /// Exact pins only. No version lookup, fallback or automatic replacement.
    pub pins: BTreeMap<String, String>,
    /// Caller claims, not verified host facts or authority.
    pub runtime_facts: BTreeMap<String, String>,
    pub permissions_ceiling: Permissions,
    pub limits: ResolverLimits,
}

impl SkillRegistry<'_> {
    /// Read-only diagnostic snapshot. Unknown/foreign pins and invalid source bytes
    /// fail closed with static errors, without revoking or otherwise mutating records.
    /// A successful report is never usable for dispatch, approval or activation.
    pub fn dependency_preflight(
        &mut self,
        request: &RegistryPreflightRequest,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<PreflightReport, SkillError> {
        if !revision_id_ok(&request.root_revision_id)
            || request.pins.len() > resolver::MAX_NODES
            || request.pins.iter().any(|(id, revision)| {
                !super::super::is_package_name(id) || !revision_id_ok(revision)
            })
            || !context_bounded(&request.runtime_facts, &request.permissions_ceiling)
        {
            return Err(SkillError::Denied("preflight_input_bound"));
        }
        let profile = self.profile.as_str();
        let objects = &self.objects;
        let tx = self
            .store
            .connection()
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let mut snapshot = Snapshot::new(&tx, objects, profile, self.limits, ctx, now_ms)?;
        let root = snapshot.claim(&request.root_revision_id)?;
        let mut pins = BTreeMap::new();
        for (id, revision) in &request.pins {
            let claim = snapshot.claim(revision)?;
            if claim.manifest.id != *id {
                return Err(SkillError::Denied("preflight_pin_mismatch"));
            }
            pins.insert(id.clone(), claim);
        }
        let active_packages = snapshot.active_packages()?;
        let report = resolver::preflight(&resolver::PreflightRequest {
            root,
            pins,
            active_packages,
            runtime_facts: request.runtime_facts.clone(),
            permissions_ceiling: request.permissions_ceiling.clone(),
            limits: request.limits,
        });
        drop(snapshot);
        drop(tx);
        Ok(report)
    }
}
