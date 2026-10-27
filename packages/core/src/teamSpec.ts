import { generateFullName, type MemberGender } from './names.js';
import {
  decodeAgentTeam, MAX_MEMBER_MODELS, MAX_MEMBER_NAME, MAX_MEMBER_PATHS, MAX_MEMBER_ROLE, MAX_MEMBER_SOUL, MAX_MEMBER_TASK, MAX_TEAM_GOAL, MAX_TEAM_MODELS,
  MAX_TEAM_RULE, MAX_TEAM_RULES, newTeamMemberId, normalizeMemberPath, TEAM_MODEL_PATTERN, type AgentTeam, type MemberAccess, type TeamMember,
} from './teams.js';

/**
 * Subagent teams written into a prompt. Two shapes are understood, with field
 * labels in English or Indonesian:
 *
 * ```
 * Subagent A:
 * - Name: …            (Nama)
 * - Gender: female     (perempuan / male / laki-laki)
 * - Role: …            (Peran)
 * - Model: a, b        (ordered fallback chain)
 * - Soul: "…"          (Persona)
 * - Tugas: …           (Task)
 * - Batasan: …         (Constraints: paths never to edit; Scope / Lingkup: paths it may edit)
 * ```
 *
 * and a template with `### TARGET PROYEK`, `### MATRIKS SUBAGENT` holding
 * `#### Subagent 1: Name` blocks, and `### ATURAN EKSEKUSI`. Parsing is
 * tolerant: unknown lines are kept as part of the field above them, and a
 * member without a name gets a generated one when the spec is applied.
 */
export interface TeamSpec {
  /** `name` is empty when the spec gives none (a name is generated on apply). */
  members: Omit<TeamMember, 'id'>[];
  goal?: string;
  rules?: string[];
}

/** Role used when a member block names none. */
export const DEFAULT_SPEC_ROLE = 'Subagent';

type Field = 'name' | 'gender' | 'role' | 'models' | 'soul' | 'task' | 'forbidden' | 'scope' | 'access';

const LABELS: Record<string, Field> = {
  name: 'name', nama: 'name', 'full name': 'name', 'nama lengkap': 'name',
  gender: 'gender', 'jenis kelamin': 'gender', kelamin: 'gender', sex: 'gender',
  role: 'role', peran: 'role', jabatan: 'role', posisi: 'role', position: 'role',
  model: 'models', models: 'models', 'model chain': 'models', 'model order': 'models', llm: 'models', 'urutan model': 'models',
  soul: 'soul', persona: 'soul', personality: 'soul', kepribadian: 'soul', karakter: 'soul', character: 'soul', principles: 'soul', prinsip: 'soul',
  tugas: 'task', task: 'task', tasks: 'task', job: 'task', pekerjaan: 'task', responsibility: 'task', 'tanggung jawab': 'task', assignment: 'task',
  batasan: 'forbidden', constraints: 'forbidden', constraint: 'forbidden', forbidden: 'forbidden', larangan: 'forbidden', dilarang: 'forbidden',
  restrictions: 'forbidden', 'do not edit': 'forbidden', "don't edit": 'forbidden', 'jangan edit': 'forbidden', 'jangan ubah': 'forbidden',
  scope: 'scope', lingkup: 'scope', 'ruang lingkup': 'scope', files: 'scope', paths: 'scope', 'allowed paths': 'scope', area: 'scope', 'boleh edit': 'scope',
  access: 'access', akses: 'access', 'hak akses': 'access', mode: 'access', permission: 'access', permissions: 'access', izin: 'access',
};

const GOAL_SECTIONS = ['target proyek', 'target project', 'project target', 'target', 'goal', 'goals', 'tujuan', 'objective', 'mission', 'misi', 'sasaran'];
const RULE_SECTIONS = ['aturan eksekusi', 'aturan', 'aturan main', 'rules', 'execution rules', 'guidelines', 'protokol eksekusi', 'protocol'];

