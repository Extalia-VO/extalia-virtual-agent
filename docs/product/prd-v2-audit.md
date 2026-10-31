# Audit PRD v2 terhadap implementasi Extalia

Tanggal: 2026-10-29. Baseline kode: **v0.4.122**, HEAD `00a601a`, checkout
mengandung perubahan lokal yang belum dikomit. Audit ini mencakup kode tersebut,
bukan hanya HEAD dan bukan bukti bahwa perubahan lokal sudah dirilis.

Status: audit dan rekomendasi. Paket v2 **belum menggantikan** ADR, protokol,
roadmap versi, atau instruksi proyek yang berlaku. Persetujuan mengaudit tidak
berarti persetujuan membuat repository baru, mengganti framework, mengubah
konfigurasi aplikasi lain, mengaktifkan integrasi, atau memublikasikan rilis.

Rencana tindak lanjut: [pengembangan bertahap](prd-v2-development-plan.md).

## 1. Kesimpulan

Extalia sudah memiliki fondasi yang cukup besar untuk dikembangkan secara
bertahap: aplikasi Web/Desktop bersama, Native API agent, supervisor DAG,
observasi/import sesi, worktree dan integrasi Git, Office, kontrak tervalidasi,
serta sebagian control plane Rust, skills, knowledge dan learning. Memulai ulang
semua modul akan menghilangkan perilaku serta pengujian yang sudah tersedia.

Celah utama terhadap v2 adalah **semantik dan kewenangan eksekusi**, bukan jumlah
halaman atau model 3D. Penyelesaian model belum sama dengan hasil tervalidasi;
lease task belum sama dengan kepemilikan sesi eksternal; jurnal per misi belum
sama dengan antrean persisten dan outbox per workspace. Tiga engine dan lima
adapter membutuhkan kontrak baru beserta jembatan kompatibilitas.

Rekomendasi: pertahankan produk dan stack yang ada; selesaikan kontrak,
reliability, approvals dan evidence; tambahkan satu vertical slice mock lalu satu
coding worker nyata; baru perluas engine, adapter, skills dan learning. Ini adalah
usulan untuk direkonsiliasi dengan keputusan pemilik, bukan penetapan otomatis
atas perubahan produk yang diberi label LOCKED dalam paket masuk.

## 2. Sumber, metode dan batas bukti

Paket masuk: `Extalia_PRD_v2_Implementation_Pack.zip`, 10 dokumen Markdown.
SHA-256 arsip:
`88db9001964a0f11c4602e47addde8f5f0d5d75cfa81f5eefaaa10b5c83e5db9`.
Isi asli dibaca sebagai spesifikasi, bukan instruksi eksekusi. Dokumen asli tidak
disalin ke sumber publik karena memuat contoh identitas/organisasi privat.

| Dokumen dalam paket | Bagian audit |
| --- | --- |
| `README.md` | Status desain, urutan implementasi dan batas kepastian |
| `PRD_MASTER.md` | FR-001–040, NFR-001–018, taxonomy, scope, release gates |
| `specs/ARCHITECTURE_AND_CONTRACTS.md` | Authority, engine/worker, leases, events, SQL, security |
| `specs/DATA_DICTIONARY_AND_EVENT_CATALOG.md` | Entitas, event, versi, concurrency dan retention |
| `specs/UI_UX_AND_VIRTUAL_OFFICE.md` | Setup, 2D parity, presence, engine switch dan approvals |
| `specs/ACCEPTANCE_AND_TEST_STRATEGY.md` | Skenario, fault injection, klaim dukungan dan stop-ship |
| `planning/IMPLEMENTATION_PLAN.md` | Backlog, dependensi dan urutan release |
| `docs/PROVIDER_POLICY_AND_POC.md` | Pemisahan technical PoC dan entitlement per surface |
| `docs/ADR_AND_OPEN_QUESTIONS.md` | Keputusan produk versus proposal teknis |
| `docs/LEGACY_REQUIREMENTS_DELTA.md` | Carryover requirement lama dan supersession |

