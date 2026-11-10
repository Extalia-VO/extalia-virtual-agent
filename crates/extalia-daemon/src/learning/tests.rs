use super::*;
fn request(action: &str, input: Value) -> Value {
    json!({"action":action,"input":input})
}
fn run(owner: &mut Learning, action: &str, input: Value) -> Value {
    match owner.handle(&request(action, input)).unwrap() {
        ResponseResult::Learning(v) => v,
        _ => panic!("wrong result"),
    }
}
fn begin() -> Value {
    json!({"profileId":"default","revision":"r1","workspaceId":"workspace","sessionId":"session","runId":"run","promptSha256":"a".repeat(64),"policy":{"enabled":true,"skills":true,"notes":true},"evidence":[{"toolCallId":"source-1","name":"knowledge_read","content":"Verified page content","isError":false}],"tools":[]})
}
fn submitted() -> Value {
    json!({"kind":"model","result":{"text":"","stop":"tool_use","toolCalls":[{"id":"submit-1","name":"submit_learning","input":{"title":"Finding","lesson":"Reusable grounded lesson","evidenceIds":["source-1"],"skill":{"name":"sample-skill","description":"Safe description","instructions":"Read the context first."}}}]}})
}
fn temp() -> PathBuf {
    let p = std::env::temp_dir().join(format!("extalia-learning-{}", uid()));
    std::fs::create_dir(&p).unwrap();
    p
}
#[test]
fn structural_contract_refuses_privileged_fields_and_unbounded_data() {
    assert!(!crate::wire::learning::valid_params(&request(
        "note.pin",
        json!({"root":"/tmp","profileId":"default","revision":"r","workspaceId":"w","sessionId":"s","purpose":"learning","authority":true})
    )));
    assert!(!crate::wire::learning::valid_params(&request(
        "job.advance",
        json!({"jobId":"job","effectId":"effect","completion":{"kind":"shell","command":"no"}})
    )));
    let mut v = begin();
    v["timeoutMs"] = 45001.into();
    assert!(!crate::wire::learning::valid_params(&request(
        "job.begin",
        v
    )));
}
#[test]
fn correlated_job_owns_submission_and_legacy_hashes() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let first = run(&mut owner, "job.begin", begin())["job"].clone();
    let jid = s(&first, "jobId");
    let eid = s(&first["effect"], "effectId");
    assert!(
        owner
            .handle(&request(
                "job.advance",
                json!({"jobId":jid,"effectId":"wrong","completion":submitted()})
            ))
            .is_err()
    );
    let captured = run(
        &mut owner,
        "job.advance",
        json!({"jobId":jid,"effectId":eid,"completion":submitted()}),
    )["job"]
        .clone();
    let ready=run(&mut owner,"job.advance",json!({"jobId":jid,"effectId":captured["effect"]["effectId"],"completion":{"kind":"model","result":{"text":"Done","toolCalls":[],"stop":"end"}}}))["job"].clone();
    assert_eq!(ready["status"], "ready");
    assert_eq!(
        ready["contentSha256"],
        hash(
            "{\"lesson\":\"Reusable grounded lesson\",\"skill\":{\"name\":\"sample-skill\",\"description\":\"Safe description\",\"instructions\":\"Read the context first.\"}}"
        )
    );
    assert_eq!(
        ready["skillSha256"],
        hash(
            "skill:{\"name\":\"sample-skill\",\"description\":\"Safe description\",\"instructions\":\"Read the context first.\"}"
        )
    );
    assert!(
        owner
            .handle(&request(
                "job.advance",
                json!({"jobId":jid,"effectId":eid,"completion":submitted()})
            ))
            .is_err()
    );
    assert_eq!(
        run(&mut owner, "job.finish", json!({"jobId":jid}))["job"]["status"],
        "completed"
    );
    run(&mut owner, "job.release", json!({"jobId":jid}));
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn cancel_and_deadline_retain_pending_until_actual_drain_acknowledged() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let job = run(&mut owner, "job.begin", begin())["job"].clone();
    let jid = s(&job, "jobId");
    let eid = s(&job["effect"], "effectId");
    let cancelled = run(&mut owner, "job.cancel", json!({"jobId":jid}));
    assert!(cancelled["job"].get("effect").is_none());
    assert_eq!(cancelled["job"]["pendingEffectId"], eid);
    assert!(
        owner
            .handle(&request("job.release", json!({"jobId":jid})))
            .is_err()
    );
    assert!(
        owner
            .handle(&request(
                "job.advance",
                json!({"jobId":jid,"effectId":eid,"completion":submitted()})
            ))
            .is_err()
    );
    run(
        &mut owner,
        "job.settle",
        json!({"jobId":jid,"effectId":eid}),
    );
    run(&mut owner, "job.release", json!({"jobId":jid}));
    let mut b = begin();
    b["timeoutMs"] = 1.into();
    let job = run(&mut owner, "job.begin", b)["job"].clone();
    std::thread::sleep(Duration::from_millis(3));
    assert!(owner.handle(&request("job.advance",json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"],"completion":submitted()}))).is_err());
    let mut restarted = Learning::new(&root, "default");
    assert!(
        restarted
            .handle(&request("job.cancel", json!({"jobId":job["jobId"]})))
            .is_err()
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn evidence_is_current_bounded_redacted_and_unknown_ids_are_not_accepted() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let mut b = begin();
    b["evidence"][0]["content"] = "Authorization: Bearer synthetic-secret-value".into();
    let job = run(&mut owner, "job.begin", b)["job"].clone();
    assert!(
        !job["evidence"]
            .to_string()
            .contains("synthetic-secret-value")
    );
    let mut submission = submitted();
    submission["result"]["toolCalls"][0]["input"]["evidenceIds"] = json!(["historical"]);
    let next = run(
        &mut owner,
        "job.advance",
        json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"],"completion":submission}),
    );
    assert_eq!(next["job"]["status"], "running");
    assert!(next["job"].get("submission").is_none());
    std::fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn receipts_reuse_legacy_paths_and_symlinks_never_redirect() {
    use std::os::unix::fs::symlink;
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let input = json!({"profileId":"default","contentSha256":"b".repeat(64),"runId":"run"});
    assert_eq!(
        run(&mut owner, "receipt.claim", input.clone())["claimed"],
        true
    );
    assert_eq!(
        run(&mut owner, "receipt.claim", input.clone())["claimed"],
        false
    );
    let receipt = root.join("automatic-learning").join(format!(
        "{}-{}.json",
        hash("default"),
        "b".repeat(64)
    ));
    assert!(receipt.is_file());
    let external = root.join("outside");
    std::fs::create_dir(&external).unwrap();
    let mut other = input;
    other["contentSha256"] = "c".repeat(64).into();
    let blocked = root.join("automatic-learning").join(format!(
        "{}-{}.json",
        hash("default"),
        "c".repeat(64)
    ));
    symlink(external.join("new"), blocked).unwrap();
    assert_eq!(run(&mut owner, "receipt.claim", other)["claimed"], false);
    assert!(!external.join("new").exists());
    std::fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn note_prepare_commit_is_pinned_immutable_and_cleans_abandoned_drafts() {
    use std::os::unix::fs::symlink;
    let data = temp();
    let vault = temp();
    let mut owner = Learning::new(&data, "default");
    let pin = run(
        &mut owner,
        "note.pin",
        json!({"root":vault,"profileId":"default","revision":"r1","workspaceId":"workspace","sessionId":"session","purpose":"learning"}),
    );
    let record = json!({"workspaceId":"workspace","sessionId":"session","profileId":"default","revision":"r1","runId":"run","promptSha256":"a".repeat(64),"title":"Finding","lesson":"Grounded lesson","evidence":[{"id":"e","name":"knowledge_read","content":"Actual result"}]});
    let draft = run(
        &mut owner,
        "note.prepare",
        json!({"pinId":pin["pinId"],"record":record}),
    );
    assert!(!vault.join("Learning/workspace/run.md").exists());
    run(
        &mut owner,
        "note.commit",
        json!({"draftId":draft["draftId"]}),
    );
    let original = std::fs::read(vault.join("Learning/workspace/run.md")).unwrap();
    let same = run(
        &mut owner,
        "note.prepare",
        json!({"pinId":pin["pinId"],"record":record}),
    );
    run(
        &mut owner,
        "note.commit",
        json!({"draftId":same["draftId"]}),
    );
    let mut changed = record.clone();
    changed["lesson"] = "Different lesson".into();
    let conflict = run(
        &mut owner,
        "note.prepare",
        json!({"pinId":pin["pinId"],"record":changed}),
    );
    assert!(
        owner
            .handle(&request(
                "note.commit",
                json!({"draftId":conflict["draftId"]})
            ))
            .is_err()
    );
    assert_eq!(
        std::fs::read(vault.join("Learning/workspace/run.md")).unwrap(),
        original
    );
    let discarded = run(
        &mut owner,
        "note.prepare",
        json!({"pinId":pin["pinId"],"record":record}),
    );
    run(
        &mut owner,
        "note.discard",
        json!({"draftId":discarded["draftId"]}),
    );
    assert_eq!(
        std::fs::read_dir(vault.join("Learning/workspace"))
            .unwrap()
            .count(),
        1
    );
    #[cfg(unix)]
    {
        let mut tampered_record = record.clone();
        tampered_record["runId"] = "tampered-run".into();
        let tampered_draft = run(
            &mut owner,
            "note.prepare",
            json!({"pinId":pin["pinId"],"record":tampered_record}),
        );
        let temp_name = format!(".learning-{}.tmp", tampered_draft["draftId"].as_str().unwrap());
        let temp_path = vault.join("Learning/workspace").join(&temp_name);
        assert!(temp_path.exists());
        // Replace temp file with a symlink to an outside file
        std::fs::remove_file(&temp_path).unwrap();
        let outside = data.join("outside.txt");
        std::fs::write(&outside, "evil content").unwrap();
        symlink(&outside, &temp_path).unwrap();
        assert!(
            owner
                .handle(&request(
                    "note.commit",
                    json!({"draftId":tampered_draft["draftId"]})
                ))
                .is_err()
        );
        assert!(!vault.join("Learning/workspace/tampered-run.md").exists());

        // Replace temp file with a modified regular file
        let tampered_draft2 = run(
            &mut owner,
            "note.prepare",
            json!({"pinId":pin["pinId"],"record":tampered_record}),
        );
        let temp_name2 = format!(".learning-{}.tmp", tampered_draft2["draftId"].as_str().unwrap());
        let temp_path2 = vault.join("Learning/workspace").join(&temp_name2);
        std::fs::remove_file(&temp_path2).unwrap();
        std::fs::write(&temp_path2, "different content").unwrap();
        assert!(
            owner
                .handle(&request(
                    "note.commit",
                    json!({"draftId":tampered_draft2["draftId"]})
                ))
                .is_err()
        );
        assert!(!vault.join("Learning/workspace/tampered-run.md").exists());
    }
    let old = vault.with_extension("old");
    std::fs::rename(&vault, &old).unwrap();
    std::fs::create_dir(&vault).unwrap();
    assert!(
        owner
            .handle(&request(
                "note.prepare",
                json!({"pinId":pin["pinId"],"record":record})
            ))
            .is_err()
    );
    std::fs::remove_dir(&vault).unwrap();
    symlink(&old, &vault).unwrap();
    assert!(
        owner
            .handle(&request(
                "note.prepare",
                json!({"pinId":pin["pinId"],"record":record})
            ))
            .is_err()
    );
    drop(owner);
    std::fs::remove_file(vault).unwrap();
    std::fs::remove_dir_all(old).unwrap();
    std::fs::remove_dir_all(data).unwrap();
}
#[cfg(unix)]
#[test]
fn generated_stage_is_in_fixed_inbox_and_cleanup_does_not_activate() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let stage = run(
        &mut owner,
        "skill.stage",
        json!({"proposal":{"name":"sample-skill","description":"Safe description","instructions":" Read first. "},"provenance":{"sessionId":"session","workspaceId":"workspace","promptSha256":"a".repeat(64)}}),
    );
    let folder = root
        .join("profiles/default/skill-imports")
        .join(s(&stage, "path"));
    assert_eq!(
        std::fs::read_to_string(folder.join("SKILL.md")).unwrap(),
        "---\nname: sample-skill\ndescription: Safe description\n---\nRead first.\n"
    );
    assert!(
        std::fs::read_to_string(folder.join("PROVENANCE.md"))
            .unwrap()
            .contains("sourceVerified")
    );
    run(
        &mut owner,
        "skill.cleanup",
        json!({"stageId":stage["stageId"]}),
    );
    assert!(!folder.exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn chunked_evidence_preserves_large_sources_and_rejects_interleaved_records() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let intake = run(&mut owner, "evidence.begin", json!({}));
    let iid = &intake["intakeId"];
    for n in 0..40 {
        let ack = run(
            &mut owner,
            "evidence.append",
            json!({"intakeId":iid,"toolCallId":"large","name":"knowledge_read","isError":false,"chunk":"x".repeat(32768),"final":n==39}),
        );
        assert_eq!(ack["complete"], false);
    }
    let mut b = begin();
    b.as_object_mut().unwrap().remove("evidence");
    b["intakeId"] = iid.clone();
    let job = run(&mut owner, "job.begin", b);
    assert_eq!(
        job["job"]["evidence"][0]["content"].as_str().unwrap().len(),
        2000
    );
    let intake = run(&mut owner, "evidence.begin", json!({}));
    let iid = &intake["intakeId"];
    run(
        &mut owner,
        "evidence.append",
        json!({"intakeId":iid,"toolCallId":"one","name":"knowledge_read","isError":false,"chunk":"first","final":false}),
    );
    assert!(owner.handle(&request("evidence.append",json!({"intakeId":iid,"toolCallId":"two","name":"knowledge_read","isError":false,"chunk":"next","final":true}))).is_err());
    run(&mut owner, "evidence.release", json!({"intakeId":iid}));
    std::fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn manual_folder_stage_has_bounded_secure_copy_and_owned_cleanup() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = temp();
    let source = temp();
    let mut owner = Learning::new(&root, "default");
    std::fs::write(source.join("SKILL.md"), "# Candidate\n").unwrap();
    std::fs::create_dir(source.join("scripts")).unwrap();
    std::fs::write(source.join("scripts/read.sh"), "echo example\n").unwrap();
    std::fs::set_permissions(
        source.join("scripts/read.sh"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let stage = run(&mut owner, "skill.stageFolder", json!({"root":source}));
    let folder = root
        .join("profiles/default/skill-imports")
        .join(s(&stage, "path"));
    assert_ne!(
        std::fs::metadata(folder.join("scripts/read.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
    run(
        &mut owner,
        "skill.cleanup",
        json!({"stageId":stage["stageId"]}),
    );
    assert!(!folder.exists());
    symlink(source.join("SKILL.md"), source.join("link")).unwrap();
    assert!(
        owner
            .handle(&request("skill.stageFolder", json!({"root":source})))
            .is_err()
    );
    assert_eq!(
        std::fs::read_dir(root.join("profiles/default/skill-imports"))
            .unwrap()
            .count(),
        0
    );
    std::fs::remove_file(source.join("link")).unwrap();
    std::fs::write(source.join(".hidden"), "hidden").unwrap();
    assert!(
        owner
            .handle(&request("skill.stageFolder", json!({"root":source})))
            .is_err()
    );
    std::fs::remove_dir_all(source).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn oversized_model_input_and_six_step_cap_refuse_before_further_effects() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let mut b = begin();
    b["tools"] = json!([{"name":"knowledge_read","description":"Description","parameters":{"type":"object","description":"x".repeat(60000)}}]);
    let job = run(&mut owner, "job.begin", b);
    assert_eq!(job["job"]["status"], "failed");
    assert!(job["job"].get("effect").is_none());
    let mut job = run(&mut owner, "job.begin", begin())["job"].clone();
    for n in 0..6 {
        job=run(&mut owner,"job.advance",json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"],"completion":{"kind":"model","result":{"text":"","stop":"tool_use","toolCalls":[{"id":format!("call-{n}"),"name":"unavailable","input":{}}]}}}))["job"].clone();
    }
    assert_eq!(job["status"], "failed");
    assert!(job.get("effect").is_none());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn local_worker_keeps_health_responsive_bounds_queue_and_drains_on_eof() {
    use crate::session::{Exit, Session, serve};
    use crate::wire::{self, FrameReader, MAX_FRAME_BYTES};
    use std::io::{Read, Write};
    use std::sync::mpsc;
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    owner.hold = Some((entered_tx, release_rx));
    let (input, mut sender) = std::io::pipe().unwrap();
    let (mut receiver, output) = std::io::pipe().unwrap();
    let server =
        std::thread::spawn(move || serve(input, output, &mut Session::new().with_learning(owner)));
    let (frames_tx, frames_rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut frames = FrameReader::new(MAX_FRAME_BYTES);
        let mut chunk = [0u8; 8192];
        loop {
            let n = receiver.read(&mut chunk).unwrap();
            if n == 0 {
                break;
            }
            for frame in frames.push(&chunk[..n]) {
                frames_tx.send(frame.unwrap().to_value()).unwrap();
            }
        }
    });
    let send = |sender: &mut std::io::PipeWriter, n: u64, op: &str, params: Value| {
        let frame=wire::parse_frame(&json!({"schemaVersion":1,"kind":"request","requestId":format!("00000000-0000-4000-8000-{n:012x}"),"op":op,"params":params})).unwrap();
        sender.write_all(&wire::encode(&frame).unwrap()).unwrap();
    };
    send(
        &mut sender,
        1,
        "hello",
        json!({"clientVersion":"test","capabilities":["hello"]}),
    );
    let hello = frames_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(
        hello["result"]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("learning.process"))
    );
    send(
        &mut sender,
        2,
        "learning.process",
        request(
            "receipt.claim",
            json!({"profileId":"default","contentSha256":hash("first"),"runId":"run"}),
        ),
    );
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    send(&mut sender, 3, "health", json!({}));
    assert_eq!(
        frames_rx.recv_timeout(Duration::from_secs(2)).unwrap()["op"],
        "health"
    );
    for n in 4..37 {
        send(
            &mut sender,
            n,
            "learning.process",
            request(
                "receipt.claim",
                json!({"profileId":"default","contentSha256":hash(n.to_string()),"runId":"run"}),
            ),
        );
    }
    assert_eq!(
        frames_rx.recv_timeout(Duration::from_secs(2)).unwrap()["error"]["code"],
        "capacity_exceeded"
    );
    drop(sender);
    release_tx.send(()).unwrap();
    assert_eq!(server.join().unwrap().unwrap(), Exit::Eof);
    reader.join().unwrap();
    assert_eq!(frames_rx.try_iter().count(), 33);
    assert_eq!(
        std::fs::read_dir(root.join("automatic-learning"))
            .unwrap()
            .count(),
        33
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn eight_read_limit_does_not_admit_a_ninth_effect() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let mut b = begin();
    b["tools"] = json!([{"name":"knowledge_read","description":"Read a registered note","parameters":{"type":"object"}}]);
    let mut job = run(&mut owner, "job.begin", b)["job"].clone();
    let calls:Vec<_>=(0..9).map(|n|json!({"id":format!("read-{n}"),"name":"knowledge_read","input":{"path":"note.md"}})).collect();
    job=run(&mut owner,"job.advance",json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"],"completion":{"kind":"model","result":{"text":"","toolCalls":calls,"stop":"tool_use"}}}))["job"].clone();
    for _ in 0..8 {
        assert_eq!(job["effect"]["kind"], "read");
        job=run(&mut owner,"job.advance",json!({"jobId":job["jobId"],"effectId":job["effect"]["effectId"],"completion":{"kind":"read","ok":true,"output":"Fresh note data"}}))["job"].clone();
    }
    assert_eq!(job["effect"]["kind"], "model");
    assert!(
        job["effect"]["messages"]
            .to_string()
            .contains("learning read limit")
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn malformed_legacy_admission_blocks_retries_and_data_root_cannot_be_retargeted() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let receipts = root.join("automatic-learning");
    std::fs::create_dir(&receipts).unwrap();
    let input = json!({"profileId":"default","contentSha256":"d".repeat(64),"runId":"run"});
    std::fs::write(
        receipts.join(format!("{}-{}.json", hash("default"), "d".repeat(64))),
        b"",
    )
    .unwrap();
    assert_eq!(
        run(&mut owner, "receipt.claim", input.clone())["claimed"],
        false
    );
    let moved = root.with_extension("moved");
    std::fs::rename(&root, &moved).unwrap();
    std::fs::create_dir(&root).unwrap();
    assert!(owner.handle(&request("receipt.claim", input)).is_err());
    assert!(owner.handle(&request("job.begin", begin())).is_err());
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(moved).unwrap();
}

#[test]
fn indexed_default_vault_keeps_the_semantic_profile_binding() {
    let root = temp();
    let mut owner = Learning::new(&root, "default");
    let vault = run(&mut owner, "vault.ensure", json!({"profileId":"default"}));
    let pin = run(
        &mut owner,
        "note.pin",
        json!({"root":vault["root"],"profileId":"profile-main","revision":"r1","workspaceId":"workspace","sessionId":"session","purpose":"learning"}),
    );
    let record = json!({"workspaceId":"workspace","sessionId":"session","profileId":"profile-main","revision":"r1","runId":"run","promptSha256":"a".repeat(64),"title":"Finding","lesson":"Grounded lesson","evidence":[{"id":"e","name":"knowledge_read","content":"Actual result"}]});
    let draft = run(
        &mut owner,
        "note.prepare",
        json!({"pinId":pin["pinId"],"record":record}),
    );
    run(
        &mut owner,
        "note.commit",
        json!({"draftId":draft["draftId"]}),
    );
    let note =
        std::fs::read_to_string(root.join("vaults/default/Learning/workspace/run.md")).unwrap();
    assert!(note.contains("profile: \"profile-main\""));
    let other = run(&mut owner, "vault.ensure", json!({"profileId":"vp-other"}));
    assert!(owner.handle(&request("note.pin", json!({"root":other["root"],"profileId":"profile-main","revision":"r1","workspaceId":"workspace","sessionId":"session","purpose":"learning"}))).is_err());
    drop(owner);
    std::fs::remove_dir_all(root).unwrap();
}
