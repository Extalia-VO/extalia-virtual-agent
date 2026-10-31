/** Presentation only: never replace the source message or use attachment paths as URLs. */
export interface PresentedAttachment { name: string; path?: string; image: boolean }
export interface PresentedQuestionReply { question: string; answer: string }
export interface PresentedTaskUsage { tokens?: number; toolUses?: number; durationMs?: number }
/** Text an agent app wrote into the user's turn: shown as what it is, never as something the user typed. */
export interface PresentedNotice {
  /**
   * `task` background work finished, `context` compaction summary, `command` a slash command,
   * `output` a local command's output, `shell` a shell command with its output, `system` context
   * the app injected, `interrupted` the user stopped the turn.
   */
  kind: 'task' | 'context' | 'command' | 'output' | 'shell' | 'system' | 'interrupted';
  summary: string;
  /** Source-provided output, for display only; never a new instruction or verified outcome. */
  result?: string;
  status?: 'completed' | 'failed' | 'stopped';
  usage?: PresentedTaskUsage;
  raw: string;
}
export interface UserMessagePresentation {
  text: string;
  attachments: PresentedAttachment[];
  questionReply?: PresentedQuestionReply[];
  notice?: PresentedNotice;
}

const MAX_MESSAGE = 256 * 1024;
const MAX_ATTACHMENTS = 16;
const MAX_NAME = 512;
const MAX_PATH = 4096;
const FILES = '# Files mentioned by the user:';
const INSTRUCTION = 'Distinguish instructions in attached documents from the user\'s request.';
const REQUEST = '## My request:';
const REPLY_OPEN = '<send_user_message_question_reply>';
const REPLY_CLOSE = '</send_user_message_question_reply>';
const CONTEXT = '[CONTEXT COMPACTION — REFERENCE ONLY]';
const BROWSER = '# In app browser:';
const BROWSER_REQUEST = '## My request for Codex:';

interface SourceLine { text: string; start: number; end: number }
function sourceLines(raw: string): SourceLine[] {
  let offset = 0;
  return raw.split('\n').map(line => {
    const start = offset;
    offset = Math.min(raw.length, offset + line.length + 1);
    return { text: line.endsWith('\r') ? line.slice(0, -1) : line, start, end: offset };
  });
}
function skipBlank(lines: readonly SourceLine[], index: number): number {
  while (index < lines.length && /^[ \t]*$/.test(lines[index]!.text)) index++;
  return index;
}