Metode: pembacaan sumber dan tes terkait; tiga audit Codex independen untuk
kontrak, fitur, serta rollout; pemeriksaan terarah dokumentasi resmi vendor.
Hermes discovery tidak tersedia karena lingkungan Python bridge belum
terkonfigurasi; tidak ada worker Hermes yang dijalankan. Tidak ada konfigurasi
atau profil pengguna yang diubah, provider berbayar yang dipanggil, maupun PoC
vendor yang dijalankan.

Hasil `pnpm check` terakhir dari pekerjaan v0.4.122 adalah **288 suite, 3.437 tes
lulus, satu dilewati, 249 tes Rust, dan build Web/Desktop/CLI lulus**. Itu bukti
historis dari increment tersebut. Audit ini tidak menjalankan ulang seluruh tes,
tidak mengesahkan perubahan aset lain yang sedang berlangsung, tidak menguji
seluruh platform, dan tidak menyatakan semua acceptance v2 terpenuhi.

Status tabel: **Fondasi** = perilaku tersedia tetapi acceptance v2 belum lengkap;
**Sebagian** = hanya bagian requirement tersedia; **Belum** = permukaan v2 belum
tersedia; **Konflik** = perlu keputusan/kompatibilitas; **VERIFY** = belum ada
PoC/clearance yang cukup. Tidak ada persentase selesai yang dihitung dari jumlah
baris atau jumlah tes.

## 3. Temuan yang harus diselesaikan sebelum implementasi v2

