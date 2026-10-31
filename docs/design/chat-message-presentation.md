# Chat message presentation

Chat and the Office character conversation share `TranscriptView`.
User messages use the existing safe Markdown renderer: HTTP(S) links are
clickable, code stays literal, and HTML is never executed.

`presentUserMessage` recognizes complete Codex attachment envelopes, including
leading/variable blank lines and CRLF exports, and
standalone `send_user_message_question_reply` records for display. Attachment
metadata becomes file chips; replies show each question next to its actual
answer. Unknown, malformed, quoted, fenced or oversized formats remain text.
Source messages, saved events and model history are unchanged.

Attachment identity includes the source path so equal filenames in different
folders are retained. Host attachment metadata is matched one-to-one and keeps
its size/reference. A textual path never becomes an image URL or a filesystem
read automatically. Cached image previews still require a private copy supplied
by the host. Clicking a file chip or local Markdown link opens a read-only
preview through the existing workspace `readFile` API. Relative links use the
session's working directory inside its registered root. The host retains its
credential, symlink, size and binary checks.

Paths outside registered scope and metadata-only attachments offer an explicit
local file chooser. A selected file is previewed only in the browser/renderer,
never uploaded to the agent. Text is bounded to 512 KiB; supported raster
images to 8 MiB. SVG and unsupported binary data are not executed. Literal
attachment/root paths stay literal; only Markdown destinations lose supported
raw line annotations and decode URI escapes once.

The shared user-message component is used in Chat, Office and imported History.
Observe prefers the same protocol transcript as Chat, including for hook-only
sessions without a portable snapshot, and retains portable history as fallback.
All use a consistent 14px reading font and relative Markdown heading sizes.
Complete task notifications and context-compaction wrappers become collapsed
neutral source cards with the original text available. Claude notifications
retain optional result text in a separate task-result section without changing
the source status. They are display data,
not fresh user requests or executable instructions.

Preview dialogs trap focus and isolate background controls while preserving
existing inert states. Closing restores focus; session/scope/host changes
invalidate pending preview results and release image URLs.

Native approval cards show the actual once/session/reject choices as numbered
buttons. A synchronous lock prevents repeated submissions. Failed delivery
allows retry; successful delivery waits for the host's resolution before
showing an outcome. Controls are enabled explicitly only for actionable
managed sessions. Observed sessions keep their source application's controls.

`approval.resolved.choice` optionally retains the native user's exact selection
for history display. It grants no execution authority. Legacy records show
their existing outcome without inventing scope; contradictory/policy choice
metadata is ignored. Aborted requests and callback failures do not invent a
Deny click. TypeScript, generated schemas and the Rust event-body validator
accept the same optional enum.

This update formats historical question replies. It does not add a native
question tool or a new question/approval control bridge for observed runtimes.
