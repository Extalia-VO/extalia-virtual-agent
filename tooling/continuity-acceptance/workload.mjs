#!/usr/bin/env node
/** Offline acceptance task and independent artifact verification; never invokes an agent. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const validRunId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);
const MAX_ARTIFACT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;

export function createWorkload(runId) {
  if (!validRunId(runId)) throw new Error('Use a run ID of 1–100 letters, digits, dots, underscores or hyphens.');
  const requiredFact = `CONTINUITY-DECISION-${sha256(runId).slice(0, 24)}`;
  const firstPrompt = `Implement normalizer.py in this disposable project. Use Python's standard library only; work offline.
Export normalize_inventory(records). The input must be a list, otherwise raise ValueError. Each admitted record is a dictionary with a nonempty string sku, an integer quantity >= 0 (bool is invalid), and a nonempty string warehouse. Trim sku and use casefold(), not lower(). Trim warehouse and preserve its case. Reject invalid records. Deduplicate normalized sku by retaining the first VALID record, preserve admission order, and return at most 73 admitted unique records. Invalid records and duplicates do not consume that limit. Output dictionaries contain exactly sku, quantity, warehouse. Do not mutate any input or retain state between calls. Support Unicode and arbitrarily large nonnegative integers.
When executed as a script, read one JSON value from all stdin, apply this function, and write compact JSON (ensure_ascii=False and separators=(',', ':')) followed by exactly one newline. Valid input exits 0 with empty stderr. Invalid JSON or a non-list input exits 2 with a short stderr explanation and empty stdout. Importing the module has no output or CLI side effects. Implement and test the file; report concrete results and unresolved work. Do not use network resources.`;
  const checkpointPrompt = `Continuity checkpoint: retain the exact decision token ${requiredFact} in this conversation only. Acknowledge it once. Do not write it into project files, tests, comments, logs or generated artifacts. On subsequent stages do not repeat it unless the final recovery request specifically asks for the original decision token. Continue the existing implementation and preserve its constraints.`;
  const pressurePrompts = [
    'Inspect invalid-record handling. Run concrete checks for missing keys, null, arrays, booleans, floats and strings as quantities. Explain any fix and its result.',
    'Check duplicate admission and stable order, including an invalid occurrence before the first valid occurrence. Run the checks and preserve the first valid record.',
    'Inspect Unicode normalization with non-ASCII case folding and whitespace. Run examples that distinguish casefold from lower and report the results.',
    'Check input immutability and repeated calls with shared dictionary objects. Test deeply equal input before and after; report any state leakage.',
    'Exercise the maximum admitted-row limit with many invalid and repeated input rows before enough unique valid rows. Report the exact accepted count and order.',
    'Test stable order with deliberately unsorted valid records and case variants. Check that warehouse casing is preserved while surrounding whitespace is removed.',
    'Run the CLI on a valid Unicode inventory and compare the exact stdout bytes, final newline, exit code and stderr with the specification.',
    'Run invalid JSON and non-list JSON through the CLI. Check stdout, stderr and exit codes. Do not weaken the existing contract to make a test pass.',
    'Test empty input, empty strings, extra dictionary keys and import-time side effects. Fix any observed mismatch and explain the concrete result.',
    'Test very large integer quantities and mixed invalid inputs. Preserve exact integer values; no floating-point conversion is allowed.',
    'Construct deterministic mixed inventories with duplicates and invalid records, compare implementation output with a small independent reference, and inspect any disagreement.',
    'Review all current changes, rerun the meaningful checks and report the remaining work and actual verification evidence. Keep original decisions in the archived conversation; do not copy decision tokens into files.',
  ];
  const recoveryPrompt = 'After the actual native compaction, use the configured Extalia continuity status/read tools to recover the original archived source decisions. Report the canonical identity and original source snapshot used, then continue the task. Do not repeat the decision token at this intermediate stage.';
  const finalRecoveryPrompt = 'Use the configured Extalia continuity status/read tools to read the original Codex source archive after compaction. Recover and quote the exact original continuity decision token from that archive, identify its source snapshot, and report actual final artifact checks. Do not infer missing evidence from summaries.';
  return { runId, requiredFact, firstPrompt, checkpointPrompt, pressurePrompts, recoveryPrompt, finalRecoveryPrompt };
}

// Expected results and pass/fail decisions stay in this Node process. Candidate
// Python runs only in bounded child processes. This is not a hostile-code sandbox.
const ORACLE_CHECK_IDS = [
  'quiet_import', 'stable_order', 'first_valid_duplicate', 'unicode_casefold', 'invalid_records',
  'bool_rejected', 'exact_fields_and_casing', 'admitted_limit', 'empty_and_large_integer',
  'input_not_mutated', 'no_retained_state', 'nonlist_value_error', 'generated_mixed_inputs',
  'cli_exact_output', 'cli_error_contract',
];

const ORACLE = String.raw`await (async function artifactOracleMain() {
  const { spawn } = await import('node:child_process');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { isDeepStrictEqual } = await import('node:util');
  const target = join(dirname(fileURLToPath(import.meta.url)), 'normalizer.py');
  const python = process.argv[2];
  const checks = [];
  // Transport observations only; there are no predicates, expected values or
  // check records in the interpreter that imports the candidate.
  const probeSource = [
    'import importlib.util, json, sys',
    'def decode(value):',
    '    if isinstance(value, dict):',
    "        if set(value) == {'$integer'}: return int(value['$integer'])",
    "        if set(value) == {'$float'}: return float(value['$float'])",
    "        if set(value) == {'$tuple'}: return tuple(decode(item) for item in value['$tuple'])",
    '        return {key: decode(item) for key, item in value.items()}',
    '    if isinstance(value, list): return [decode(item) for item in value]',
    '    return value',
    'def encode(value):',
    "    if value is None: return ['none']",
    "    if type(value) is str: return ['str', value]",
    "    if type(value) is bool: return ['bool', value]",
    "    if type(value) is int: return ['int', str(value)]",
    "    if type(value) is float: return ['float', repr(value)]",
    "    if type(value) is list: return ['list', [encode(item) for item in value]]",
    "    if type(value) is tuple: return ['tuple', [encode(item) for item in value]]",
    '    if type(value) is dict and all(type(key) is str for key in value):',
    "        return ['dict', [[key, encode(value[key])] for key in sorted(value)]]",
    "    return ['unsupported', type(value).__name__]",
    'request = json.load(sys.stdin)',
    "spec = importlib.util.spec_from_file_location('continuity_candidate', sys.argv[1])",
    'module = importlib.util.module_from_spec(spec)',
    'sys.modules[spec.name] = module',
    'spec.loader.exec_module(module)',
    'normalize = module.normalize_inventory',
    'observations = []',
    "for value in request['inputs']:",
    '    records = decode(value)',
    '    try:',
    '        result = normalize(records)',
    "        observation = {'value': encode(result), 'error': None}",
    '    except BaseException as error:',
    "        observation = {'value': None, 'error': 'value-error' if isinstance(error, ValueError) else 'other:' + type(error).__name__}",
    "    observation['inputAfter'] = encode(records) if request.get('captureInputs') else None",
    '    observations.append(observation)',
    "print(json.dumps({'observations': observations}, ensure_ascii=False, separators=(',', ':')))",
  ].join('\n');

  function execute(argv, input) {
    return new Promise(resolve => {
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), problem, finished = false, killTimer;
      const child = spawn(python, argv, { shell: false, windowsHide: true, cwd: dirname(target),
        env: { PATH: process.env.PATH ?? '', HOME: dirname(target), USERPROFILE: dirname(target), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe'] });
      const finish = (exitCode, signal) => {
        if (finished) return;
        finished = true; clearTimeout(timer); clearTimeout(killTimer);
        let out = '', err = '';
        try {
          out = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
          err = new TextDecoder('utf-8', { fatal: true }).decode(stderr);
        } catch { problem ??= 'Python output was not UTF-8.'; }
        resolve({ exitCode, signal, stdout: out, stderr: err, problem });
      };
      const stop = reason => {
        problem ??= reason;
        try { child.kill('SIGKILL'); } catch { /* already closed */ }
        if (!killTimer) killTimer = setTimeout(() => {
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); finish(null, 'unconfirmed-close');
        }, 250);
      };
      const timer = setTimeout(() => stop('Python probe exceeded its 2-second budget.'), 2000);
      child.stdout.on('data', chunk => {
        if (stdout.length + chunk.length > 131072) stop('Python stdout exceeded its byte budget.');
        else stdout = Buffer.concat([stdout, chunk]);
      });
      child.stderr.on('data', chunk => {
        if (stderr.length + chunk.length > 131072) stop('Python stderr exceeded its byte budget.');
        else stderr = Buffer.concat([stderr, chunk]);
      });
      child.stdin.on('error', () => { /* Early interpreter exit is checked through its receipt. */ });
      child.once('error', error => { problem = error.message; finish(null, null); });
      child.once('close', finish);
      child.stdin.end(input);
    });
  }

  async function probe(inputs, captureInputs = false) {
    const result = await execute(['-I', '-S', '-B', '-c', probeSource, target], JSON.stringify({ inputs, captureInputs }));
    if (result.problem || result.exitCode !== 0 || result.signal !== null || result.stderr !== '') return undefined;
    let value;
    try { value = JSON.parse(result.stdout); } catch { return undefined; }
    if (!value || Object.keys(value).join(',') !== 'observations' || !Array.isArray(value.observations)
      || value.observations.length !== inputs.length || result.stdout !== JSON.stringify(value) + '\n') return undefined;
    if (!value.observations.every(item => item && Object.keys(item).sort().join(',') === 'error,inputAfter,value'
      && (item.error === null || typeof item.error === 'string'))) return undefined;
    return value.observations;
  }
  // Every observed type has its own tag. A candidate dictionary cannot impersonate
  // an integer's transport envelope; decimal strings retain exact large integers.
  function wire(value) {
    if (value === null) return ['none'];
    if (typeof value === 'string') return ['str', value];
    if (typeof value === 'boolean') return ['bool', value];
    if (typeof value === 'number') return ['int', String(value)];
    if (Array.isArray(value)) return ['list', value.map(wire)];
    const keys = Object.keys(value).sort();
    // Only controller-owned inputs use these shorthand tags before Python decode.
    if (keys.length === 1 && keys[0] === '$integer') return ['int', value.$integer];
    if (keys.length === 1 && keys[0] === '$float') return ['float', value.$float];
    if (keys.length === 1 && keys[0] === '$tuple') return ['tuple', value.$tuple.map(wire)];
    return ['dict', keys.map(key => [key, wire(value[key])])];
  }
  const row = (sku, quantity = 1, warehouse = 'North') => ({ sku, quantity, warehouse });
  async function returns(inputs, expected) {
    const actual = await probe(inputs);
    return !!actual && actual.every((item, index) => item.error === null && isDeepStrictEqual(item.value, wire(expected[index])));
  }
  async function check(id, predicate) {
    let passed = false;
    try { passed = await predicate() === true; } catch { /* A failed probe is failed evidence. */ }
    checks.push({ id, passed });
  }

  await check('quiet_import', async () => !!await probe([]));
  await check('stable_order', () => returns([[row(' Z '), row('a'), row('M')]], [[row('z'), row('a'), row('m')]]));
  await check('first_valid_duplicate', () => returns([[row('A', -1), row(' a ', 4, ' East '), row('A', 9)]], [[row('a', 4, 'East')]]));
  await check('unicode_casefold', () => returns([[row(' STRASSE '), row('Straße'), row('Σ'), row('ς')]], [[row('strasse'), row('σ')]]));
  await check('invalid_records', () => returns([[null, [], 0, {}, row('', 1), row(' ', 2), row('x', -1),
    row('x', { $float: '1.0' }), row('x', '1'), row('x', 1, ''), row('x', 1, null)]], [[]]));
  await check('bool_rejected', () => returns([[row('a', true), row('b', false), row('c', 0)]], [[row('c', 0)]]));
  await check('exact_fields_and_casing', () => returns([[{ ...row(' A ', 2, ' NorthWest '), extra: 3 }]], [[row('a', 2, 'NorthWest')]]));
  await check('admitted_limit', () => returns([[...Array.from({ length: 90 }, () => ({})),
    ...Array.from({ length: 90 }, () => row('dupe')), ...Array.from({ length: 90 }, (_, i) => row(String(i)))]],
  [[row('dupe'), ...Array.from({ length: 72 }, (_, i) => row(String(i)))]]));
  const large = { $integer: '1' + '0'.repeat(120) };
  await check('empty_and_large_integer', () => returns([[], [row('L', large)]], [[], [row('l', large)]]));
  await check('input_not_mutated', async () => {
    const records = [{ ...row(' A ', 2, ' West '), nested: { keep: [1, 2] } }, row('a', 4)];
    const actual = await probe([records], true);
    return !!actual && actual[0].error === null && isDeepStrictEqual(actual[0].inputAfter, wire(records));
  });
  await check('no_retained_state', () => returns([[row('a')], [row('a')]], [[row('a')], [row('a')]]));
  await check('nonlist_value_error', async () => {
    const actual = await probe([null, {}, 'text', 7, { $tuple: [] }, true]);
    return !!actual && actual.every(item => item.error === 'value-error' && item.value === null);
  });
  await check('generated_mixed_inputs', () => {
    const inputs = [], expected = [];
    for (let seed = 0; seed < 12; seed++) {
      const records = [], admitted = [];
      for (let i = 0; i < 85; i++) {
        const sku = String((i * 23 + seed) % 101);
        records.push(row(sku, -1), row(' ' + sku + ' ', i, ' Depot '), row(sku, i + 10));
        if (i < 73) admitted.push(row(sku, i, 'Depot'));
      }
      inputs.push(records); expected.push(admitted);
    }
    return returns(inputs, expected);
  });
  const cli = stdin => execute(['-I', '-S', '-B', target], stdin);
  await check('cli_exact_output', async () => {
    const result = await cli(JSON.stringify([row(' Straße ', 5, ' 東 ')]));
    return !result.problem && result.exitCode === 0 && result.signal === null && result.stderr === ''
      && result.stdout === JSON.stringify([row('strasse', 5, '東')]) + '\n';
  });
  await check('cli_error_contract', async () => {
    for (const value of ['{', 'null', '{}']) {
      const result = await cli(value);
      if (result.problem || result.exitCode !== 2 || result.signal !== null || result.stdout !== ''
        || result.stderr.trim().length < 1 || result.stderr.trim().length > 1000) return false;
    }
    return true;
  });
  process.stdout.write(JSON.stringify({ checks }) + '\n');
  process.exitCode = checks.every(check => check.passed) ? 0 : 1;
})();
`;


async function canonicalDirectory(directory) {
  const resolved = path.resolve(directory);
  if (resolved !== await realpath(resolved)) throw new Error('Directories must not contain symbolic links.');
  if (!(await lstat(resolved)).isDirectory()) throw new Error('Expected an existing directory.');
  return resolved;
}
async function readRegularFile(file) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_ARTIFACT_BYTES) {
    throw new Error('Acceptance artifacts must be a single regular file of at most 128 KiB.');
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_ARTIFACT_BYTES) {
      throw new Error('Acceptance artifact identity changed while opening.');
    }
    const buffer = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat(), current = await lstat(file);
    if (length > MAX_ARTIFACT_BYTES || length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size
      || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs) {
      throw new Error('Acceptance artifact changed or exceeded its byte budget.');
    }
    return { bytes: buffer.subarray(0, length), dev: opened.dev, ino: opened.ino,
      size: opened.size, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs };
  } finally { await handle.close(); }
}
async function privateDirectory(directory) {
  const resolved = path.resolve(directory);
  await canonicalDirectory(path.dirname(resolved));
  await mkdir(resolved, { mode: 0o700 }); // Refuse reuse, including existing symlinks.
  return resolved;
}
async function writeArtifact(root, name, value, mode = 0o600) {
  const content = typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path.join(root, name), content, { flag: 'wx', mode });
  return { path: name, sha256: sha256(content) };
}

export async function prepareWorkload({ runId, outputDirectory }) {
  const workload = createWorkload(runId);
  const output = await privateDirectory(outputDirectory);
  const files = {};
  for (const key of ['firstPrompt', 'checkpointPrompt', 'recoveryPrompt', 'finalRecoveryPrompt']) {
    files[key] = await writeArtifact(output, `${key}.txt`, workload[key]);
  }
  files.pressurePrompts = [];
  for (let i = 0; i < workload.pressurePrompts.length; i++) {
    files.pressurePrompts.push(await writeArtifact(output, `pressure-${String(i + 1).padStart(2, '0')}.txt`, workload.pressurePrompts[i]));
  }
  const objective = { firstPrompt: files.firstPrompt, checkpointPrompt: files.checkpointPrompt, requiredFact: workload.requiredFact };
  await writeArtifact(output, 'workload.json', { schemaVersion: 1, runId, objective, files });
  return { outputDirectory: output, objective, files };
}

function runVerifier(executable, argv, cwd) {
  return new Promise(resolve => {
    const startedAt = new Date().toISOString();
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), problem, finished = false, killTimer;
    const child = spawn(executable, argv, { cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true,
      env: { PATH: process.env.PATH ?? '', HOME: cwd, USERPROFILE: cwd, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (exitCode, signal) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(killTimer);
      // A candidate child may have left descendants behind. The controller owns
      // this process group and closes it after the oracle exits or times out.
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already closed */ }
      }
      resolve({ pid: child.pid ?? 0, exitCode, signal, startedAt, finishedAt: new Date().toISOString(),
        stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), ...(problem ? { problem } : {}) });
    };
    const stop = reason => {
      if (!problem) problem = reason;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already closed */ }
      if (!killTimer) killTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null, 'unconfirmed-close'); }, 1000);
    };
    const timer = setTimeout(() => stop('Verifier exceeded its 15-second budget.'), 15_000);
    child.stdout.on('data', chunk => { if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) stop('Verifier stdout exceeded its byte budget.'); else stdout = Buffer.concat([stdout, chunk]); });
    child.stderr.on('data', chunk => { if (stderr.length + chunk.length > MAX_OUTPUT_BYTES) stop('Verifier stderr exceeded its byte budget.'); else stderr = Buffer.concat([stderr, chunk]); });
    child.once('error', error => { problem = error.message; finish(null, null); });
    child.once('close', finish);
  });
}

export async function verifyWorkload({ runId, projectDirectory, outputDirectory, pythonExecutable = 'python3' }) {
  if (!validRunId(runId)) throw new Error('Invalid run ID.');
  const project = await canonicalDirectory(projectDirectory);
  const source = path.join(project, 'normalizer.py');
  const before = await readRegularFile(source);
  const output = path.resolve(outputDirectory);
  if (output === project || output.startsWith(`${project}${path.sep}`)) throw new Error('Keep verifier artifacts outside the agent project.');
  await privateDirectory(output);
  const artifact = await writeArtifact(output, 'normalizer.py', before.bytes, 0o400);
  const verifier = await writeArtifact(output, 'oracle.mjs', ORACLE, 0o400);
  const argv = [path.join(output, verifier.path), pythonExecutable];
  const command = { kind: 'independent-artifact-check', runId, executable: process.execPath, argv, cwd: output, artifact, verifier };
  const commandRef = await writeArtifact(output, 'verification-command.json', command);
  const copiedBefore = await readRegularFile(path.join(output, artifact.path));
  const oracleBefore = await readRegularFile(path.join(output, verifier.path));
  const execution = await runVerifier(command.executable, argv, output);
  let checks = ORACLE_CHECK_IDS.map(id => ({ id, passed: false }));
  try {
    const parsed = JSON.parse(execution.stdout);
    if (parsed && Object.keys(parsed).join(',') === 'checks' && execution.stdout === JSON.stringify(parsed) + '\n'
      && Array.isArray(parsed.checks) && parsed.checks.length === ORACLE_CHECK_IDS.length
      && parsed.checks.every((check, index) => check && Object.keys(check).sort().join(',') === 'id,passed'
        && check.id === ORACLE_CHECK_IDS[index] && typeof check.passed === 'boolean')) checks = parsed.checks;
  } catch { /* Agent output is not a verification receipt. */ }
  const after = await readRegularFile(source).catch(() => undefined);
  const copied = await readRegularFile(path.join(output, artifact.path)).catch(() => undefined);
  const oracle = await readRegularFile(path.join(output, verifier.path)).catch(() => undefined);
  const sameFile = (left, right, digest) => !!right && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && sha256(right.bytes) === digest;
  const sourceStillSame = sameFile(before, after, artifact.sha256);
  const copiedArtifactSame = sameFile(copiedBefore, copied, artifact.sha256);
  const verifierSame = sameFile(oracleBefore, oracle, verifier.sha256);
  checks.push({ id: 'verifier_process', passed: execution.pid > 0 && execution.exitCode === 0 && execution.signal === null && !execution.problem && execution.stderr === '' });
  checks.push({ id: 'artifact_and_oracle_unchanged', passed: !!sourceStillSame && copiedArtifactSame && verifierSame });
  const result = { runId, ...execution, artifactSha256: artifact.sha256, verifierSha256: verifier.sha256, checks };
  const resultRef = await writeArtifact(output, 'verification-result.json', result);
  return { outputDirectory: output, command: commandRef, result: resultRef, passed: checks.length === 17 && checks.every(check => check.passed), checks };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const values = new Map();
  let mode;
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const key = process.argv[i];
      if (key === '--prepare' || key === '--verify') { if (mode) throw new Error('Choose one mode.'); mode = key; }
      else if (['--run-id', '--output', '--project', '--python'].includes(key) && process.argv[i + 1] && !values.has(key)) values.set(key, process.argv[++i]);
      else throw new Error(`Unknown or incomplete argument: ${key}`);
    }
    if (!mode || !values.has('--run-id') || !values.has('--output') || (mode === '--verify' && !values.has('--project'))) {
      throw new Error('Use --prepare --run-id ID --output NEW_DIRECTORY or --verify --run-id ID --project DIRECTORY --output NEW_DIRECTORY [--python EXECUTABLE].');
    }
    const options = { runId: values.get('--run-id'), outputDirectory: values.get('--output'), projectDirectory: values.get('--project'), pythonExecutable: values.get('--python') };
    const result = mode === '--prepare' ? await prepareWorkload(options) : await verifyWorkload(options);
    console.log(JSON.stringify(result, null, 2));
    if (mode === '--verify' && !result.passed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