| ID | Prioritas | Temuan dan bukti | Implikasi |
| --- | --- | --- | --- |
| A-01 | P0 | Paket mengasumsikan repository privat yang harus ditulis ulang. [ADR 0001](../adr/0001-clean-public-repository.md) sudah menetapkan migrasi selektif ke repository publik; repo saat ini sudah memiliki governance dan public-safety checks. | F0-02 menjadi revalidasi provenance/riwayat/artefak, bukan perintah menghapus atau membuat ulang repo. Audit penuh Git history dan semua lisensi tetap belum dilakukan di tugas ini. |
| A-02 | P0 | Master v2 §19 menyatakan Vue secara tegas, sedangkan README, ADR-001-T dan UI §8.5 menyebutnya PROPOSED. `apps/web/package.json` memakai React/React Three Fiber; Desktop memakai renderer yang sama. | Pertahankan React/Electron/Three.js untuk rencana penambahan. Migrasi Vue/Tauri memerlukan ADR, manfaat terukur dan rencana rollback tersendiri. |
| A-03 | P0 | Native v2 berarti coordinator deterministik tanpa model wajib. [ADR 0005](../adr/0005-extalia-native-runtime.md), `packages/runtime/src/loop.ts` dan `packages/core/src/models.ts::workspaceRuntime` sudah menyediakan Native agent berbasis API. | Pisahkan coordinator dari executor Native yang ada. API agent, custom router, pilihan model dan sesi lama tetap didukung; jangan menjadikan OpenCode pengganti wajib API-only. |
| A-04 | P0 | `packages/runtime/src/mission.ts::runNativeMission` dapat menandai task `completed` dengan `verification: unverified`, membuka dependency dan menyelesaikan misi. `packages/host/src/mission.ts::projectMissionEvent` juga memproyeksikan `task.completed` dengan hasil belum terverifikasi. | V2 membutuhkan pemisahan execution finished, validation, accepted/waived, lalu dependency release. Jangan mengganti arti event historis tanpa versi/translator. Ini delta acceptance, bukan klaim bahwa UI lama menyembunyikan label unverified. |
| A-05 | P0 | Rust sudah memiliki exact-claim heartbeat, reaper, admissions dan coherent recovery review (ADRs 0031–0035), tetapi `MissionRecovery.inspect` tetap menolak ketidakpastian nyata. | Pertahankan quarantine. Review digest tidak memberi izin replay/closure dan tidak membuktikan remote cancellation, seluruh planner/descendant, atau writer/worktree settlement. |
| A-06 | P0 | `packages/runtime/src/mission.ts` menjadwalkan melalui set pending/active dalam RAM. Rust memberi sequence per misi; sesi disimpan terpisah lewat JSON/JSONL. | Belum ada `queue_jobs`, workspace cursor, transactional event inbox/outbox dan command-intent/ack seperti v2. Jangan menyebut checkpoint sebagai durable queue atau menganggap timeout berarti command tidak diterima. |
| A-07 | P0 | ADR 0019/0021 memilih ownership Rust bertahap; ADR 0022 menerima Python on-demand yang dibundel. V2 mengusulkan Node core dan tidak memetakan seluruh tambahan PRD v1.1. | Jangan membuat dua penulis DB atau menghilangkan keputusan Rust/Python, learning, skill routing dan memory layers secara diam-diam. |
| A-08 | P0 | `RuntimeId` hanya `extalia-native \| hermes`; capability orchestration menggunakan boolean. Belum ada EngineHost/WorkerHost dan multi-state per-mode manifest v2. | Tambah layer kontrak engine/worker dan translator ID; jangan sekadar menambah kartu engine atau menyamakan provider API dengan coding adapter. |
| A-09 | P0 | Profile domain ada, tetapi host menyusun satu profile aktif dan jalur daemon/recovery memakai `default`. `runtimeId` workspace sudah ada, namun belum ada transaksi engine-switch/generation/drain v2. | CRUD/profile ACL dan isolasi simultan memerlukan migrasi serta uji sendiri. Existing mission-policy edit guards bukan bukti seluruh engine-switch selesai. |
| A-10 | P0 | `packages/host/src/service.ts::askUser`/`resolveApproval` dan policy loop sudah memberi ask/allow/deny. Kontrak exact digest/expiry ada, enforcement durable gate 3.4 belum selesai (ADR 0026). | Persist action intent/grant/revocation dan recheck tepat sebelum efek, mencakup actor, task, workspace, canonical target, parameter hash dan policy version. |
| A-11 | P1 | Import/linked/observed sudah ada pada subsistem berbeda; `library.ts` dapat mengganti konten saat reimport. V2 menyebut immutable imported snapshot. | Putuskan revisioned import atau explicit replace preview; satukan index/provenance tanpa menulis sumber. Map ID `s_…`, `w_…` dan UUID secara eksplisit. |
| A-12 | P1 | Bridge sudah memiliki loopback/Host/Origin/token/allowlist; token per-launch masuk ke HTML yang disajikan. V2 mengusulkan installation pairing dan per-client grants. | Pertahankan pertahanan yang ada; pairing/revoke/scopes adalah tambahan nyata, bukan alasan mengklaim Bridge saat ini terbuka tanpa autentikasi. |
| A-13 | P1 | Worktree ownership/integration masih pada registry host; Rust skills memakai fail-closed inspector, sedangkan jalur TS lama dapat memuat skill yang disetujui tetapi belum dipindai. | Samakan enforcement sebelum mempromosikan execution path baru; jangan melemahkan scanner gate hanya karena v2 menyebut hasil scanner advisory. |
| A-14 | P1 | Office sudah event-driven, tetapi idle NPC/dekorasi dan aktivitas agent harus dibedakan. `office/presence.ts` dapat mengubah aktivitas observed lama menjadi idle. | Uji freshness/generation dan label unknown/unverified; gerakan dekoratif bukan bukti kerja, stale bukan completed. |

### Cacat internal spesifikasi masuk

