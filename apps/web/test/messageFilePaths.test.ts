import { describe, expect, it } from 'vitest';
import { resolveMessageFile, type MessageFileScope } from '../src/chat/messageFilePaths';

const workspaces = [
  { id: 'project', projectLocation: '/projects/example' },
  { id: 'nested', projectLocation: '/projects/example/packages/tool' },
  { id: 'other', projectLocation: '/projects/other' },
];
const resolve = (path: string | undefined, extra: Partial<MessageFileScope> = {}, link = false) => resolveMessageFile({ name: 'Example file', path, link }, { workspaces, ...extra });

describe('message file paths', () => {
  it('requires a path and a registered project, and never infers a read from a display name', () => {
    expect(resolve(undefined, { workspaceId: 'project' })).toBeUndefined();
    expect(resolve('README.md')).toBeUndefined();
    expect(resolve('/projects/missing/README.md')).toBeUndefined();
    expect(resolve('README.md', { workspaceId: 'missing' })).toBeUndefined();
    expect(resolveMessageFile({ name: '/projects/example/README.md' }, { workspaces })).toBeUndefined();
  });

  it('uses the deepest root for an unscoped absolute path', () => {
    expect(resolve('/projects/example/packages/tool/src/main.ts:12:3', {}, true)).toEqual({ workspaceId: 'nested', path: 'src/main.ts' });
  });

  it('honors the explicit workspace rather than a deeper or unrelated root', () => {
    expect(resolve('/projects/example/packages/tool/src/main.ts', { workspaceId: 'project' })).toEqual({ workspaceId: 'project', path: 'packages/tool/src/main.ts' });
    expect(resolve('/projects/other/secret.txt', { workspaceId: 'project' })).toBeUndefined();
  });

  it('compares component boundaries and requires a file below the root', () => {
    expect(resolve('/projects/example-backup/README.md')).toBeUndefined();
    expect(resolve('/projects/example')).toBeUndefined();
    expect(resolve('/projects/Example/README.md')).toBeUndefined();
  });

  it('resolves relative paths against a scoped observed working directory', () => {
    expect(resolve('./README.md:12', { workspaceId: 'project', projectPath: '/projects/example/docs' }, true)).toEqual({ workspaceId: 'project', path: 'docs/README.md' });
    expect(resolve('README.md', { projectPath: '/projects/example/packages/tool/docs' })).toEqual({ workspaceId: 'nested', path: 'docs/README.md' });
  });

  it('falls back to the selected root when an observed directory is outside it', () => {
    expect(resolve('README.md', { workspaceId: 'project', projectPath: '/projects/other/docs' })).toEqual({ workspaceId: 'project', path: 'README.md' });
    expect(resolve('README.md', { projectPath: '/outside' })).toBeUndefined();
  });

  it.each([
    '../other/README.md', 'docs/../README.md', '..\\README.md',
    '/projects/example/../other/README.md', 'README.md\0',
    'README.md\n', 'file:///projects/example/README.md', 'https://example.com/file',
    'javascript:alert(1)', 'data:text/plain,hello', 'blob:example', 'http:12',
  ])('refuses unsafe path %j', path => {
    expect(resolve(path, { workspaceId: 'project' })).toBeUndefined();
  });

  it.each(['%2e%2e/README.md', 'docs%2f..%2fREADME.md', '%2e%2e%5cREADME.md', 'READ%00ME.md', 'READ%0aME.md', 'file%3A%2F%2F%2Fprojects/example/README.md', 'https%3A%2F%2Fexample.com/file'])('refuses unsafe decoded link %j', path => {
    expect(resolve(path, { workspaceId: 'project' }, true)).toBeUndefined();
  });

  it('decodes safe link escapes without interpreting file content', () => {
    expect(resolve('/projects/example/docs/hello%20world.md:7', {}, true)).toEqual({ workspaceId: 'project', path: 'docs/hello world.md' });
    expect(resolve('/projects/example/docs/file.md#L12C3', {}, true)).toEqual({ workspaceId: 'project', path: 'docs/file.md' });
    expect(resolve('/projects/example/docs/file.md#L12', {}, true)).toEqual({ workspaceId: 'project', path: 'docs/file.md' });
  });

  it('keeps attachment percent escapes and anchors literal and never strips literal line suffixes', () => {
    const scope = { workspaceId: 'project' };
    expect(resolve('report%20final.txt', scope)).toEqual({ workspaceId: 'project', path: 'report%20final.txt' });
    expect(resolve('report%20final.txt', scope, true)).toEqual({ workspaceId: 'project', path: 'report final.txt' });
    expect(resolve('report.txt#L12', scope)).toEqual({ workspaceId: 'project', path: 'report.txt#L12' });
    expect(resolve('docs/report.txt:12', scope)).toBeUndefined();
    expect(resolve('docs/report.txt%3A12', scope, true)).toBeUndefined();
    expect(resolve('docs/report.txt%23L12', scope, true)).toEqual({ workspaceId: 'project', path: 'docs/report.txt#L12' });
  });

  it('decodes link targets once and leaves remaining escape sequences as literal filenames', () => {
    expect(resolve('docs/%252e%252e/report.txt', { workspaceId: 'project' }, true)).toEqual({ workspaceId: 'project', path: 'docs/%2e%2e/report.txt' });
    expect(resolve('READ%250aME.md', { workspaceId: 'project' }, true)).toEqual({ workspaceId: 'project', path: 'READ%0aME.md' });
  });

  it('keeps percent escapes literal in registered roots and observed working directories', () => {
    const scope = { workspaces: [{ id: 'literal', projectLocation: '/projects/example%20root' }], workspaceId: 'literal' };
    expect(resolve('/projects/example%20root/report%20final.txt', scope)).toEqual({ workspaceId: 'literal', path: 'report%20final.txt' });
    expect(resolve('/projects/example%2520root/report%20final.txt', scope, true)).toEqual({ workspaceId: 'literal', path: 'report final.txt' });
    expect(resolve('/projects/example%20root/report.txt', scope, true)).toBeUndefined();
    expect(resolve('report.txt', { ...scope, projectPath: '/projects/example%20root/docs%20folder' })).toEqual({ workspaceId: 'literal', path: 'docs%20folder/report.txt' });
    expect(resolve('report.txt', { ...scope, workspaces: [{ id: 'literal', projectLocation: '/projects/example:12' }] })).toBeUndefined();
  });

  it('maps Windows drive roots case insensitively without losing the drive colon', () => {
    const windows = { workspaces: [{ id: 'windows', projectLocation: 'C:\\Projects\\Example' }], workspaceId: 'windows' };
    expect(resolve('c:\\projects\\example\\src\\Main.ts:12:3', windows, true)).toEqual({ workspaceId: 'windows', path: 'src/Main.ts' });
    expect(resolve('docs\\README.md', { ...windows, projectPath: 'C:/Projects/Example/packages' })).toEqual({ workspaceId: 'windows', path: 'packages/docs/README.md' });
    for (const path of ['D:/Projects/Example/README.md', 'C:README.md', 'C:12', '\\README.md', 'C:/Projects/Example/../Other/a', 'src/file.txt:stream', 'src/NUL.txt', 'src/file.']) {
      expect(resolve(path, windows)).toBeUndefined();
    }
  });

  it('maps UNC shares without confusing siblings or device namespaces', () => {
    const unc = { workspaces: [{ id: 'share', projectLocation: '\\\\server\\share\\project' }] };
    expect(resolve('\\\\SERVER\\share\\project\\README.md:9', unc, true)).toEqual({ workspaceId: 'share', path: 'README.md' });
    expect(resolve('\\\\server\\other\\project\\README.md', unc)).toBeUndefined();
    expect(resolve('\\\\?\\C:\\project\\README.md', unc)).toBeUndefined();
  });

  it('ignores registrations that are remote URLs or relative directories', () => {
    const invalid = { workspaces: [{ id: 'remote', projectLocation: 'https://example.com/project' }, { id: 'relative', projectLocation: 'project' }] };
    expect(resolve('README.md', { ...invalid, workspaceId: 'remote' })).toBeUndefined();
    expect(resolve('/project/README.md', invalid)).toBeUndefined();
  });
});
