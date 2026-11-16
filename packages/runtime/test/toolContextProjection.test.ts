import { describe, expect, it } from 'vitest';
import { projectToolContext, retainsRequiredToolEvidence, toolContextIsProtected } from '../src/toolContextProjection.js';

describe('local tool evidence projections', () => {
  it('folds repeated logs with counts while preserving middle failures and constraints exactly', () => {
    const decision = 'Decision: preserve first duplicate. Jangan menghapus batas 73.';
    const failure = 'ERROR: task failed; do not retry the external action.';
    const content = `${'INFO: polling worker\n'.repeat(120)}${decision}\n${failure}\n${'INFO: polling worker\n'.repeat(120)}`;
    const projected = projectToolContext(content, 1200)!;
    expect(projected.method).toBe('repeated-lines');
    expect(projected.retainedDiagnosticLines).toBe(2);
    expect(projected.content).toContain(decision); expect(projected.content).toContain(failure);
    expect(projected.content).toContain('119 identical lines omitted');
    expect(projected.content.length).toBeLessThan(content.length / 3);
  });

  it('removes JSON formatting without changing numeric spelling, string escapes, fields, or array order', () => {
    const content = `{\n  "precise": 9007199254740993,\n  "scale": 1.000e+06,\n  "rows": [\n${Array.from({ length: 180 }, (_, i) => `      { "id": ${i}, "text": "value \\"${i}\\" \\n" }`).join(',\n')}\n  ]\n}`;
    const result = projectToolContext(content, 6000)!;
    expect(result.method).toBe('json-whitespace');
    expect(result.content).toContain('9007199254740993');
    expect(result.content).toContain('1.000e+06');
    expect(JSON.parse(result.content)).toEqual(JSON.parse(content));
  });

  it('keeps middle diagnostics and Unicode boundaries in excerpts, masking credentials before projection', () => {
    const secret = `sk-${'a'.repeat(40)}`;
    const content = `${'🙂'.repeat(1500)}\n${secret}\nPeringatan: belum berhasil; wajib mempertahankan batas 73.\n${'🙂'.repeat(1500)}`;
    const result = projectToolContext(content, 320)!;
    expect(result.method).toBe('evidence-excerpts');
    expect(result.content).toContain('Peringatan: belum berhasil; wajib mempertahankan batas 73.');
    expect(result.content).not.toContain(secret); expect(result.redacted).toBe(true);
    expect(Buffer.from(result.content).toString()).toBe(result.content);
    expect(retainsRequiredToolEvidence(content, result.content)).toBe(true);
    expect(retainsRequiredToolEvidence(content, 'All operations completed.')).toBe(false);
    expect(retainsRequiredToolEvidence('ERROR: first\nERROR: second', 'ERROR: second\nERROR: first')).toBe(false);
    expect(retainsRequiredToolEvidence('ERROR: first\nERROR: first', 'ERROR: first')).toBe(false);
  });

  it('refuses ineffective or unbounded scans instead of truncating critical evidence', () => {
    expect(projectToolContext('error '.repeat(2000), 320)).toBeUndefined();
    expect(projectToolContext('line\n'.repeat(33_000), 320)).toBeUndefined();
    expect(projectToolContext('x'.repeat(2_000_001), 320)).toBeUndefined();
  });

  it('protects errors, recovery output, exact skill reads, source files and prior projections', () => {
    const call = { id: 'result', name: 'read_file', input: { path: 'runtime.log' } };
    const result = { toolCallId: 'result', name: 'read_file', isError: false, content: 'evidence' };
    expect(toolContextIsProtected(result, call, 'context_archive_read')).toBe(false);
    for (const name of ['skills_read', 'knowledge_read', 'memory_read', 'context_archive_read', 'caveman_retrieve', 'handover_accept']) {
      expect(toolContextIsProtected({ ...result, name }, { ...call, name }, 'context_archive_read')).toBe(true);
    }
    for (const source of ['skills/example/SKILL.md', 'AGENTS.md', 'src/parser.ts', 'settings.yaml']) {
      expect(toolContextIsProtected(result, { ...call, input: { path: source } }, 'context_archive_read')).toBe(true);
    }
    expect(toolContextIsProtected({ ...result, isError: true }, call, 'context_archive_read')).toBe(true);
    expect(toolContextIsProtected({ ...result, content: '[Optimized tool output; method: local]' }, call, 'context_archive_read')).toBe(true);
  });
});
