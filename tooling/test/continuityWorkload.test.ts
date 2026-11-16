import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executePythonProbe } from '../continuity-acceptance/python-probe.mjs';
import { createWorkload, prepareWorkload, verifyWorkload } from '../continuity-acceptance/workload.mjs';

const roots: string[] = [];
const implementation = String.raw`import json, sys
def normalize_inventory(records):
    if not isinstance(records, list): raise ValueError('list required')
    result, seen = [], set()
    for record in records:
        if not isinstance(record, dict): continue
        sku, quantity, warehouse = record.get('sku'), record.get('quantity'), record.get('warehouse')
        if not isinstance(sku, str) or not sku.strip() or type(quantity) is not int or quantity < 0 or not isinstance(warehouse, str) or not warehouse.strip(): continue
        sku = sku.strip().casefold()
        if sku in seen: continue
        seen.add(sku)
        result.append({'sku': sku, 'quantity': quantity, 'warehouse': warehouse.strip()})
        if len(result) == 73: break
    return result
if __name__ == '__main__':
    try:
        result = normalize_inventory(json.loads(sys.stdin.read()))
        sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
    except (ValueError, json.JSONDecodeError):
        print('invalid inventory', file=sys.stderr)
        sys.exit(2)
`;

async function fixture(content = implementation) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'extalia-continuity-oracle-'));
  roots.push(root);
  const projectDirectory = path.join(root, 'project');
  await mkdir(projectDirectory);
  await writeFile(path.join(projectDirectory, 'normalizer.py'), content);
  return { runId: 'acceptance-test', projectDirectory, outputDirectory: path.join(root, 'verification') };
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('cross-agent executable acceptance workload', () => {
  it('introduces the objective once and keeps the original decision out of pressure/recovery prompts', () => {
    const workload = createWorkload('run-001');
    expect(workload.firstPrompt).toContain('73 admitted unique records');
    expect(workload.checkpointPrompt).toContain(workload.requiredFact);
    expect(workload.pressurePrompts).toHaveLength(12);
    for (const prompt of [workload.firstPrompt, ...workload.pressurePrompts, workload.recoveryPrompt, workload.finalRecoveryPrompt]) {
      expect(prompt).not.toContain(workload.requiredFact);
    }
    expect(createWorkload('run-002').requiredFact).not.toBe(workload.requiredFact);
    expect(() => createWorkload('../other')).toThrow('run ID');
  });

  it('writes hashed prompt artifacts once without replacing an existing evidence directory', async () => {
    const options = await fixture();
    const prepared = await prepareWorkload({ runId: options.runId, outputDirectory: options.outputDirectory });
    const saved = JSON.parse(await readFile(path.join(options.outputDirectory, 'workload.json'), 'utf8'));
    expect(saved.objective).toEqual(prepared.objective);
    expect(saved.objective.firstPrompt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.files.pressurePrompts).toHaveLength(12);
    await expect(prepareWorkload({ runId: options.runId, outputDirectory: options.outputDirectory })).rejects.toThrow();
  });

  it('runs actual independent artifact checks and records the exact copied source and oracle', async () => {
    const options = await fixture();
    const report = await verifyWorkload(options);
    const result = JSON.parse(await readFile(path.join(options.outputDirectory, report.result.path), 'utf8'));
    expect(report.passed, JSON.stringify(result, null, 2)).toBe(true);
    expect(report.checks).toHaveLength(17);
    expect(report.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
    const command = JSON.parse(await readFile(path.join(options.outputDirectory, report.command.path), 'utf8'));
    expect(command.kind).toBe('independent-artifact-check');
    expect(command.executable).toBe(process.execPath);
    expect(command.argv).toEqual([path.join(options.outputDirectory, 'oracle.mjs'), 'python3']);
    expect(command.verifier.path).toBe('oracle.mjs');
    expect(result.pid).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
    expect(result.artifactSha256).toBe(command.artifact.sha256);
    expect(result.verifierSha256).toBe(command.verifier.sha256);
    expect(await readFile(path.join(options.projectDirectory, 'normalizer.py'), 'utf8')).toBe(implementation);
  });

  it('keeps probe transport UTF-8/LF when Python text stdout translates newlines', async () => {
    const windowsTextStream = implementation.replace('import json, sys',
      "import json, sys\nsys.stdout.reconfigure(encoding='utf-8', newline='\\r\\n')");
    const options = await fixture(windowsTextStream), report = await verifyWorkload(options);
    const result = JSON.parse(await readFile(path.join(options.outputDirectory, report.result.path), 'utf8'));
    expect(report.passed, JSON.stringify(result, null, 2)).toBe(true);
    expect(report.checks).toContainEqual({ id: 'quiet_import', passed: true });
    expect(report.checks).toContainEqual({ id: 'cli_exact_output', passed: true });
  });

  it('keeps the candidate CLI in its actual __main__ module with script argv and file identity', async () => {
    const mainIdentity = implementation.replace("if __name__ == '__main__':",
      "if __name__ == '__main__':\n    import __main__\n    assert __main__.__dict__ is globals()\n    assert __main__.__file__ == __file__\n    assert sys.argv == [__file__]");
    const report = await verifyWorkload(await fixture(mainIdentity));
    expect(report.passed).toBe(true);
    expect(report.checks).toContainEqual({ id: 'cli_exact_output', passed: true });
    expect(report.checks).toContainEqual({ id: 'cli_error_contract', passed: true });
  });

  it('continues to reject CRLF bytes from the candidate CLI', async () => {
    const crlfCli = implementation.replace(" + '\\n').encode('utf-8')", " + '\\r\\n').encode('utf-8')");
    expect(crlfCli).not.toBe(implementation);
    const report = await verifyWorkload(await fixture(crlfCli));
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({ id: 'quiet_import', passed: true });
    expect(report.checks).toContainEqual({ id: 'cli_exact_output', passed: false });
  });

  it.each([
    ['sorting', implementation.replace('return result', "return sorted(result, key=lambda item: item['sku'])"), 'stable_order'],
    ['bool accepted', implementation.replace('type(quantity) is not int', 'not isinstance(quantity, int)'), 'bool_rejected'],
    ['wrong limit', implementation.replace('== 73', '== 72'), 'admitted_limit'],
    ['lower rather than casefold', implementation.replace('.casefold()', '.lower()'), 'unicode_casefold'],
    ['large integer rounded through float', implementation.replace("'quantity': quantity", "'quantity': int(float(quantity))"), 'empty_and_large_integer'],
    ['quantity dictionary impersonates an integer', implementation.replace("'quantity': quantity", "'quantity': {'$integer': str(quantity)}"), 'stable_order'],
  ])('rejects an implementation with %s', async (_name, source, failingCheck) => {
    const report = await verifyWorkload(await fixture(source));
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({ id: failingCheck, passed: false });
  });

  it('does not treat an artifact self-report as independent verification', async () => {
    const report = await verifyWorkload(await fixture('print(\'{"checks":[{"id":"everything","passed":true}]}\')\n'));
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({ id: 'quiet_import', passed: false });
    expect(report.checks).toHaveLength(17);
  });

  it('keeps oracle predicates outside the Python interpreter that imports the candidate', async () => {
    const candidate = String.raw`import __main__
def normalize_inventory(records): return []
def fake(name, predicate):
    __main__.checks.append({'id': name, 'passed': True})
__main__.check = fake
`;
    const report = await verifyWorkload(await fixture(candidate));
    expect(report.passed).toBe(false);
    expect(report.checks).toHaveLength(17);
    expect(report.checks).toContainEqual({ id: 'stable_order', passed: false });
    expect(report.checks).toContainEqual({ id: 'nonlist_value_error', passed: false });
    expect(report.checks).toContainEqual({ id: 'verifier_process', passed: false });
  });

  it('rejects CLI output over budget without accepting a candidate receipt', async () => {
    const candidate = implementation.replace("if __name__ == '__main__':",
      "if __name__ == '__main__':\n    sys.stdout.write('x' * 200000)\n    sys.exit(0)");
    const options = await fixture(candidate), report = await verifyWorkload(options);
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({ id: 'quiet_import', passed: true });
    expect(report.checks).toContainEqual({ id: 'cli_exact_output', passed: false });
    expect(report.checks).toContainEqual({ id: 'cli_error_contract', passed: false });
    const receipt = JSON.parse(await readFile(path.join(options.outputDirectory, report.result.path), 'utf8'));
    expect(receipt.signal).toBeNull();
    expect(receipt.stdout.length).toBeLessThan(2000);
  });

  it('rejects candidate mutation even when the original artifact bytes are restored before exit', async () => {
    const candidate = implementation + String.raw`
import os, pathlib
copied = pathlib.Path(__file__)
original = copied.read_bytes()
os.chmod(copied, 0o600)
copied.write_bytes(original + b'\n')
copied.write_bytes(original)
`;
    const options = await fixture(candidate), report = await verifyWorkload(options);
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({ id: 'artifact_and_oracle_unchanged', passed: false });
    expect(await readFile(path.join(options.outputDirectory, 'normalizer.py'), 'utf8')).toBe(candidate);
  });

  it('rejects changes to the controller-owned oracle during verification', async () => {
    const candidate = implementation + String.raw`
import os, pathlib
oracle = pathlib.Path(__file__).with_name('oracle.mjs')
os.chmod(oracle, 0o600)
with oracle.open('a') as stream: stream.write('\n// candidate modification\n')
`;
    const report = await verifyWorkload(await fixture(candidate));
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({ id: 'artifact_and_oracle_unchanged', passed: false });
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink in place of the artifact before executing it', async () => {
    const options = await fixture();
    const target = path.join(options.projectDirectory, 'normalizer.py');
    const other = path.join(options.projectDirectory, 'other.py');
    await writeFile(other, implementation);
    await rm(target);
    await symlink(other, target);
    await expect(verifyWorkload(options)).rejects.toThrow('single regular file');
  });

  it('keeps the oracle out of the agent project', async () => {
    const options = await fixture();
    await expect(verifyWorkload({ ...options, outputDirectory: path.join(options.projectDirectory, 'verification') })).rejects.toThrow('outside the agent project');
  });
});

function simulatedPython() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; }),
  });
  const result = executePythonProbe({ spawn: () => child, executable: 'fixture-python', argv: [], input: '', cwd: '.' });
  return { child, result };
}