1. **Single-controller uniqueness salah:** Architecture G.1 menyatakan unique
   `(sourceSystem, externalSessionId, activeControllerLease)` mencegah dua
   controller. Lease berbeda masih lolos; SQL runtime session juga tidak
   mendefinisikan lock yang setara. Perlu satu active controller untuk source
   identity dan fencing generation; process lock lokal tidak melindungi semua
   data directory atau aplikasi vendor.
2. **Envelope delegasi tidak konsisten:** Architecture F menuntut
   `ownershipToken`, `originEngineId`, `delegateeEngineId`, tetapi tipe F.4
   kehilangan token dan memakai penamaan berbeda. Opaque capability tidak boleh
   diganti dengan nama engine yang dikirim model.
3. **Versi/state tidak konsisten:** beberapa wire menggunakan angka `1`, yang
   lain string `1.0`; `TaskDefinition.version` versus `stateVersion`;
   `superseded` ada di dictionary tetapi tidak dalam TaskStatus. Ada pula dua
   precedence presence berbeda antara Architecture P dan UI §8.3.
4. **Command outbox tidak terdefinisi penuh:** antrean event publishing tidak
   sama dengan durable command intent, dispatch receipt, unknown outcome dan
   dedupe provider. Definisikan keduanya beserta batas exactly-once.
5. **Alpha berbeda antar dokumen:** master membuat Hermes/OpenClaw nonblocking,
   tetapi acceptance §4 menempatkan E2E mixed-engine sebelum alpha. Master
   memperbolehkan mock, FR-007 menuntut real worker, dan plan §5.1 secara khusus
   mewajibkan OpenCode. Mock-only harus tetap preview; dependency engine eksternal
   dipisah dari core alpha.
6. **Fitur P0 diletakkan terlambat:** import/export alpha baru muncul dalam I5/R6;
   entitlement guard P1 dibutuhkan sebelum real worker pertama. Executable
   extension isolation tidak boleh menunggu sesudah ekstensi executable aktif.
7. **Traceability belum lengkap:** plan §6 tidak memetakan FR-027/029/030/037/039/040.
   Banyak referensi DB/ART/AUD/QA/EXEC/UI-SEC/CLI/SDK/REL/UPD belum memiliki kasus
   konkret; beberapa rentang HM/CL/UI/SKL hanya placeholder. ID tes bukan bukti
   tes itu sudah ada atau bisa dijalankan.

## 4. Crosswalk seluruh functional requirements v2

Kolom tahap mengacu pada T0–T8 di rencana. Status tidak berarti dukungan vendor
atau release gate sudah lulus.