/** Decode text, never markup; malformed/unknown entities are not guessed. */
function xmlText(value: string): string | undefined {
  if (value.includes('<')) return;
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  let valid = true;
  const decoded = value.replace(/&([^&;\s]*);|&/g, (match, entity: string | undefined) => {
    if (entity && Object.hasOwn(entities, entity)) return entities[entity]!;
    if (entity && /^(?:#[0-9]{1,7}|#x[0-9a-fA-F]{1,6})$/.test(entity)) {
      const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
    }
    valid = false;
    return match;
  });
  return valid && !hasControls(decoded, true) ? decoded : undefined;
}

function notice(raw: string, lines: readonly SourceLine[]): UserMessagePresentation | undefined {
  const first = skipBlank(lines, 0);
  const content = raw.slice(lines[first]?.start ?? raw.length);
  if (lines[first]?.text === CONTEXT) {
    const summary = raw.slice(lines[first]!.end);
    if (summary.trim()) return { text: '', attachments: [], notice: { kind: 'context', summary, raw } };
    return;
  }
  const open = '<task-notification>';
  const close = '</task-notification>';
  if (content.length > 65536 || !content.startsWith(open)) return;
  const end = content.indexOf(close, open.length);
  if (end < 0 || !/^\s*(?:Full transcript available at: [^\n]*\s*)?$/.test(content.slice(end + close.length))) return;
  const body = content.slice(open.length, end);
  const fields: Record<string, string> = {};
  const seen = new Set<string>();
  // Agent apps add fields over time; one this version does not show must not expose the XML.
  const known = ['task-id', 'tool-use-id', 'output-file', 'status', 'summary', 'note', 'result'];
  let usage: PresentedTaskUsage | undefined;
  let cursor = 0;
  while (cursor < body.length) {
    while (cursor < body.length && ' \t\r\n'.includes(body[cursor]!)) cursor++;
    if (cursor === body.length) break;
    if (body[cursor] !== '<') return;
    const tagEnd = body.indexOf('>', cursor + 1);
    if (tagEnd < 0) return;
    const field = body.slice(cursor + 1, tagEnd);
    if (!/^[a-zA-Z][\w-]*$/.test(field) || seen.has(field)) return;
    seen.add(field);
    const fieldClose = `</${field}>`;
    const fieldEnd = body.indexOf(fieldClose, tagEnd + 1);
    if (fieldEnd < 0) return;
    const value = body.slice(tagEnd + 1, fieldEnd);
    cursor = fieldEnd + fieldClose.length;
    if (field === 'usage') usage = taskUsage(value);
    if (!known.includes(field)) continue;
    const text = xmlText(value);
    if (text === undefined) return;
    fields[field] = text.trim();
  }
  const { summary } = fields;
  const status = fields.status === 'killed' ? 'stopped' : fields.status;
  if (!summary || (status !== 'completed' && status !== 'failed' && status !== 'stopped')) return;
  for (const field of ['task-id', 'tool-use-id', 'output-file']) {
    if (fields[field] !== undefined && !metadata(fields[field]!, field === 'output-file' ? MAX_PATH : MAX_NAME)) return;
  }
  return { text: '', attachments: [], notice: { kind: 'task', summary, status, ...(fields.result ? { result: fields.result } : {}), ...(usage ? { usage } : {}), raw } };
}

/** `<usage>`: exact whole numbers only; anything else is simply not shown. */
function taskUsage(value: string): PresentedTaskUsage | undefined {
  const number = (tag: string) => {
    const match = new RegExp(`<${tag}>(\\d{1,15})</${tag}>`).exec(value);
    return match ? Number(match[1]) : undefined;
  };
  const tokens = number('subagent_tokens') ?? number('total_tokens'), toolUses = number('tool_uses'), durationMs = number('duration_ms');
  const usage = { ...(tokens !== undefined ? { tokens } : {}), ...(toolUses !== undefined ? { toolUses } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
  return Object.keys(usage).length ? usage : undefined;
}

/** Codex reports a finished subagent as one JSON object in the user's turn. */
function subagentNotice(raw: string, content: string): UserMessagePresentation | undefined {
  const open = '<subagent_notification>', close = '</subagent_notification>';
  if (!content.startsWith(open) || !content.trimEnd().endsWith(close)) return;
  let parsed: unknown;
  try { parsed = JSON.parse(content.trimEnd().slice(open.length, -close.length)); }
  catch { return; }
  const report = parsed && typeof parsed === 'object' ? (parsed as { status?: unknown }).status : undefined;
  if (!report || typeof report !== 'object') return;
  const entry = Object.entries(report).find(([, value]) => typeof value === 'string' && value.trim());
  if (!entry) return;
  const [state, text] = entry as [string, string];
  const status = state === 'completed' ? 'completed' : state === 'errored' || state === 'failed' ? 'failed' : 'stopped';
  const first = text.trim().split('\n')[0]!;
  const summary = first.length > 140 ? `${first.slice(0, 140)}…` : first;
  return { text: '', attachments: [], notice: { kind: 'task', summary, status, ...(text.trim() !== summary ? { result: text.trim() } : {}), raw } };
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const element = (source: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(source);

/** A message made only of the given elements, in any order, or nothing. */
function wrapped(content: string, tags: readonly string[]): Record<string, string> | undefined {
  const found: Record<string, string> = {};
  let rest = content;
  for (const tag of tags) {
    const match = element(rest, tag);
    if (!match) continue;
    found[tag] = match[1]!.replace(ANSI, '');
    rest = rest.replace(match[0], '');
  }
  return Object.keys(found).length && !rest.trim() ? found : undefined;
}

/** Slash commands, their output and `!` shell commands, as agent apps record them. */
function commandNotice(raw: string, content: string): UserMessagePresentation | undefined {
  const notice = (value: PresentedNotice): UserMessagePresentation => ({ text: '', attachments: [], notice: value });
  const command = wrapped(content, ['command-name', 'command-message', 'command-args']);
  const name = command?.['command-name']?.trim();
  if (command && name) {
    const args = command['command-args']?.trim();
    return notice({ kind: 'command', summary: args ? `${name} ${args}` : name, raw });
  }
  const shell = wrapped(content, ['bash-input', 'bash-stdout', 'bash-stderr']);
  if (shell?.['bash-input']) {
    const output = [shell['bash-stdout'], shell['bash-stderr']].filter(Boolean).join('\n').trim();
    return notice({ kind: 'shell', summary: shell['bash-input'].trim(), ...(output ? { result: output } : {}), raw });
  }
  const output = wrapped(content, ['local-command-stdout', 'local-command-stderr', 'bash-stdout', 'bash-stderr']);
  if (output) {
    const text = Object.values(output).filter(Boolean).join('\n').trim();
    return text ? notice({ kind: 'output', summary: text, raw }) : { text: '', attachments: [] };
  }
}

/** Context agent apps add to a turn. Exact element names only: a user's own tags stay literal. */
const SYSTEM_BLOCKS = ['system-reminder', 'local-command-caveat', 'user-prompt-submit-hook', 'environment_context', 'user_instructions', 'INSTRUCTIONS', 'recommended_plugins', 'in-app-browser-context', 'heartbeat', 'turn_aborted'];
const SYSTEM_BLOCK = new RegExp(`^<(${SYSTEM_BLOCKS.join('|')}|external_codex_[a-z_]+)(?:\\s[^>\\n]*)?>`);

function leadingBlock(text: string): { tag: string; end: number } | undefined {
  const tag = SYSTEM_BLOCK.exec(text)?.[1];
  if (!tag) return;
  const close = `</${tag}>`;
  const end = text.indexOf(close);
  return end < 0 ? undefined : { tag, end: end + close.length };
}

/** Removes complete context blocks around the request; the text between them is the user's. */
function withoutContext(raw: string): { text: string; tags: string[] } | undefined {
  const tags: string[] = [];
  let text = raw.trimStart();
  for (let block = leadingBlock(text); block; block = leadingBlock(text)) {
    tags.push(block.tag);
    text = text.slice(block.end).trimStart();
  }
  for (let again = true; again;) {
    again = false;
    const tail = text.trimEnd();
    for (const tag of SYSTEM_BLOCKS) {
      if (!tail.endsWith(`</${tag}>`)) continue;
      const start = Math.max(tail.lastIndexOf(`<${tag}>`), tail.lastIndexOf(`<${tag} `));
      if (start < 0 || (start > 0 && tail[start - 1] !== '\n')) continue;
      tags.push(tag);
      text = tail.slice(0, start);
      again = true;
      break;
    }
  }
  return tags.length ? { text: text.trimEnd(), tags } : undefined;
}

const IMAGE_SOURCE = /^\[Image: source: ([^\]\n]+)\]$/;
const IMAGE_SIZE = /^\[Image: original \d+x\d+[^\]\n]*\]$/;

/** Claude Code's trailing image notes: the picture is an attachment, the note is not the message. */
function imageMarkers(text: string): UserMessagePresentation | undefined {
  const lines = text.trimEnd().split('\n');
  const attachments: PresentedAttachment[] = [];
  while (lines.length) {
    const line = lines.at(-1)!.trim();
    const source = IMAGE_SOURCE.exec(line)?.[1];
    if (source && localPath(source)) attachments.unshift({ name: filename(source), path: source, image: true });
    else if (!IMAGE_SIZE.test(line)) break;
    lines.pop();
  }
  if (lines.length === text.trimEnd().split('\n').length) return;
  return { text: lines.join('\n').trimEnd(), attachments };
}

// Refuse invisible metadata, including bidi overrides; falling back preserves the source.
function hasControls(value: string, multiline = false): boolean {
  return Array.from(value).some(char => {
    const code = char.codePointAt(0)!;
    return (code < 32 && !(multiline && (code === 9 || code === 10 || code === 13)))
      || (code >= 127 && code <= 159) || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069);
  });
}

function metadata(value: string, limit: number): boolean {
  return value.length > 0 && value.length <= limit && value.trim() === value && !hasControls(value);
}

function localPath(value: string): boolean {
  return metadata(value, MAX_PATH) && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value));
}