describe('bounded Python interpreter admission', () => {
  it('does not charge delayed startup to candidate execution and retains exact candidate output', async () => {
    vi.useFakeTimers(); const { child, result } = simulatedPython();
    await vi.advanceTimersByTimeAsync(2100); expect(child.kill).not.toHaveBeenCalled();
    child.stderr.write('EXTALIA-PYTHON-');
    await vi.advanceTimersByTimeAsync(100); expect(child.kill).not.toHaveBeenCalled();
    child.stderr.write('READY\n');
    await vi.advanceTimersByTimeAsync(1999); expect(child.kill).not.toHaveBeenCalled();
    child.stdout.write('exact\n'); child.stderr.write('candidate warning\n'); child.emit('close', 0, null);
    expect(await result).toEqual({ exitCode: 0, signal: null, stdout: 'exact\n', stderr: 'candidate warning\n', problem: undefined });
  });

  it('still terminates candidate execution after two seconds without retrying it', async () => {
    vi.useFakeTimers(); const { child, result } = simulatedPython();
    child.stderr.write('EXTALIA-PYTHON-READY\n');
    await vi.advanceTimersByTimeAsync(2000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(await result).toMatchObject({ problem: 'Python probe exceeded its 2-second budget.', signal: 'SIGKILL' });
  });

  it('bounds startup independently and refuses a missing readiness marker', async () => {
    vi.useFakeTimers(); const { child, result } = simulatedPython();
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(await result).toMatchObject({ problem: 'Python startup exceeded its 5-second budget.', signal: 'SIGKILL' });
  });

  it('consumes only the trusted first marker and keeps a candidate lookalike as stderr', async () => {
    vi.useFakeTimers(); const { child, result } = simulatedPython();
    child.stderr.write('EXTALIA-PYTHON-READY\nEXTALIA-PYTHON-READY\n'); child.emit('close', 0, null);
    expect(await result).toMatchObject({ exitCode: 0, stderr: 'EXTALIA-PYTHON-READY\n', problem: undefined });
  });
});