| FR | Prioritas v2 | Status terhadap kode | Bukti sumber utama | Penambahan yang diperlukan | Tahap |
| --- | --- | --- | --- | --- | --- |
| 001 Profile isolation | P0 | Sebagian | `packages/core/src/models.ts`, host `service.ts`, Rust scoped stores | Management/ACL seluruh profile dan dua profile simultan, bukan hanya core row scoping | T3 |
| 002 Workspace manager | P0 | Fondasi | `models.ts`, `service.ts::saveWorkspace`, folder validation | Engine pointer/generation, migration, trust dan edit guards lengkap | T3 |
| 003 Engine selection | P0 | Sebagian | Native/Hermes runtime selection | Native/Hermes/OpenClaw contract, honest detected/configured/policy/offline states | T1/T3/T6 |
| 004 Native | P0 | Fondasi + konflik istilah | runtime `mission.ts`, `loop.ts`, host `mission.ts` | Coordinator provider-free di atas executor API yang dipertahankan | T1/T4 |
| 005 Engine contract | P0 | Sebagian | protocol `EngineCapabilities`, platform capabilities | Versioned operations/receipts, unsupported/reconcile, one authority root | T1/T4 |
| 006 Coding adapter contract | P0 | Belum sesuai v2 | protocol `AdapterCapabilities`, provider adapters | Worker seam, lifecycle/ownership, multi-state capability dan policy manifests | T1 |
| 007 Real worker proof | P0 | VERIFY | Scripted multi-provider tests bukan real external coding-worker PoC | Mock compliance lalu satu real permitted worker; OpenCode kandidat pertama | T4/T5 |
| 008 Mission DAG | P0 | Fondasi | runtime `mission.ts`, protocol transitions, mission UI | Plan revisions, accepted evidence, optional/waived node semantics dan dependency gate | T1/T2 |
| 009 Durable queue | P0 | Sebagian | Rust task leases/reaper; mission checkpoints | Persistent jobs/command receipts, safe retries, ack/reconcile dan restart | T2/T3 |
| 010 Approval/PDP | P0 | Sebagian | runtime `policy.ts`/`loop.ts`, daemon `permission.check` | Exact expiring/revocable durable grants pada effect boundary | T2 |
| 011 Session registry | P0 | Fondasi terpisah | host `sessions.ts`/`observations.ts`, core `library.ts` | Unified indexed origins, ownership, bulk/date/provider/move UX dan migration | T3/T4 |
| 012 Event protocol | P0 | Fondasi + gap | `events.ts`, `orchestration.ts`, schema generation, Rust journal | Workspace sequence/inbox/outbox/cursor, legacy translation, command vs event receipts | T1/T3 |
| 013 2D core UI | P0 | Fondasi | `apps/web/src/App.tsx`, Chat/Missions/Files/Git/Logs | Persisted 3D-off entry dan complete no-WebGL workflows | T4 |
| 014 Office core | P0 | Fondasi | `office/presence.ts`, `missionPresence.ts`, scene | Canonical instance generation/freshness dan authoritative evidence mapping | T1/T4 |
| 015 Import safe mode | P0 | Fondasi | host `nativeImport.ts`, importers `parsers.ts`, ImportPage | Per-version source-hash E2E, import revision policy, profile scope | T3/T4 |
| 016 Local bridge | P0 | Fondasi + gap | CLI `bridge/server.ts`, Desktop preload/main | Pairing, per-client scopes/revoke dan threat tests; preserve current safeguards | T3/T4 |
| 017 Data export | P0 | Sebagian | core `portable.ts`, redacted session export/import | Minimal owned mission/session/evidence export, consistent snapshot/checksums | T3/T4 |
| 018 Safe public rewrite | P0 | Konflik asumsi | ADR 0001, migration ledger, public-safety check | Revalidate history/assets/tarballs; new repo only by separate explicit decision | T0/T8 |
| 019 Hermes engine | P1 | Sebagian | host/runtime Hermes process + mapper, hooks/observation | Formal engine broker, profile mapping, approved observe/control PoC, switching | T6 |
| 020 OpenClaw engine | P1 | Belum | No corresponding implementation found | Documented Gateway client, scope/auth, events, receipt/reconcile, lineage | T6 |
| 021 Codex adapter | P1 | Observation fondasi; managed belum | Hooks/import; `connect/codexAppServer.ts` only hook trust | Dedicated managed worker; hook-trust RPC is not task control | T7 |
| 022 Claude Code adapter | P1 | Observation fondasi; managed belum | Hooks/import and Anthropic model provider | CLI binary and Agent SDK separate modes/PoCs, permission relay, current policy | T7 |
| 023 Skills registry | P1 | Fondasi | Rust `skills/`, host registry, Skill Security Center | Dependency/compatibility closure, category routing, enforcement parity | T2/T7 |
| 024 Skill scanner | P1 | Belum operasional | `UnavailableInspector`, quarantine lifecycle | Verify scanner/version/license, pinned worker, reports/attestations, no autoactivation | T7 |
| 025 Worktrees | P1 | Fondasi | host `worktrees/`, Changes UI, integration test gate | Rust writer fencing/ownership, durable review, physical settlement | T2 |
| 026 Knowledge/meetings | P1 | Knowledge fondasi; meeting belum | Rust `knowledge/`, host watcher, Knowledge UI | Structured meetings/decisions, scoped reviewed writes, evidence and shared publish | T7 |
| 027 Roster/subagents | P1 | Fondasi | `teams.ts`, Office hierarchy and saved appearances | Persistent identity vs ephemeral instance, engine-qualified keys/capability routing | T1/T4/T7 |
| 028 Observer bridge | P1 | Fondasi | host observations/hooks/MCP, runtime mappers | Tested-version/capability metadata and revised freshness rules | T4/T6/T7 |
| 029 Queue vs steer | P1 | Belum sebagai produk | Internal promise queues are not live steer | Explicit negotiated queue/live-steer modes, receipts and unavailable UX | T7 |
| 030 Entitlement guard | P1 | Belum terpadu | Current runtime capability checks, no per-surface clearance registry | Backend mode policy gate promoted to prerequisite of first real worker | T1/T5 |
| 031 Notifications/Discord | P1 | Sebagian | Platform notifications, existing outside channels observed | Optional scoped channel adapter; no outbound message sent by this audit | T8 |
| 032 Extension SDK | P1 | Belum dipublikasikan | Internal protocol/platform boundaries | Versioned extension contracts and compliance suite; no duplicate protocol authority | T8 |
| 033 Release updater | P1 | Fondasi | CLI/Desktop update code, release workflow | Package evidence per OS, safe active-work restart and signing/channel checks | T8 |
| 034 Google surfaces | P2 | Import/observer fondasi; managed belum | Gemini/Antigravity parsing and hooks | Distinct surfaces and independent policy/PoC; consumer wrapper blocked | T7 |
| 035 Kiro | P2 | Belum | No Kiro worker implementation found | ACP version/mode/policy proof; API/headless kept distinct | T7 |
| 036 Advanced Campus | P2 | Visual fondasi | Existing scene, avatars, furniture and campus | Data-driven profile/building/room editing; retain existing visuals, defer expansion | T7/T8 |
| 037 Pack restore | P2 | Session interchange sebagian | core `portable.ts`, host importPortable | Full restore dry-run/migration/conflict/rollback beyond existing session interchange | T8 |
| 038 Plugin isolation | P2 | Belum | No executable plugin host found | Out-of-process broker/isolation before any new executable extension is enabled | T7/T8 |
| 039 Fine budgets | P2 | Sebagian | Mission token/task-token/time/concurrency limits | Pricing provenance/cost ceilings, rate-limit retry policy, accurate unknown usage | T2/T7 |
| 040 Languages | P2 | Fondasi | EN/ID `i18n.ts` and preferences | Preserve current languages at every stage; pluggable packs and accessibility certification later | Semua/T8 |

