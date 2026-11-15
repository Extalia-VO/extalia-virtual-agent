//! Reproducible local-only storage/retrieval probe. No model, provider or real
//! profile is used; latency and metadata hits are not token-cost measurements.
use extalia_core::skills::ProfileId;
use extalia_core::work_memory::WorkMemoryStore;
use serde_json::{Value, json};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

fn scope(workspace: &str) -> Value {
    json!({"profileId":"default","workspaceId":workspace,"boundary":"a".repeat(64)})
}
fn percentile(times: &mut [f64], fraction: f64) -> f64 {
    times.sort_by(f64::total_cmp);
    times[((times.len() as f64 * fraction).ceil() as usize)
        .saturating_sub(1)
        .min(times.len() - 1)]
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let path = std::env::temp_dir().join(format!(
        "extalia-work-memory-bench-{}-{nonce}",
        std::process::id()
    ));
    std::fs::create_dir(&path)?;
    let profile = ProfileId::parse("default").ok_or("invalid fixture profile")?;
    let mut store = WorkMemoryStore::open(&path, &profile)?;
    let start = Instant::now();
    for n in 0..2000 {
        let workspace = if n < 1000 {
            "workspace-one"
        } else {
            "workspace-two"
        };
        let text = match n % 1000 {
            0 => {
                "Parser decision: retain the first duplicate and limit batch size to 73.".to_owned()
            }
            1 => "Keputusan pengurai: pertahankan duplikat pertama dan batas batch 73.".to_owned(),
            _ => format!(
                "Unrelated generated catalog item {n}; record the synthetic asset identifier."
            ),
        };
        store.capture(&json!({"scope":scope(workspace),"source":{"kind":"native","sourceId":"extalia-native","sessionId":format!("session-{}",n/20),"episodeId":format!("turn-{n}"),"revision":"b".repeat(64)},"outcome":"completed","title":format!("Generated task {n}"),"summary":text,"entries":[{"id":format!("event-{n}"),"kind":"assistant","text":text}],"coverage":{"mode":"partial","omittedEntries":0,"truncated":false,"limits":["Synthetic attributed claim, no executed task."]}}))?;
    }
    let capture_ms = start.elapsed().as_secs_f64() * 1000.0;
    drop(store);
    let open_start = Instant::now();
    let store = WorkMemoryStore::open(&path, &profile)?;
    let reopen_ms = open_start.elapsed().as_secs_f64() * 1000.0;
    let mut cases = Vec::new();
    for (name, query, expected) in [
        (
            "old_english_record",
            "retain first duplicate",
            Some("turn-0"),
        ),
        (
            "old_indonesian_record",
            "pertahankan duplikat pertama",
            Some("turn-1"),
        ),
        ("unrelated_query", "volcano submarine", None),
    ] {
        let args = json!({"scope":scope("workspace-one"),"query":query,"limit":4});
        for _ in 0..3 {
            store.search(&args)?;
        }
        let mut times = Vec::new();
        let mut result = Value::Null;
        for _ in 0..20 {
            let start = Instant::now();
            result = store.search(&args)?;
            times.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        let hits = result["hits"].as_array().ok_or("invalid result")?;
        let hit = expected.map_or(hits.is_empty(), |expected| {
            hits.iter()
                .any(|h| h["record"]["source"]["episodeId"] == expected)
        });
        let scope_safe = hits
            .iter()
            .all(|h| h["record"]["scope"]["workspaceId"] == "workspace-one");
        cases.push(json!({"name":name,"hit":hit,"scopeSafe":scope_safe,"hits":hits.len(),"p50Ms":percentile(&mut times,0.5),"p95Ms":percentile(&mut times,0.95),"resultUtf16Units":result.to_string().encode_utf16().count()}));
    }
    drop(store);
    let output = json!({"fixtureRecords":2000,"workspaces":2,"recordsPerWorkspace":1000,"captureTotalMs":capture_ms,"reopenMs":reopen_ms,"warmup":3,"iterations":20,"cases":cases,"limits":["Synthetic attributed records only.","No model or paid provider used.","No OS cache reset; repeated local query timings.","This does not measure answer quality or total provider-token savings."]});
    std::fs::remove_dir_all(&path)?;
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}
