import type { AgentHostApi, FileEntry, GitChange } from '@extalia/platform';

/**
 * Development-only fake project folder and Git state for the Files and Git
 * pages, the same for every workspace of the mock host.
 */

const FILES: Record<string, string> = {
  'package.json': '{\n  "name": "demo-app",\n  "private": true,\n  "scripts": {\n    "build": "vite build",\n    "test": "vitest run",\n    "test:coverage": "vitest run --coverage"\n  }\n}\n',
  'README.md': '# demo-app\n\nA small app used to try Extalia.\n\n## Scripts\n\n- `npm test` runs the tests\n- `npm run test:coverage` writes a coverage report\n',
  'src/main.ts': "import { renderLogin } from './login';\n\nrenderLogin(document.querySelector('#app')!);\n",
  'src/login.ts': "export function renderLogin(root: Element): void {\n  root.innerHTML = '<button disabled>Sign in</button>';\n  setTimeout(() => root.querySelector('button')?.removeAttribute('disabled'), 50);\n}\n",
  'src/login.test.ts': "it('logs in', async () => {\n  render(<Login />);\n  const button = await screen.findByRole('button', { name: 'Sign in' });\n  await waitFor(() => expect(button).toBeEnabled());\n  click(button);\n  expect(await screen.findByText('Welcome')).toBeVisible();\n});\n",
  'src/format.ts': `${Array.from({ length: 60 }, (_, index) => `export const label${index} = (value: number) => \`Item ${index}: \${value.toFixed(2)} — a deliberately long line so the viewer scrolls sideways instead of the page\`;`).join('\n')}\n`,
  'public/logo.png': '\0PNG',
};
const CREDENTIALS = new Set(['.env']);
const FOLDERS = ['src', 'public', 'node_modules'];

function entries(dir: string): FileEntry[] {
  const prefix = dir === '.' ? '' : `${dir}/`;
  const names = new Map<string, FileEntry>();
  for (const folder of FOLDERS) {
    if (dir === '.' && !folder.includes('/')) names.set(folder, { name: folder, path: folder, kind: 'dir', ...(folder === 'node_modules' ? { generated: true } : {}) });
  }
  for (const [file, content] of Object.entries(FILES)) {
    if (!file.startsWith(prefix) || file.slice(prefix.length).includes('/')) continue;
    names.set(file, { name: file.slice(prefix.length), path: file, kind: 'file', size: new TextEncoder().encode(content).length });
  }
  if (dir === '.') for (const name of CREDENTIALS) names.set(name, { name, path: name, kind: 'file', size: 64, credential: true });
  return [...names.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1));
}

const CHANGES: GitChange[] = [
  { path: 'package.json', index: 'unmodified', worktree: 'modified' },
  { path: 'src/login.test.ts', index: 'modified', worktree: 'unmodified' },
  { path: 'docs/guide.md', originalPath: 'docs/setup.md', index: 'renamed', worktree: 'unmodified' },
  { path: 'src/format.ts', index: 'unmodified', worktree: 'unmodified', untracked: true },
];

const DIFFS: Record<string, string> = {
  'package.json': 'diff --git a/package.json b/package.json\nindex 3b18e51..a1c2f0d 100644\n--- a/package.json\n+++ b/package.json\n@@ -4,6 +4,7 @@\n   "scripts": {\n     "build": "vite build",\n-    "test": "vitest run"\n+    "test": "vitest run",\n+    "test:coverage": "vitest run --coverage"\n   }\n }\n',
  'src/login.test.ts': "diff --git a/src/login.test.ts b/src/login.test.ts\nindex 52d0a1e..9f4be27 100644\n--- a/src/login.test.ts\n+++ b/src/login.test.ts\n@@ -1,5 +1,7 @@\n it('logs in', async () => {\n   render(<Login />);\n-  click(screen.getByText('Sign in'));\n+  const button = await screen.findByRole('button', { name: 'Sign in' });\n+  await waitFor(() => expect(button).toBeEnabled());\n+  click(button);\n   expect(await screen.findByText('Welcome')).toBeVisible();\n });\n",
  'docs/guide.md': 'diff --git a/docs/setup.md b/docs/guide.md\nsimilarity index 100%\nrename from docs/setup.md\nrename to docs/guide.md\n',
  'src/format.ts': `diff --git a/src/format.ts b/src/format.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/format.ts\n@@ -0,0 +1,60 @@\n${FILES['src/format.ts']!.split('\n').slice(0, -1).map(line => `+${line}`).join('\n')}\n`,
};

const normalize = (value: string | undefined) => (value ?? '.').replace(/^\.\/|\/$/g, '') || '.';

export function createMockWorkspaceInspection(check: (workspaceId: string) => void, latency: () => Promise<void>): Pick<AgentHostApi, 'listFiles' | 'readFile' | 'gitStatus' | 'gitDiff'> {
  return {
    async listFiles(workspaceId, dir) {
      check(workspaceId);
      await latency();
      const folder = normalize(dir);
      if (folder !== '.' && !FOLDERS.includes(folder)) throw new Error(`"${folder}" does not exist.`);
      return { path: folder, entries: entries(folder), truncated: false };
    },
    async readFile(workspaceId, file) {
      check(workspaceId);
      await latency();
      const name = normalize(file);
      if (CREDENTIALS.has(name)) throw new Error(`"${name}" looks like a credential file.`);
      const content = FILES[name];
      if (content === undefined) throw new Error(`"${name}" does not exist.`);
      const size = new TextEncoder().encode(content).length;
      if (content.includes('\0')) return { path: name, size, binary: true, lines: 0, truncated: false };
      return { path: name, size, binary: false, content, lines: content.split('\n').length - (content.endsWith('\n') ? 1 : 0), truncated: false };
    },
    async gitStatus(workspaceId) {
      check(workspaceId);
      await latency();
      return { repository: true, branch: 'main', commit: '9f4be27c1a2d', upstream: 'origin/main', ahead: 1, behind: 0, changes: structuredClone(CHANGES), truncated: false };
    },
    async gitDiff(workspaceId, file) {
      check(workspaceId);
      await latency();
      if (file === undefined) return { diff: CHANGES.map(change => DIFFS[change.path] ?? '').join(''), truncated: false };
      return { path: file, diff: DIFFS[normalize(file)] ?? '', truncated: false };
    },
  };
}