### Non-functional acceptance

| NFR | Audit dan rencana |
| --- | --- |
| 001 platform | Builds/packaging exist; packaged macOS/Windows/Linux acceptance must be attached per claimed architecture. No fresh CI query in this audit. |
| 002 local-first | Local stores/read paths exist; certify offline navigation and core manual planning independently of model availability (T4). |
| 003 reliability | Mission atomic commits exist; workspace state/event/outbox and dispatch-intent transactions remain gaps (T2/T3). |
| 004 performance | Adaptive rendering/quality work exists; v2 generic >=30 FPS target is not measured acceptance and does not replace the user's >40 FPS campus target. Benchmark declared scenes/hardware separately. |
| 005 responsiveness | No newly measured p95; record command latency separately from provider latency in T8. |
| 006 event delivery | Hook/history event paths exist; workspace persisted replay convergence and p95 proof remain (T3/T4/T8). |
| 007 availability | Recovery quarantines uncertainty; independent mixed-engine outage containment remains a new test (T2/T6). |
| 008 security | Existing path/permission/bridge defenses retained; exact grants and pairing added (T2/T3). |
| 009 accessibility | Some keyboard/reduced-motion support exists; full no-WebGL and assistive-technology acceptance remains (T4/T8). |
| 010 localization | EN/ID preserved immediately; no reclassification as expendable P2 work. |
| 011 privacy | Redaction/source-safe parsers exist; new artifact/export/error/command paths need canary checks (all stages). |
| 012 portability | Session interchange exists; full backup/restore across multiple stores is not proven (T3/T8). |
| 013 maintainability | Schemas, boundaries and ADRs exist; public SDK and expanded compatibility remain (T1/T8). |
| 014 supply chain | Lockfiles/public asset inventory exist; whole-history/SBOM/distributed artifact audit not certified here (T8). |
| 015 pilot scale | Three engines/10 live adapter sessions/10k indexed sessions remain test targets, not measured capacity. |
| 016 network | Loopback preserved; remote/LAN is an explicit later capability with secure pairing, never enabled by this plan. |
| 017 observability | Existing correlations/logs/health retained; durable command receipts, dead-letter and replay diagnostics remain (T3). |
| 018 offline degradation | Preserve last visible data/disconnection banner; prove complete 2D read workflow and disabled execution reason (T4). |