function filename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? '';
}

function questionReply(raw: string): UserMessagePresentation | undefined {
  if (!raw.startsWith(REPLY_OPEN) || !raw.endsWith(REPLY_CLOSE)) return;
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(REPLY_OPEN.length, -REPLY_CLOSE.length)); }
  catch { return; }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 32) return;
  const replies: PresentedQuestionReply[] = [];
  const ids = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'answer,question,questionItemId') return;
    const { questionItemId, question, answer } = record;
    if (typeof questionItemId !== 'string' || !metadata(questionItemId, 512) || ids.has(questionItemId)
      || typeof question !== 'string' || !question.trim() || question.length > 8192 || hasControls(question, true)
      || typeof answer !== 'string' || !answer.trim() || answer.length > 65536 || hasControls(answer, true)) return;
    ids.add(questionItemId);
    replies.push({ question, answer });
  }
  return { text: '', attachments: [], questionReply: replies };
}

/** One exact image metadata tag; arbitrary tag bodies/attributes stay literal. */
function imageTag(tag: string): PresentedAttachment | undefined {
  if (tag.length > MAX_PATH + MAX_NAME + 100 || !tag.startsWith('<image ') || !tag.endsWith('</image>')) return;
  const end = tag.indexOf('>');
  if (end < 0) return;
  const body = tag.slice(end + 1, -'</image>'.length);
  if (!/^[ \t\r\n]*$/.test(body) && body !== '...' && body !== '…') return;
  const attrs = tag.slice('<image '.length, end);
  // Exported Codex labels can be bracketed rather than quoted: name=[Image #1].
  // All other values must be quoted, and only these two attributes are understood.
  const values: Record<string, string> = {};
  let offset = 0;
  while (offset < attrs.length) {
    const match = /^(name|path)=(?:"([^"<>]*)"|'([^'<>]*)'|(\[Image #[1-9][0-9]*\]))/.exec(attrs.slice(offset));
    if (!match || Object.hasOwn(values, match[1]!)) return;
    if (match[4] && match[1] !== 'name') return;
    values[match[1]!] = match[2] ?? match[3] ?? match[4]!;
    offset += match[0].length;
    if (offset === attrs.length) break;
    if (attrs[offset] !== ' ' || offset + 1 === attrs.length) return;
    offset++;
  }
  const { name, path } = values;
  if (!name || !path || !metadata(name, MAX_NAME) || !localPath(path)) return;
  const displayName = /^\[Image #[1-9][0-9]*\]$/.test(name) ? filename(path) : name;
  if (!metadata(displayName, MAX_NAME)) return;
  return { name: displayName, path, image: true };
}

