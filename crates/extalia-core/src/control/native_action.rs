//! Store-only native edit intents. Not a wire protocol, policy grant or validated-argument digest.
use super::{enumeration, field, literal, object, text, timestamp, uuid};
use crate::mission::policy::is_edit_target;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeActionRequest {
    pub request_id: String,
    pub idempotency_key: String,
    pub mission_id: String,
    pub workspace_id: String,
    pub task_id: String,
    pub lease_id: String,
    pub holder_agent_id: String,
    pub supervisor_id: String,
    pub attempt: u64,
    pub admission_digest: String,
    pub tool: String,
    pub target: String,
    pub parameters_digest: String,
    pub policy_ref: String,
    pub policy_version: String,
    pub policy_digest: String,
    pub skill_revision_refs: Vec<String>,
    pub expires_at: String,
}
impl NativeActionRequest {
    pub fn to_value(&self) -> Value {
        json!({"kind":"native-action-request.v1","requestId":self.request_id,"idempotencyKey":self.idempotency_key,
        "missionId":self.mission_id,"workspaceId":self.workspace_id,"taskId":self.task_id,"leaseId":self.lease_id,
        "holderAgentId":self.holder_agent_id,"supervisorId":self.supervisor_id,"attempt":self.attempt,"admissionDigest":self.admission_digest,
        "tool":self.tool,"target":self.target,"parametersDigest":self.parameters_digest,"parametersDigestScheme":"unverified-sha256",
        "policyRef":self.policy_ref,"policyVersion":self.policy_version,"policyDigest":self.policy_digest,"skillRevisionRefs":self.skill_revision_refs,"expiresAt":self.expires_at})
    }
    pub fn from_value(value: &Value) -> Option<Self> {
        let mut errors = Vec::new();
        let map = object(
            value,
            "$",
            &[
                "kind",
                "requestId",
                "idempotencyKey",
                "missionId",
                "workspaceId",
                "taskId",
                "leaseId",
                "holderAgentId",
                "supervisorId",
                "attempt",
                "admissionDigest",
                "tool",
                "target",
                "parametersDigest",
                "parametersDigestScheme",
                "policyRef",
                "policyVersion",
                "policyDigest",
                "skillRevisionRefs",
                "expiresAt",
            ],
            &mut errors,
        )?;
        field(map, "kind", "$", &mut errors, |v, p, e| {
            literal(v, p, "native-action-request.v1", e)
        });
        field(
            map,
            "parametersDigestScheme",
            "$",
            &mut errors,
            |v, p, e| literal(v, p, "unverified-sha256", e),
        );
        for key in [
            "requestId",
            "missionId",
            "workspaceId",
            "taskId",
            "leaseId",
            "holderAgentId",
            "supervisorId",
        ] {
            field(map, key, "$", &mut errors, uuid);
        }
        for key in ["idempotencyKey", "policyRef", "policyVersion"] {
            field(map, key, "$", &mut errors, |v, p, e| text(v, p, 200, e));
        }
        for key in ["admissionDigest", "parametersDigest", "policyDigest"] {
            field(map, key, "$", &mut errors, |v, p, e| {
                if !v.as_str().is_some_and(|v| {
                    v.len() == 64
                        && v.bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                }) {
                    e.push(format!("{p}: invalid digest"));
                }
            });
        }
        field(map, "tool", "$", &mut errors, |v, p, e| {
            enumeration(v, p, &["write_file", "edit_file"], e)
        });
        field(map, "target", "$", &mut errors, |v, p, e| {
            if !v.as_str().is_some_and(is_edit_target) {
                e.push(format!("{p}: invalid edit target"));
            }
        });
        field(map, "attempt", "$", &mut errors, |v, p, e| {
            if !v
                .as_f64()
                .is_some_and(|v| v.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&v))
            {
                e.push(format!("{p}: invalid attempt"));
            }
        });
        field(map, "expiresAt", "$", &mut errors, timestamp);
        field(map, "skillRevisionRefs", "$", &mut errors, |v, p, e| {
            let Some(items) = v.as_array().filter(|a| a.len() <= 32) else {
                e.push(format!("{p}: invalid skill references"));
                return;
            };
            let mut refs = std::collections::HashSet::new();
            for item in items {
                text(item, p, 200, e);
                if let Some(item) = item.as_str()
                    && !refs.insert(item)
                {
                    e.push(format!("{p}: duplicate skill reference"));
                }
            }
        });
        if !errors.is_empty() {
            return None;
        }
        let get = |key: &str| value[key].as_str().unwrap_or_default().to_owned();
        Some(Self {
            request_id: get("requestId"),
            idempotency_key: get("idempotencyKey"),
            mission_id: get("missionId"),
            workspace_id: get("workspaceId"),
            task_id: get("taskId"),
            lease_id: get("leaseId"),
            holder_agent_id: get("holderAgentId"),
            supervisor_id: get("supervisorId"),
            attempt: value["attempt"].as_f64()? as u64,
            admission_digest: get("admissionDigest"),
            tool: get("tool"),
            target: get("target"),
            parameters_digest: get("parametersDigest"),
            policy_ref: get("policyRef"),
            policy_version: get("policyVersion"),
            policy_digest: get("policyDigest"),
            skill_revision_refs: value["skillRevisionRefs"]
                .as_array()?
                .iter()
                .map(|v| v.as_str().unwrap_or_default().to_owned())
                .collect(),
            expires_at: get("expiresAt"),
        })
    }
}