## 5. Reuse inventory

| Classification | Area | Tindakan |
| --- | --- | --- |
| KEEP | React Web/Desktop shell, platform API, Three.js projection | Preserve behavior, selection/camera, direct API agent, test-first model UX and optional initial workspace selection. |
| KEEP | Protocol validators/schema fixtures, Rust migrator/leases/reaper/recovery evidence | Extend behind one authority; no destructive enum or ID renames. |
| KEEP | Source-safe importers/library, credentials protection, Bridge defenses | Map to unified registry and strengthen pairing; never replace with raw home crawling. |
| KEEP | Git worktree/integration, skills quarantine, knowledge CAS/index/history, learning core | Reuse substantive code/tests; complete ownership, scanner, resolver and product integration. |
| ADAPT | Engine/worker/provider distinction and capability manifests | Versioned ports, legacy mapping, per-surface verification. |
| ADAPT | Completion, events, sessions and approvals | Add accepted evidence/state/receipts and migration; preserve historical truth. |
| ADAPT | Onboarding/Office/presence | Add engine selection, 2D-only path and freshness with no removal of current assets/features. |
| REWRITE, narrow | New queue/outbox/ownership broker surfaces if existing in-memory design cannot meet durable contract | Isolate new implementation behind parity-tested APIs; do not label whole runtime or UI for rewrite. |
| DROP from critical path | Duplicate public scaffolding, second contracts package, automatic Vue migration, decorative expansion | Convert historical foundations to revalidation; retain existing features and defer new decoration. |
| DROP from execution scope | Provider token extraction, unapproved wrappers, fictional progress, unsafe automatic replay/merge | No implementation or workaround path. |

## 6. Vendor documentation spot-check

Checked 2026-10-29. This is a document-level check, **not a live PoC or blanket
account entitlement clearance**. No installed vendor version was probed.

