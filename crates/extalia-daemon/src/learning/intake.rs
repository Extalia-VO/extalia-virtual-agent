//! Transport chunks preserve raw tool evidence until Rust selects and redacts it.
//! A connection retains at most four intakes, one unfinished 8 MiB record each.
use super::*;
use std::collections::HashSet;
#[derive(Debug)]
pub(super) struct Intake {
    pub created: Instant,
    metadata: Option<Value>,
    buffer: String,
    bytes: usize,
    records: usize,
    seen: HashSet<String>,
    selected: Vec<Value>,
    failed: bool,
}
impl Intake {
    pub fn new() -> Self {
        Self {
            created: Instant::now(),
            metadata: None,
            buffer: String::new(),
            bytes: 0,
            records: 0,
            seen: HashSet::new(),
            selected: Vec::new(),
            failed: false,
        }
    }
    pub fn append(&mut self, v: &Value) -> Result<bool> {
        if self.failed {
            return Err(refuse("intake_failed"));
        }
        let result = self.append_checked(v);
        if result.is_err() {
            self.failed = true;
            self.buffer.clear();
        }
        result
    }
    fn append_checked(&mut self, v: &Value) -> Result<bool> {
        if self.selected.len() == 10 {
            return Ok(true);
        }
        if self.records >= 128 {
            return Err((ErrorCode::CapacityExceeded, Some("evidence_limit")));
        }
        let metadata =
            json!({"toolCallId":v["toolCallId"],"name":v["name"],"isError":v["isError"]});
        if self.metadata.as_ref().is_some_and(|m| m != &metadata) {
            return Err(refuse("evidence_chunk_mismatch"));
        }
        self.metadata = Some(metadata);
        let chunk = s(v, "chunk");
        self.bytes = self
            .bytes
            .checked_add(chunk.len())
            .ok_or(refuse("evidence_limit"))?;
        if self.bytes > 8 * 1024 * 1024 {
            return Err((ErrorCode::CapacityExceeded, Some("evidence_limit")));
        }
        let eligible = v["isError"] != true
            && !s(v, "toolCallId").is_empty()
            && s(v, "toolCallId").encode_utf16().count() <= 200
            && s(v, "name").encode_utf16().count() <= 200
            && !self.seen.contains(s(v, "toolCallId"));
        if eligible {
            self.buffer.push_str(chunk);
        }
        if v["final"] == true {
            if eligible && !text::trim(&self.buffer).is_empty() {
                self.seen.insert(s(v, "toolCallId").into());
                self.selected.push(json!({"toolCallId":v["toolCallId"],"name":text::clean(s(v,"name"),200),"content":text::clean(&self.buffer,2000),"isError":false}));
            }
            self.metadata = None;
            self.buffer.clear();
            self.bytes = 0;
            self.records += 1;
        }
        Ok(self.selected.len() == 10)
    }
    pub fn finish(self) -> Result<Value> {
        if self.failed || self.metadata.is_some() {
            return Err(refuse("evidence_incomplete"));
        }
        Ok(Value::Array(self.selected))
    }
}
