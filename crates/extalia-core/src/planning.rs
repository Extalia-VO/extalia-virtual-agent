//! Durable local planning lifetime receipts. Neither admission nor observation grants
//! execution authority, a task lease, mission closure, or physical-effect settlement.
use crate::mission::{MissionError, canonical, contract};
use crate::time::parse_utc;
use serde_json::{Map, Value, json};

pub const MAX_PLANNING_BYTES: usize = 32 * 1024;
pub const MAX_PLANNING_HISTORY: usize = 1024;
pub const MAX_PLANNING_CONNECTIONS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanningBegin {
    pub invocation_id: String,
    pub supervisor_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub connection_ids: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanningAdmission {
    pub begin: PlanningBegin,
    pub admitted_at: String,
    pub admission_digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanningObservation {
    pub invocation_id: String,
    pub admission_digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanningObservationRecord {
    pub observation: PlanningObservation,
    pub recorded_at: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanningInspection {
    pub admission: PlanningAdmission,
    pub observation: Option<PlanningObservationRecord>,
}

const fn invalid() -> MissionError {
    MissionError::Invalid("invalid planning receipt contract")
}
pub fn is_opaque_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=200).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn fields<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a Map<String, Value>, MissionError> {
    if serde_json::to_vec(value).map_err(|_| invalid())?.len() > MAX_PLANNING_BYTES {
        return Err(MissionError::Capacity("planning receipt payload"));
    }
    let fields = value.as_object().ok_or_else(invalid)?;
    if required.iter().any(|key| !fields.contains_key(*key))
        || fields
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(invalid());
    }
    Ok(fields)
}
fn text(
    fields: &Map<String, Value>,
    key: &str,
    valid: impl FnOnce(&str) -> bool,
) -> Result<String, MissionError> {
    fields
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| valid(value))
        .map(str::to_owned)
        .ok_or_else(invalid)
}
fn begin_fields(fields: &Map<String, Value>) -> Result<PlanningBegin, MissionError> {
    let connections = fields["connectionIds"].as_array().ok_or_else(invalid)?;
    if connections.is_empty() || connections.len() > MAX_PLANNING_CONNECTIONS {
        return Err(invalid());
    }
    let connection_ids = connections
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| is_opaque_id(value))
                .map(str::to_owned)
                .ok_or_else(invalid)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if connection_ids.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(invalid());
    }
    Ok(PlanningBegin {
        invocation_id: text(fields, "invocationId", contract::is_uuid)?,
        supervisor_id: text(fields, "supervisorId", contract::is_uuid)?,
        session_id: text(fields, "sessionId", is_opaque_id)?,
        workspace_id: text(fields, "workspaceId", is_opaque_id)?,
        connection_ids,
    })
}
impl PlanningBegin {
    pub fn from_value(value: &Value) -> Result<Self, MissionError> {
        begin_fields(fields(
            value,
            &[
                "invocationId",
                "supervisorId",
                "sessionId",
                "workspaceId",
                "connectionIds",
            ],
            &[],
        )?)
    }
    pub fn to_value(&self) -> Value {
        json!({"invocationId":self.invocation_id,"supervisorId":self.supervisor_id,"sessionId":self.session_id,"workspaceId":self.workspace_id,"connectionIds":self.connection_ids})
    }
}
impl PlanningAdmission {
    pub fn from_value(value: &Value) -> Result<Self, MissionError> {
        let fields = fields(
            value,
            &[
                "invocationId",
                "supervisorId",
                "sessionId",
                "workspaceId",
                "connectionIds",
                "kind",
                "admittedAt",
                "admissionDigest",
            ],
            &[],
        )?;
        if fields["kind"] != "native-planning" {
            return Err(invalid());
        }
        Ok(Self {
            begin: begin_fields(fields)?,
            admitted_at: text(fields, "admittedAt", |value| parse_utc(value).is_some())?,
            admission_digest: text(fields, "admissionDigest", is_digest)?,
        })
    }
    pub fn to_value(&self) -> Value {
        let mut value = self.begin.to_value();
        value["kind"] = "native-planning".into();
        value["admittedAt"] = self.admitted_at.clone().into();
        value["admissionDigest"] = self.admission_digest.clone().into();
        value
    }
    pub fn captured_digest(&self, profile: &str) -> String {
        let mut value = self.to_value();
        value
            .as_object_mut()
            .expect("admission object")
            .remove("admissionDigest");
        canonical::digest(
            &json!({"domain":"extalia.core/planning-admission/v1","profileId":profile,"admission":value}),
        )
    }
}
impl PlanningObservation {
    pub fn from_value(value: &Value) -> Result<Self, MissionError> {
        let fields = fields(value, &["invocationId", "admissionDigest", "kind"], &[])?;
        if fields["kind"] != "local-pipeline-settled" {
            return Err(invalid());
        }
        Ok(Self {
            invocation_id: text(fields, "invocationId", contract::is_uuid)?,
            admission_digest: text(fields, "admissionDigest", is_digest)?,
        })
    }
    pub fn to_value(&self) -> Value {
        json!({"invocationId":self.invocation_id,"admissionDigest":self.admission_digest,"kind":"local-pipeline-settled"})
    }
}
impl PlanningObservationRecord {
    pub fn from_value(value: &Value) -> Result<Self, MissionError> {
        let fields = fields(
            value,
            &["invocationId", "admissionDigest", "kind", "recordedAt"],
            &[],
        )?;
        let mut observation = value.clone();
        observation
            .as_object_mut()
            .expect("object")
            .remove("recordedAt");
        Ok(Self {
            observation: PlanningObservation::from_value(&observation)?,
            recorded_at: text(fields, "recordedAt", |value| parse_utc(value).is_some())?,
        })
    }
    pub fn to_value(&self) -> Value {
        let mut value = self.observation.to_value();
        value["recordedAt"] = self.recorded_at.clone().into();
        value
    }
}
impl PlanningInspection {
    pub fn from_value(value: &Value) -> Result<Self, MissionError> {
        let fields = fields(value, &["admission"], &["observation"])?;
        let admission = PlanningAdmission::from_value(&fields["admission"])?;
        let observation = fields
            .get("observation")
            .map(PlanningObservationRecord::from_value)
            .transpose()?;
        if observation.as_ref().is_some_and(|record| {
            record.observation.invocation_id != admission.begin.invocation_id
                || record.observation.admission_digest != admission.admission_digest
                || parse_utc(&record.recorded_at) < parse_utc(&admission.admitted_at)
        }) {
            return Err(invalid());
        }
        Ok(Self {
            admission,
            observation,
        })
    }
    pub fn to_value(&self) -> Value {
        let mut value = json!({"admission":self.admission.to_value()});
        if let Some(record) = &self.observation {
            value["observation"] = record.to_value();
        }
        value
    }
}
pub fn inspect_invocation(value: &Value) -> Result<String, MissionError> {
    text(
        fields(value, &["invocationId"], &[])?,
        "invocationId",
        contract::is_uuid,
    )
}