const MEMBER_HEADING = /^(?:sub[\s-]?agents?|subagen|anggota(?:\s+tim)?|team\s+member|member)\s*([A-Za-z0-9]{1,12})?\s*(?:[:.)\-–—]\s*(.*))?$/i;
const FIELD_LINE = /^([A-Za-z][A-Za-z' /]{0,30}?)\s*[:：]\s*(.*)$/;
const BULLET = /^(?:[-*•+]|\d{1,2}[.)])\s+/;
const EDIT_VERBS = /\b(buat(?:kan)?|bikin|tambah(?:kan)?|ubah|edit|implement(?:asikan|kan)?|create|add|write|tulis|fix|perbaiki|refactor|update|perbarui|hapus|delete|remove|build|bangun|migrate|migrasi|ganti|replace|rename)\b/i;
const MODEL_FILLER = new Set(['fallback', 'then', 'lalu', 'dan', 'and', 'or', 'atau', 'primary', 'utama', 'cadangan', 'backup', 'kemudian']);
const PATH_STOPWORDS = new Set(['e.g', 'i.e', 'etc', 'dll', 'dsb', 'misal', 'contoh']);

/** Markdown bold pairs removed; a glob such as `src/**` is kept. */
const clean = (value: string) => value.replace(/(?<![/\w*])\*\*(?=\S)(.+?)(?<=[^\s/*])\*\*(?![\w*])/g, '$1').trim();

function unquote(value: string): string {
  let result = value.trim();
  for (;;) {
    const match = /^(["'“‘`])([\s\S]*)(["'”’`])$/.exec(result);
    if (!match || match[2] === undefined) return result;
    result = match[2].trim();
  }
}

/** A value that is only a template placeholder such as `[Name]`. */
const isPlaceholder = (value: string) => /^\[[^\]]*\]$/.test(value.trim()) || /^<[^>]*>$/.test(value.trim());

function labelField(label: string): Field | undefined {
  const key = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (LABELS[key]) return LABELS[key];
  // "Soul / Persona", "Batasan / Constraints"
  for (const part of key.split('/')) { const field = LABELS[part.trim()]; if (field) return field; }
  return undefined;
}

function sectionKind(title: string): 'goal' | 'rules' | 'other' {
  const key = title.toLowerCase().replace(/[:#*_]/g, '').replace(/\s+/g, ' ').trim();
  if (GOAL_SECTIONS.includes(key)) return 'goal';
  if (RULE_SECTIONS.includes(key)) return 'rules';
  return 'other';
}

function parseGender(value: string): MemberGender | undefined {
  const key = value.toLowerCase().replace(/[^a-z-\s]/g, ' ').trim().split(/\s+/)[0] ?? '';
  if (['female', 'f', 'perempuan', 'wanita', 'woman', 'cewek', 'she', 'her'].includes(key)) return 'female';
  if (['male', 'm', 'laki-laki', 'laki', 'pria', 'man', 'cowok', 'he', 'him'].includes(key)) return 'male';
  return undefined;
}

function parseAccess(value: string): MemberAccess | undefined {
  const key = value.toLowerCase();
  if (/\b(read[\s-]?only|readonly|baca(?:\s+saja)?|read)\b/.test(key) && !/\b(write|tulis|edit|read[\s-]?write)\b/.test(key)) return 'read';
  if (/\b(write|tulis|edit|read[\s-]?write|rw)\b/.test(key)) return 'write';
  return undefined;
}

function parseModels(value: string): string[] {
  const models: string[] = [];
  for (const raw of value.replace(/[()[\]{}"'`“”]/g, ' ').split(/[\s,;|]+|->|→|=>/)) {
    const token = raw.replace(/[.,:]+$/, '');
    if (!token || MODEL_FILLER.has(token.toLowerCase().replace(/:$/, '')) || !TEAM_MODEL_PATTERN.test(token) || models.includes(token)) continue;
    models.push(token);
  }
  return models.slice(0, MAX_MEMBER_MODELS);
}

/** Workspace-relative paths mentioned in a value, and whether prose remains around them. */
function parsePaths(value: string): { paths: string[]; prose: boolean } {
  const paths: string[] = [];
  let words = 0;
  for (const raw of value.split(/[\s,;]+/)) {
    const token = raw.replace(/^[("'“‘`[]+/, '').replace(/[)"'”’`\]]+$/, '').replace(/[.,:;!?]+$/, '');
    if (!token) continue;
    const pathLike = /^[A-Za-z0-9_.*@\-/][A-Za-z0-9_.*@\-/]*$/.test(token) && !token.includes('://')
      && (token.includes('/') || token.includes('*') || /\.[A-Za-z0-9]{1,8}$/.test(token)) && !PATH_STOPWORDS.has(token.toLowerCase());
    if (pathLike) {
      try {
        const normalized = normalizeMemberPath(token);
        if (!paths.includes(normalized) && paths.length < MAX_MEMBER_PATHS) paths.push(normalized);
        continue;
      } catch { /* not usable as a workspace path: kept as prose */ }
    }
    if (/[A-Za-z]{2,}/.test(token)) words++;
  }
  return { paths, prose: words > 0 };
}

const bound = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);
const singleLine = (value: string) => value.replace(/\s+/g, ' ').trim();

interface Block { heading: string; fields: Partial<Record<Field, string>>; order: Field[] }

function toMember(block: Block): Omit<TeamMember, 'id'> | undefined {
  const value = (field: Field) => {
    const raw = block.fields[field];
    if (raw === undefined) return '';
    const text = unquote(raw.trim());
    return isPlaceholder(text) ? '' : text;
  };
  // "Subagent 1: Elena Vael (Backend Engineer)": the heading may carry the name and a role.
  let headingName = unquote(block.heading.trim());
  let headingRole = '';
  const parenthetical = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(headingName);
  if (parenthetical) { headingName = parenthetical[1]!.trim(); headingRole = parenthetical[2]!.trim(); }
  if (isPlaceholder(headingName)) headingName = '';
  const name = bound(singleLine(value('name') || headingName), MAX_MEMBER_NAME);
  const role = bound(singleLine(value('role') || headingRole), MAX_MEMBER_ROLE) || DEFAULT_SPEC_ROLE;
  const gender = parseGender(value('gender'));
  const models = parseModels(value('models'));
  const soul = bound(value('soul').replace(/[ \t]+/g, ' ').trim(), MAX_MEMBER_SOUL);
  let task = value('task').replace(/[ \t]+/g, ' ').trim();
  const forbiddenText = value('forbidden');
  const forbidden = parsePaths(forbiddenText);
  const scope = parsePaths(value('scope'));
  // Constraints written as sentences stay with the task, so the member still reads them.
  if (forbiddenText && forbidden.prose) task = `${task}${task ? '\n' : ''}Constraints: ${singleLine(forbiddenText)}`;
  task = bound(task, MAX_MEMBER_TASK);
  if (!name && !block.order.length) return undefined;
  const explicit = parseAccess(value('access'));
  const access: MemberAccess = explicit ?? (scope.paths.length || forbidden.paths.length || EDIT_VERBS.test(value('task')) ? 'write' : 'read');
  return {
    name, ...(gender ? { gender } : {}), role, ...(task ? { task } : {}), models, ...(soul ? { soul } : {}), access,
    ...(scope.paths.length ? { scope: scope.paths } : {}), ...(forbidden.paths.length ? { forbidden: forbidden.paths } : {}),
  };
}

/** A team spec in `text`, or undefined when it has no subagent blocks. */
export function parseTeamSpec(text: string): TeamSpec | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  const intro: string[] = [];
  const goalLines: string[] = [];
  const rules: string[] = [];
  let section: 'intro' | 'goal' | 'rules' | 'other' = 'intro';
  let block: Block | undefined;
  let field: Field | undefined;
  let blank = false;

  const closeBlock = () => { if (block) blocks.push(block); block = undefined; field = undefined; };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    const trimmed = clean(line);
    if (!trimmed) { blank = true; continue; }
    const heading = /^#{1,6}\s*(.*)$/.exec(trimmed);
    const body = (heading ? heading[1]! : trimmed).replace(BULLET, '').trim();
    const member = MEMBER_HEADING.exec(body);
    if (member && (heading || !FIELD_LINE.test(body) || /^sub/i.test(body))) {
      closeBlock();
      block = { heading: member[2] ?? '', fields: {}, order: [] };
      section = 'other';
      blank = false;
      continue;
    }
    const bareSection = /^[A-Z][A-Z ]{2,40}:?$/.test(body) && sectionKind(body) !== 'other';
    if (heading || bareSection || /^-{3,}$/.test(trimmed)) {
      closeBlock();
      section = heading || bareSection ? sectionKind(body) : 'other';
      blank = false;
      continue;
    }
    if (block) {
      const match = FIELD_LINE.exec(body);
      const known = match ? labelField(match[1]!) : undefined;
      if (known && match) {
        field = known;
        if (!block.order.includes(known)) block.order.push(known);
        block.fields[known] = match[2] ?? '';
      } else if (field && (!blank || /^\s/.test(line) || BULLET.test(trimmed))) {
        block.fields[field] = `${block.fields[field] ?? ''}\n${body}`;
      } else if (blank) {
        // Unlabelled text after a blank line ends the member block.
        closeBlock();
        section = 'other';
      }
      blank = false;
      continue;
    }
    if (section === 'intro') intro.push(trimmed);
    else if (section === 'goal') goalLines.push(body);
    else if (section === 'rules') {
      if (!BULLET.test(trimmed) && /^\s/.test(line) && rules.length) rules[rules.length - 1] = `${rules.at(-1)} ${body}`;
      else rules.push(body);
    }
    blank = false;
  }
  closeBlock();

  const members = blocks.map(toMember).filter((item): item is Omit<TeamMember, 'id'> => Boolean(item));
  if (!members.length) return undefined;
  const goalText = goalLines.filter(item => !isPlaceholder(item)).join('\n').trim() || singleLine(intro.join(' ')).replace(/[:：]\s*$/, '');
  const spec: TeamSpec = { members };
  if (goalText) spec.goal = bound(goalText, MAX_TEAM_GOAL);
  const ruleList = rules.map(rule => bound(rule.trim(), MAX_TEAM_RULE)).filter(rule => rule && !isPlaceholder(rule)).slice(0, MAX_TEAM_RULES);
  if (ruleList.length) spec.rules = ruleList;
  return spec;
}

export interface ApplyTeamSpecOptions {
  newId?: () => string;
  /** Names used elsewhere in the Office; generated names avoid them. */
  taken?: Iterable<string>;
  /** Seed for generated names (for example the session id). */
  seed?: string;
}

/**
 * Merge a spec into a session's team: members are matched by name
 * (case-insensitive) and updated, new ones are added with a new id (and a
 * generated full name when the spec gives none). The models the spec names are
 * added to the team's allowed models, and the team is enabled. Throws an error
 * whose message is safe to show when the result is not a valid team.
 */
export function applyTeamSpec(current: AgentTeam | undefined, spec: TeamSpec, options: ApplyTeamSpecOptions = {}): AgentTeam {
  const newId = options.newId ?? newTeamMemberId;
  const members: TeamMember[] = (current?.members ?? []).map(member => ({ ...member }));
  const allowedModels = [...(current?.allowedModels ?? [])];
  const used = new Set([...(options.taken ?? [])].map(name => name.toLowerCase()));
  for (const member of members) used.add(member.name.toLowerCase());
  spec.members.forEach((entry, index) => {
    for (const model of entry.models) if (!allowedModels.includes(model)) allowedModels.push(model);
    const existing = entry.name ? members.find(member => member.name.toLowerCase() === entry.name.toLowerCase()) : undefined;
    if (existing) {
      if (entry.gender) existing.gender = entry.gender;
      if (entry.role && entry.role !== DEFAULT_SPEC_ROLE) existing.role = entry.role;
      if (entry.task) existing.task = entry.task;
      if (entry.soul) existing.soul = entry.soul;
      if (entry.models.length) existing.models = [...entry.models];
      if (entry.access) existing.access = entry.access;
      if (entry.scope) existing.scope = [...entry.scope];
      if (entry.forbidden) existing.forbidden = [...entry.forbidden];
      return;
    }
    let { name } = entry;
    let gender = entry.gender;
    if (!name) {
      const generated = generateFullName(`${options.seed ?? 'team'}#spec#${members.length}#${index}`, used, gender);
      name = generated.name; gender = generated.gender;
    }
    used.add(name.toLowerCase());
    members.push({ ...entry, id: newId(), name, ...(gender ? { gender } : {}), models: [...entry.models] });
  });
  if (allowedModels.length > MAX_TEAM_MODELS) throw new Error(`The team in this prompt names more than ${MAX_TEAM_MODELS} models.`);
  const goal = spec.goal ?? current?.goal;
  const rules = spec.rules ?? current?.rules;
  const decoded = decodeAgentTeam({ enabled: true, allowedModels, members, ...(goal ? { goal } : {}), ...(rules?.length ? { rules } : {}) });
  if (!decoded.ok) throw new Error(`The team in this prompt cannot be used: ${decoded.errors.join(' ')}`);
  return decoded.value;
}