- OpenCode documents a JS/TS server client, events and a session abort API. Its
  client/server lifecycle and inherited local configuration make isolated config,
  process ownership and cancellation evidence essential to the first PoC.
  [Official SDK](https://opencode.ai/docs/sdk/).
- OpenClaw documents a WebSocket Gateway with handshake roles/scopes and
  agent/session/approval families. That supports investigating a client; it does
  not certify Extalia's ownership or reconnect behavior.
  [Official protocol](https://docs.openclaw.ai/gateway/protocol).
- The incoming blanket Claude subscription HOLD needs a finer distinction.
  Current docs describe conditions for hosting the unmodified Claude Code binary,
  including end users authenticating through its own flow. Separately, applications
  built around the Agent SDK should use API keys or supported cloud credentials;
  routing users' consumer credentials through the app is restricted. Keep distinct
  modes and review conditions/PoCs; do not collect or intermediate credentials.
  [Official legal/authentication guidance](https://code.claude.com/docs/en/legal-and-compliance).
- Antigravity's official FAQ says consumer headless wrapping in third-party apps
  is unsupported and distinguishes it from direct scripting/CI. Keep this route
  disabled; independent API/enterprise/observer surfaces need their own evidence.
  [Official FAQ](https://antigravity.google/docs/faq/).
- Kiro documents ACP negotiation and version-dependent session/model/turn
  behavior. That is technical evidence, not proof every Extalia harness/account
  combination is permitted. Record actual version and mode; do not infer a blanket
  ban or permission from a billing summary.
  [Official ACP](https://kiro.dev/docs/cli/acp/).
- Codex control capability is not established by the repository's hook-trust
  `codex app-server` helper. Hermes command execution already exists for selected
  runtime sessions; formal external-engine capabilities and safe reconciliation
  still require dedicated validation. Their full policy/SDK audit is pending.

## 7. Legacy carryover and release interpretation

PRD v2's old-to-new map focuses on the earlier 47-section baseline, not the entire
v1.1 technical blueprint and decisions made since then. Keep these items explicit:

- Rust owns canonical control incrementally; TypeScript provider/executor adapters
  can remain behind ports. Rust must not be replaced by Node based only on v2's
  proposed stack table.
- On-demand, bundled Python/scanner/evaluation workers remain accepted design,
  **not implemented** runtime infrastructure. Blender scripts do not satisfy it.
- Secure skill routing/dependencies, memory layers dan claim-level provenance
  yang belum tersedia, sandbox evaluation, learning/evaluation rollback,
  Learning Center dan guarded automation tetap backlog. Import provenance,
  knowledge history rollback dan skill rollback yang sudah ada tetap dipertahankan.
- Rust learning core sudah memiliki idempotent experience capture, pemisahan
  verified/untrusted evidence, proposal knowledge/skill, digest-bound local-user
  decisions, managed-note CAS dan skill-inbox staging. Daemon wire, host/UI dan
  evaluation workers belum lengkap; bukan berarti learning hanya tipe kontrak.
  Lihat `crates/extalia-core/src/learning/mod.rs`, `learning/tests.rs` dan ADR 0029.
- Scanner/Python masih bagian acceptance milestone yang sudah dicatat. Menjadwalkan
  infrastrukturnya pada lane T7 tidak menunda requirement v0.5 secara otomatis;
  perubahan cakupan membutuhkan amendment roadmap eksplisit.
- Existing EN/ID, camera/board behavior, chosen workspace/model flows, detailed
  Office assets and source-safe imports remain regression requirements.
- Document v2, event protocol version, DB migration version and application
  v0.4/v0.5/v0.6 milestones are different version domains. Do not bump to 2.0
  because the document is v2 or label current recovery review full v0.5 completion.
- `docs/release/versioning.md` and current changelog milestones need one reconciled
  mapping; older gap-map rows still omit implemented skills/knowledge/learning
  foundations. Use code + dated ledger, not an isolated stale status cell.
- Publication remains a separate maintainer step with all required CI passing.
  This audit neither queries the latest CI nor changes existing publication holds.

## 8. Verification of this audit

Documentation-only change. Public-safety, package-version consistency,
whitespace, local Markdown links and table shape checks passed. Structural
coverage: 40 FR, 18 NFR, T0–T8, 20 proposed work packages and 34 planned acceptance
cases. These counts establish document coverage, not implemented acceptance.
Three Codex source audits and independent feature/rollout reviews completed;
reported plan gaps were corrected and the final rollout review found no remaining
must-fix issue in its scope. No token-usage/savings metric was reported.

During the audit a separate asset-development increment moved package versions
to v0.4.123; version consistency passed at that value. This audit did not bump
versions or verify that increment's runtime behavior. The audited control-plane
baseline and historical full-check figures above remain explicitly v0.4.122.
No runtime changes, new installer, Git commit, push or publication were made by
this documentation task. Vendor and cross-platform acceptance remain open.