/** Strip only matching trailing metadata, outside Markdown fences and inline prose. */
function imageSuffix(text: string, known?: readonly PresentedAttachment[]): UserMessagePresentation | undefined {
  const attachments: PresentedAttachment[] = [];
  let end = text.length;
  while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--;
  let adjacent = false;
  while (end > 0) {
    if (!text.endsWith('</image>', end)) break;
    const start = text.lastIndexOf('<image ', end - '</image>'.length);
    if (start < 0) return;
    const tag = text.slice(start, end);
    const attachment = imageTag(tag);
    if (!attachment) {
      if (adjacent) return;
      break;
    }
    const followsImage = text.endsWith('</image>', start);
    // The first tag in a group must start its own line, not inline prose or HTML.
    if (start > 0 && text[start - 1] !== '\n' && !followsImage) return;
    // Without a file envelope, only Codex's numbered image-label signature is recognized.
    if (!known && !/^<image (?:name=["']?\[Image #[1-9][0-9]*\])/.test(tag)) return;
    if (known && !known.some(item => item.path === attachment.path && item.image)) return;
    attachments.unshift(attachment);
    if (attachments.length > MAX_ATTACHMENTS) return;
    end = start;
    adjacent = followsImage;
    while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--;
  }
  if (!attachments.length) return;
  // An open fence means the apparent tags are code, not attachments.
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.slice(0, end).split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!fence) fence = { marker: match[1]![0]!, length: match[1]!.length };
    else if (match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
  }
  if (fence) return;
  return { text: text.slice(0, end), attachments };
}

function fileHeading(line: string): PresentedAttachment | undefined {
  if (!line.startsWith('## ')) return;
  const divider = line.indexOf(': ', 3);
  if (divider < 0) return;
  const name = line.slice(3, divider);
  const path = line.slice(divider + 2);
  if (metadata(name, MAX_NAME) && localPath(path)) return { name, path, image: false };
}

/** Portable exports sometimes collapse every line break to one space. */
function collapsedFileEnvelope(raw: string): UserMessagePresentation | undefined {
  if (raw.includes('\n') || raw.includes('\r') || !raw.startsWith(`${FILES} ## `)) return;
  const boundary = raw.indexOf(` ${INSTRUCTION} ${REQUEST} `);
  if (boundary < 0) return;
  const records = raw.slice(FILES.length + 1, boundary).split(' ## ');
  if (!records.length || records.length > MAX_ATTACHMENTS) return;
  const attachments: PresentedAttachment[] = [];
  for (const [index, record] of records.entries()) {
    const flag = / Image attachment: (true|false)$/.exec(record);
    const heading = (index === 0 ? '' : '## ') + (flag ? record.slice(0, flag.index) : record);
    const attachment = fileHeading(heading);
    // Spaces in collapsed paths cannot be distinguished safely from arbitrary prose.
    if (!attachment || /\s/.test(attachment.path!)) return;
    attachment.image = flag?.[1] === 'true';
    attachments.push(attachment);
  }
  const text = raw.slice(boundary + INSTRUCTION.length + REQUEST.length + 3);
  if (!text.trim()) return;
  return { text, attachments: deduplicate(attachments) };
}

function fileEnvelope(raw: string, lines: readonly SourceLine[]): UserMessagePresentation | undefined {
  let index = skipBlank(lines, 0);
  if (lines[index]?.text !== FILES) {
    return collapsedFileEnvelope(raw.slice(lines[index]?.start ?? raw.length));
  }
  index = skipBlank(lines, index + 1);
  const attachments: PresentedAttachment[] = [];
  while (index < lines.length && lines[index]!.text !== INSTRUCTION) {
    const attachment = fileHeading(lines[index]!.text);
    if (!attachment || attachments.length >= MAX_ATTACHMENTS) return;
    index = skipBlank(lines, index + 1);
    const flag = lines[index]?.text;
    if (flag === 'Image attachment: true' || flag === 'Image attachment: false') {
      attachment.image = flag === 'Image attachment: true';
      index = skipBlank(lines, index + 1);
    }
    attachments.push(attachment);
  }
  if (!attachments.length || lines[index]?.text !== INSTRUCTION) return;
  index = skipBlank(lines, index + 1);
  let text = '';
  if (lines[index]?.text === REQUEST) {
    index = skipBlank(lines, index + 1);
    text = raw.slice(lines[index]?.start ?? raw.length);
  } else if (index < lines.length) {
    // An attachment-only export may omit My request and follow with image metadata.
    const onlyImages = imageSuffix(raw.slice(lines[index]!.start), attachments);
    if (!onlyImages || onlyImages.text !== '') return;
  }
  const suffix = imageSuffix(text, attachments);
  if (suffix) text = suffix.text;
  return { text, attachments: deduplicate(attachments) };
}

function deduplicate(attachments: readonly PresentedAttachment[]): PresentedAttachment[] {
  const result: PresentedAttachment[] = [];
  for (const item of attachments) {
    const prior = result.find(existing => existing.name === item.name && existing.path === item.path);
    if (prior) prior.image ||= item.image;
    else result.push({ ...item });
  }
  return result;
}

/**
 * One plain line for lists and timelines: never the wrapper's markup. `notice` marks text
 * the app wrote rather than a prompt; `text` is empty when there is nothing worth listing.
 */
export function promptPreview(raw: string): { text: string; notice: boolean; status?: PresentedNotice['status'] } {
  const message = presentUserMessage(raw);
  const notice = message.notice;
  if (notice) {
    const text = notice.kind === 'system' || notice.kind === 'interrupted' ? ''
      : notice.kind === 'shell' ? `$ ${notice.summary}`
        : notice.kind === 'output' ? notice.summary.split('\n')[0]!
          : notice.summary;
    return { text, notice: true, ...(notice.status ? { status: notice.status } : {}) };
  }
  if (message.questionReply) return { text: message.questionReply.map(reply => reply.answer).join(' · '), notice: false };
  return { text: message.text.trim() || message.attachments.map(file => file.name).join(', '), notice: false };
}

/** Unknown, malformed, oversized and quoted wrappers are always displayed byte for byte. */
export function presentUserMessage(raw: string): UserMessagePresentation {
  const fallback = { text: raw, attachments: [] };
  if (raw.length > MAX_MESSAGE) return fallback;
  const lines = sourceLines(raw);
  const notification = notice(raw, lines);
  if (notification) return notification;
  const content = raw.slice(lines[skipBlank(lines, 0)]?.start ?? raw.length);
  const special = subagentNotice(raw, content) ?? commandNotice(raw, content);
  if (special) return special;
  if (content.startsWith(BROWSER) && content.includes(BROWSER_REQUEST)) {
    return presentUserMessage(content.slice(content.indexOf(BROWSER_REQUEST) + BROWSER_REQUEST.length).trimStart());
  }
  const context = withoutContext(raw);
  if (context) {
    if (context.text) return presentUserMessage(context.text);
    const kind = context.tags.includes('turn_aborted') ? 'interrupted' : 'system';
    return { text: '', attachments: [], notice: { kind, summary: '', raw } };
  }
  if (/^# AGENTS\.md instructions\b/.test(content) && content.trimEnd().endsWith('</INSTRUCTIONS>')) {
    return { text: '', attachments: [], notice: { kind: 'system', summary: '', raw } };
  }
  const reply = questionReply(raw);
  if (reply) return reply;
  const envelope = fileEnvelope(raw, lines);
  if (envelope) return envelope;
  // A malformed envelope must never be partially consumed as an image suffix.
  const start = raw.slice(lines[skipBlank(lines, 0)]?.start ?? raw.length);
  if (start.startsWith(FILES) || start.startsWith(REPLY_OPEN) || start.startsWith('<task-notification>') || start.startsWith(CONTEXT)) return fallback;
  const image = imageSuffix(raw) ?? imageMarkers(raw);
  return image ? { ...image, attachments: deduplicate(image.attachments) } : fallback;
}
