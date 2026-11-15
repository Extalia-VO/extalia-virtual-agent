//! Confirmed artifact effects are distinct from exclusive admissions. An admission
//! without a confirmation is uncertain after a crash; it never authorizes replay.
//! The host supplies a receipt only after its artifact writer acknowledged success.
use super::*;
use files::platform::{child, create, optional_child, publish, read, remove, same};
use std::fs::File;

const MAX_DATA_BYTES: usize = 8192;
const MAX_CONFIRMATION_BYTES: usize = MAX_DATA_BYTES * 2 + 2048;

struct Key {
    profile: String,
    content: String,
    admission: String,
    confirmation: String,
}
impl Key {
    fn new(input: &Value) -> Result<Self> {
        ids(input, &["profileId"])?;
        let content = s(input, "contentSha256");
        if !digest(content) {
            return Err(refuse("invalid_receipt"));
        }
        let profile = hash(s(input, "profileId"));
        let stem = format!("{profile}-{content}");
        Ok(Self {
            profile,
            content: content.into(),
            admission: format!("{stem}.json"),
            confirmation: format!("{stem}.confirmed.json"),
        })
    }
    fn admission(&self, folder: &File) -> Result<Option<Value>> {
        let Some(bytes) = read(folder, &self.admission, 1024)? else {
            return Ok(None);
        };
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| refuse("invalid_receipt"))?;
        if value.as_object().is_none_or(|o| o.len() != 5)
            || s(&value, "schema") != "extalia.learning-admission.v1"
            || s(&value, "profileHash") != self.profile
            || s(&value, "contentSha256") != self.content
            || !digest(s(&value, "runSha256"))
            || s(&value, "status") != "attempted"
        {
            return Err(refuse("invalid_receipt"));
        }
        Ok(Some(value))
    }
    fn confirmation(&self, folder: &File, admission: &Value) -> Result<Option<Value>> {
        let Some(bytes) = read(folder, &self.confirmation, MAX_CONFIRMATION_BYTES)? else {
            return Ok(None);
        };
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| refuse("invalid_receipt"))?;
        if value.as_object().is_none_or(|o| o.len() != 6)
            || s(&value, "schema") != "extalia.learning-receipt.v1"
            || s(&value, "status") != "recorded"
            || s(&value, "profileHash") != self.profile
            || s(&value, "contentSha256") != self.content
            || value["runSha256"] != admission["runSha256"]
        {
            return Err(refuse("invalid_receipt"));
        }
        normalized_receipt(&value["receipt"])?;
        Ok(Some(value))
    }
}

fn safe_data(value: &Value, depth: usize) -> bool {
    if depth > 16 {
        return false;
    }
    match value {
        Value::String(value) => extalia_core::knowledge::import::mask_credentials(value).1 == 0,
        Value::Array(values) => values.iter().all(|v| safe_data(v, depth + 1)),
        Value::Object(values) => values.iter().all(|(key, value)| {
            ![
                "token",
                "secret",
                "password",
                "credential",
                "credentials",
                "apikey",
                "api_key",
                "authorization",
                "cookie",
            ]
            .contains(&key.to_ascii_lowercase().as_str())
                && safe_data(value, depth + 1)
        }),
        _ => true,
    }
}

fn normalized_receipt(receipt: &Value) -> Result<Value> {
    let kind = s(receipt, "kind");
    let data = s(receipt, "data");
    if receipt.as_object().is_none_or(|o| o.len() != 2)
        || !["note", "skill"].contains(&kind)
        || data.len() > MAX_DATA_BYTES
    {
        return Err(refuse("invalid_receipt"));
    }
    let data: Value = serde_json::from_str(data).map_err(|_| refuse("invalid_receipt"))?;
    if !data.is_object() || !safe_data(&data, 0) {
        return Err(refuse("invalid_receipt"));
    }
    if kind == "note" {
        let path = s(&data, "path");
        if path.is_empty()
            || path.len() > 4096
            || path.contains(['\\', ':'])
            || path.chars().any(char::is_control)
            || path.split('/').any(|part| ["", ".", ".."].contains(&part))
        {
            return Err(refuse("invalid_receipt"));
        }
    }
    let data = data.to_string();
    if data.len() > MAX_DATA_BYTES {
        return Err(refuse("invalid_receipt"));
    }
    Ok(json!({"kind":kind,"data":data}))
}

impl Learning {
    fn check_receipt_folder(&self, folder: &File) -> Result<()> {
        let data = self.data_handle()?;
        if !same(folder, &child(&data, "automatic-learning", false)?) {
            return Err(refuse("receipt_directory_changed"));
        }
        Ok(())
    }

    pub(super) fn get_receipt(&self, input: &Value) -> Result<Value> {
        let key = Key::new(input)?;
        let data = self.data_handle()?;
        let Some(folder) = optional_child(&data, "automatic-learning")? else {
            return Ok(json!({"status":"missing"}));
        };
        let result = match key.admission(&folder)? {
            None => {
                if read(&folder, &key.confirmation, MAX_CONFIRMATION_BYTES)?.is_some() {
                    return Err(refuse("receipt_admission_missing"));
                }
                json!({"status":"missing"})
            }
            Some(admission) => match key.confirmation(&folder, &admission)? {
                None => json!({"status":"attempted"}),
                Some(confirmation) => {
                    json!({"status":"recorded","receipt":confirmation["receipt"]})
                }
            },
        };
        self.check_receipt_folder(&folder)?;
        Ok(result)
    }

    pub(super) fn record_receipt(&self, input: &Value) -> Result<Value> {
        let key = Key::new(input)?;
        ids(input, &["runId"])?;
        let receipt = normalized_receipt(&input["receipt"])?;
        let data = self.data_handle()?;
        let folder = optional_child(&data, "automatic-learning")?
            .ok_or(refuse("receipt_admission_missing"))?;
        let admission = key
            .admission(&folder)?
            .ok_or(refuse("receipt_admission_missing"))?;
        if s(&admission, "runSha256") != hash(s(input, "runId")) {
            return Err(refuse("receipt_run_mismatch"));
        }
        let confirmation = json!({
            "schema":"extalia.learning-receipt.v1", "profileHash":key.profile,
            "contentSha256":key.content, "runSha256":admission["runSha256"],
            "status":"recorded", "receipt":receipt,
        });
        if let Some(existing) = key.confirmation(&folder, &admission)? {
            if existing != confirmation {
                return Err(refuse("receipt_conflict"));
            }
            self.check_receipt_folder(&folder)?;
            return Ok(json!({"recorded":true,"replayed":true}));
        }

        let bytes = confirmation.to_string();
        let temp = format!(".receipt-{}.tmp", uid());
        let published = (|| {
            let draft =
                create(&folder, &temp, bytes.as_bytes())?.ok_or(refuse("receipt_conflict"))?;
            self.check_receipt_folder(&folder)?;
            if key.admission(&folder)?.as_ref() != Some(&admission) {
                return Err(refuse("receipt_changed"));
            }
            publish(&folder, &temp, &draft, &key.confirmation, bytes.as_bytes())
        })();
        remove(&folder, &temp, false);
        published?;
        self.check_receipt_folder(&folder)?;
        if key.admission(&folder)?.as_ref() != Some(&admission)
            || key.confirmation(&folder, &admission)?.as_ref() != Some(&confirmation)
        {
            return Err(refuse("receipt_changed"));
        }
        Ok(json!({"recorded":true,"replayed":false}))
    }
}
