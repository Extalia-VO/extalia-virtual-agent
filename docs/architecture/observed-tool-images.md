# Observed tool image previews

The observed transcript path previously retained prompt image attachments but
reduced tool results to text. The shared transcript also passed its session-bound
preview loader only to user messages. Codex image-view activity could therefore
appear without the thumbnail that its source app displayed.

## Data and authority

`tool.completed.attachments` extends the existing bounded attachment-summary
contract: name, kind, byte size and optional SHA-256 reference. Raw image bytes,
URLs and filesystem paths are rejected in this metadata. TypeScript validation,
generated schemas and Rust body validation share regression fixtures.

The Codex importer recognizes explicit structured result image content: MCP image
blocks, Claude-style image sources within results, and input/image-URL content
parts. This describes supported serialization shapes, not certification of every
installed Codex version. It never reads a path or fetches a URL. A separate local
candidate is retained only for a successful result matching the exact preceding
`view_image` call, call ID and agent; failed/mismatched calls cannot authorize it.
Image bytes are omitted from portable conversation text and tool output. When a
completion timestamp is available, local fallback refuses a file modified more
than one second after that completion. A previously captured copy stays bound to
the original result even when the path is overwritten later. Without source bytes
or reliable timestamps, a local file copy is not certified as the historical
native-app rendition.

The observation host materializes these candidates. Local fallback is restricted
to the source project's root or the configured system temporary root. Lexical
traversal, credential names, unsupported protocols, symlink components and changed
file identities are refused. Real canonical aliases of an admitted root, including
the system temporary root on macOS, remain usable. Open file handles, bounded reads,
stable metadata and post-read path checks defend against ordinary changes. These
host filesystem checks do not provide an OS sandbox against a hostile local process
coordinating directory replacement; observation consent and the selected native
source remain the authority boundary.

Only validated PNG, JPEG, WebP and GIF bytes are admitted. Each image is limited
to 5 MiB, 16,384 pixels on either edge and forty million pixels. The private session
store admits at most 128 files / 64 MiB, with bounded durable source bindings and
negative attempts. Existing unadmitted legacy blobs count against the quota; knowing
their hash alone does not grant delivery. Corrupt indexes fail closed for media
without suppressing conversation text. Metadata commits atomically, and failed
admissions do not become in-memory authority. Source fingerprints avoid charging
already admitted images again; bounded batches resume on subsequent observation
polls even when the source itself has not changed.

Private copies live below the host data directory's `observed-files/<session-id>`.
Only `attachmentPreview` for that observed session resolves a reference. Delivery
checks manifest membership, supported image dimensions, bounded size and the actual
content hash. Privacy/session membership is rechecked after awaited reads. Labels-only
observation does not capture or serve images. No renderer-selected source path is
accepted and no image is sent to a model by this feature.

## Live projection and display

Transcript media enriches only the matching successful hook completion; it retains
that hook's identity instead of creating another tool row. Source media changes
affect the observation revision. The shared session event feed subscribes before
reading history and serializes/coalesces authoritative refreshes on update hints.
A hint forms a generation boundary: superseded responses and pre-hint buffered
events cannot restore obsolete private media. Refresh failure clears obsolete
history rather than retaining potentially redacted content.

The shared projection keeps tool attachments on the matching call and caps worker
previews inside their existing worker card. Actual captured images open a tool run
by default, while later manual folding remains authoritative. Thumbnails render
outside the text-output disclosure. Missing/unavailable content shows its literal
filename and a localized unavailable label.

One shared visibility observer loads nearby previews. Each view/session uses a
bounded leased cache, with one decode lane. Passive display uses an aspect-preserving
PNG rendition of at most 192 pixels, and temporary image bitmaps close after drawing.
Compressed originals are retained within the byte budget but acquire an original
display URL only on explicit viewing. Original and thumbnail leases release their
URLs independently; leaving the viewport, folding a run, changing session or closing
the dialog releases the relevant resources. A browser without the rendition APIs
uses a stricter four-preview fallback cap. Transient source-decode peak and whole-app
memory were not measured.

The full-image dialog contains focus, isolates the background, supports Escape and
restores focus. The same component serves prompt, tool and worker attachments in
Chat, Observe and Office conversations. It never infers a local/remote image URL
from Markdown, a tool label, output text or a target string.

## Verification scope

Tests use synthetic native transcripts, temporary data/project/temp roots and
private copies. They cover call matching, inline forms, refusal cases, quota/index
failure, restart after original-file deletion, unchanged-history progress, hook
hydration, privacy/deletion races, event refresh generations and display leases.
Browser checks use actual shared components with a synthetic host in English and
Indonesian, light/dark, desktop/phone. They verify late images, manual folding,
keyboard dialogs, lazy loading, original resolution and resource release.
No live native conversation, real profile, remote image fetch or provider call
belongs to this verification. The release tracker records final gate evidence.
