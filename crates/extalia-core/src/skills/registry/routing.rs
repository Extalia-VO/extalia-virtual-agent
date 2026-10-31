//! Routing preview over one coherent, source-verified profile snapshot. The requested
//! workspace identifies approval applicability only; it does not establish ownership.
use super::snapshot::{Snapshot, context_bounded, revision_id_ok};
use super::*;
use crate::skills::resolver;
use crate::skills::routing::{self, RoutingReport};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct RegistryRoutingRequest {
    pub categories: BTreeSet<String>,
    pub intents: BTreeSet<String>,
    /// Exact revisions of registered non-built-in packages, never latest-version lookup.
    pub candidate_revision_ids: Vec<String>,
    pub pins: BTreeMap<String, String>,
    /// None cannot satisfy a workspace-scoped approval. No workspace is inferred.
    pub workspace_id: Option<String>,
    /// Unverified caller claims, never detected host facts or grants.
    pub runtime_facts: BTreeMap<String, String>,
    pub permissions_ceiling: Permissions,
    pub max_results: usize,
}

impl SkillRegistry<'_> {
    /// Read-only category/intent routing diagnostics. Root revisions must be active
    /// and have matching approval scope; dependencies have the same scope requirement.
    /// Built-in registrations have no revision rows here and receive no exemption.
    pub fn routing_preview(
        &mut self,
        request: &RegistryRoutingRequest,
        ctx: &PolicyContext,
        now_ms: i64,
    ) -> Result<RoutingReport, SkillError> {
        if (request.categories.is_empty() && request.intents.is_empty())
            || request.categories.len() > routing::MAX_SELECTORS
            || request.intents.len() > routing::MAX_SELECTORS
            || request
                .categories
                .iter()
                .any(|id| id.len() > 128 || !manifest::is_category_id(id))
            || request.intents.iter().any(|id| !manifest::is_intent(id))
            || request.candidate_revision_ids.len() > routing::MAX_CANDIDATES
            || request
                .candidate_revision_ids
                .iter()
                .any(|id| !revision_id_ok(id))
            || request
                .candidate_revision_ids
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != request.candidate_revision_ids.len()
            || request.pins.len() > resolver::MAX_NODES
            || request.pins.iter().any(|(id, revision)| {
                !super::super::is_package_name(id) || !revision_id_ok(revision)
            })
            || request
                .workspace_id
                .as_deref()
                .is_some_and(|id| !is_workspace_id(id))
            || !context_bounded(&request.runtime_facts, &request.permissions_ceiling)
            || request.max_results == 0
            || request.max_results > routing::MAX_CANDIDATES
        {
            return Err(SkillError::Denied("routing_input_bound"));
        }
        let tx = self
            .store
            .connection()
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let mut snapshot = Snapshot::new(
            &tx,
            &self.objects,
            self.profile.as_str(),
            self.limits,
            ctx,
            now_ms,
        )?;
        let candidates = request
            .candidate_revision_ids
            .iter()
            .map(|id| snapshot.scoped_claim(id, request.workspace_id.as_deref()))
            .collect::<Result<Vec<_>, _>>()?;
        let mut pins = BTreeMap::new();
        for (id, revision) in &request.pins {
            let claim = snapshot.scoped_claim(revision, request.workspace_id.as_deref())?;
            if claim.manifest.id != *id {
                return Err(SkillError::Denied("preflight_pin_mismatch"));
            }
            pins.insert(id.clone(), claim);
        }
        let active_packages = snapshot.active_packages()?;
        let report = routing::preview(&routing::RoutingRequest {
            categories: request.categories.clone(),
            intents: request.intents.clone(),
            candidates,
            pins,
            active_packages,
            runtime_facts: request.runtime_facts.clone(),
            permissions_ceiling: request.permissions_ceiling.clone(),
            max_results: request.max_results,
        });
        drop(snapshot);
        drop(tx);
        Ok(report)
    }
}
