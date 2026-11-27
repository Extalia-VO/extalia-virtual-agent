import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildScaffoldFiles, isProtectedProjectPath } from '../src/projectProvisioning.js';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { SessionStore } from '../src/sessions.js';
import { workspaceSessionBoundaryKey } from '../src/workspaceBoundary.js';
import { useTempDirs } from './helpers.js';

const execFileAsync = promisify(execFile);
const temp = useTempDirs();
const runtimes = new Set<AgentHostRuntime>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...runtimes].map(runtime => runtime.close()));
  runtimes.clear();
});

type Call = { name: string; args: Record<string, unknown> };
type Body = {
  model: string;
  messages: { role: string; content: string }[];
  tools?: { function?: { name?: string }; name?: string }[];
};

function reply(calls: Call[] = [], text = 'Ready'): Response {
  const delta = calls.length
    ? { tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
    : { content: text };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function toolNames(body: Body): string[] {
  return (body.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? '').filter(Boolean);
}

function currentToolResults(body: Body): string {
  return body.messages.slice(body.messages.map(message => message.role).lastIndexOf('user') + 1)
    .filter(message => message.role === 'tool').map(message => message.content).join('\n');
}

async function settled(runtime: AgentHostRuntime) {
  await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 10 });
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Example User',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'Example User',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

async function setup({
  script = () => reply(),
  envOverride = {},
}: {
  script?: (body: Body) => Response | Promise<Response>;
  envOverride?: Readonly<Record<string, string | undefined>>;
} = {}) {
  const root = await temp('extalia-provision-');
  const homeDirectory = path.join(root, 'home');
  const dataDirectory = path.join(root, 'extalia-home');
  const projectsParent = path.join(homeDirectory, 'projects');
  await mkdir(projectsParent, { recursive: true });
  const bodies: Body[] = [];
  const runtime = await createAgentHost({
    kind: 'bridge',
    version: 'test',
    dataDirectory,
    homeDirectory,
    importHome: homeDirectory,
    env: {
      PATH: process.env.PATH,
      HOME: homeDirectory,
      EXTALIA_HOME: dataDirectory,
      EXTALIA_SECRET_STORE: 'memory',
      HERMES_MANAGED_DIR: path.join(root, 'managed-missing'),
      ...envOverride,
    },
    modelDiscovery: async () => ['model-a'],
    fetch: async (url, init) => {
      if (/\/models$/.test(url)) return Response.json({ data: [{ id: 'model-a' }] });
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      return script(body);
    },
  });
  runtimes.add(runtime);
  const state = await runtime.host.saveConnection({
    name: 'Primary connection',
    preset: 'custom',
    api: 'openai-chat',
    baseUrl: 'http://mock.example/v1',
    model: 'model-a',
    credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off', history: true },
  });
  const connectionId = state.connections[0]!.id;
  return {
    root,
    homeDirectory,
    dataDirectory,
    projectsParent,
    connectionId,
    bodies,
    store: new SessionStore(path.join(dataDirectory, 'sessions')),
    runtime,
    host: runtime.host,
  };
}

describe('project provisioning safety helpers', () => {
  it('blocks filesystem roots, home directory, data directory, credential paths, and OS system roots while allowing temp and home subfolders', async () => {
    const root = await temp('extalia-protected-');
    const homeDirectory = path.join(root, 'home');
    const dataDirectory = path.join(root, 'extalia-data');
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    const realHome = await realpath(homeDirectory);
    const realData = await realpath(dataDirectory);

    const hostOpts = { homeDirectory: realHome, dataDirectory: realData };
    expect(await isProtectedProjectPath(realHome, hostOpts)).toBe('Choose a project subfolder instead of your entire home directory.');
    expect(await isProtectedProjectPath(realData, hostOpts)).toBe('Cannot use Extalia’s data directory as a project folder.');
    expect(await isProtectedProjectPath(path.join(realData, 'sessions'), hostOpts)).toBe('Cannot use Extalia’s data directory as a project folder.');
    expect(await isProtectedProjectPath(path.join(realHome, '.ssh'), hostOpts)).toMatch(/credential/i);
    expect(await isProtectedProjectPath(path.join(realHome, '.ssh', 'keys'), hostOpts)).toMatch(/credential/i);
    expect(await isProtectedProjectPath(path.join(realHome, '.aws', 'credentials'), hostOpts)).toMatch(/credential/i);
    expect(await isProtectedProjectPath(path.join(realHome, 'app', '.env'), hostOpts)).toMatch(/credential/i);
    expect(await isProtectedProjectPath(path.join(realHome, 'projects', 'my-app'), hostOpts)).toBeUndefined();

    const posixOpts = { homeDirectory: '/Users/example', dataDirectory: '/Users/example/.extalia-vo', platform: 'darwin' as const };
    expect(await isProtectedProjectPath('/', posixOpts)).toMatch(/filesystem root/i);
    expect(await isProtectedProjectPath('/Users/example', posixOpts)).toBe('Choose a project subfolder instead of your entire home directory.');
    expect(await isProtectedProjectPath('/Users/example/.extalia-vo', posixOpts)).toBe('Cannot use Extalia’s data directory as a project folder.');
    expect(await isProtectedProjectPath('/Users/example/.extalia-vo/sessions', posixOpts)).toBe('Cannot use Extalia’s data directory as a project folder.');
    expect(await isProtectedProjectPath('/Users/example/.ssh/keys', posixOpts)).toMatch(/credential/i);
    expect(await isProtectedProjectPath('/Users/example/projects/my-app', posixOpts)).toBeUndefined();

    for (const systemPath of [
      '/etc', '/private/etc/hosts', '/bin', '/sbin', '/usr/local',
      '/System', '/System/Library', '/Library', '/proc/self', '/sys', '/dev', '/boot', '/root',
    ]) {
      expect(await isProtectedProjectPath(systemPath, posixOpts)).toMatch(/system/i);
    }

    // Explicitly allowed macOS/POSIX temp directories.
    expect(await isProtectedProjectPath('/var/folders/xx/my-project', posixOpts)).toBeUndefined();
    expect(await isProtectedProjectPath('/private/var/folders/xx/my-project', posixOpts)).toBeUndefined();
    expect(await isProtectedProjectPath('/tmp/my-project', posixOpts)).toBeUndefined();
    expect(await isProtectedProjectPath('/private/tmp/my-project', posixOpts)).toBeUndefined();

    // Windows rules tested cross-platform.
    const winOpts = { homeDirectory: 'C:\\Users\\example', dataDirectory: 'C:\\Users\\example\\.extalia-vo', platform: 'win32' as const };
    expect(await isProtectedProjectPath('C:\\', winOpts)).toMatch(/filesystem root/i);
    expect(await isProtectedProjectPath('c:\\users\\example', winOpts)).toBe('Choose a project subfolder instead of your entire home directory.');
    expect(await isProtectedProjectPath('C:\\Users\\example\\.extalia-vo\\sessions', winOpts)).toBe('Cannot use Extalia’s data directory as a project folder.');
    expect(await isProtectedProjectPath('C:\\Windows', winOpts)).toMatch(/system/i);
    expect(await isProtectedProjectPath('c:\\windows\\system32', winOpts)).toMatch(/system/i);
    expect(await isProtectedProjectPath('C:\\Program Files\\Tool', winOpts)).toMatch(/system/i);
    expect(await isProtectedProjectPath('C:\\Program Files (x86)\\Tool', winOpts)).toMatch(/system/i);
    expect(await isProtectedProjectPath('C:\\Users\\example\\projects\\site', winOpts)).toBeUndefined();
  });

  it('builds deterministic static scaffold files without running commands', () => {
    expect(buildScaffoldFiles('none', 'Demo')).toEqual([]);
    expect(buildScaffoldFiles('basic-readme', 'Demo App').map(file => file.relativePath)).toEqual(['README.md', '.gitignore']);
    const nodeFiles = buildScaffoldFiles('node-ts-minimal', 'Demo App');
    expect(nodeFiles.map(file => file.relativePath)).toEqual(['README.md', '.gitignore', 'package.json', 'src/index.ts']);
    const pkg = JSON.parse(nodeFiles.find(file => file.relativePath === 'package.json')!.content) as { name: string; type: string };
    expect(pkg.name).toBe('demo-app');
    expect(pkg.type).toBe('module');
  });
});

describe('project provisioning host API (ADR 0099)', () => {
  it('performs zero disk, workspace, or session mutations during previewProjectProvision', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(null, { connectionId: ctx.connectionId });

    const preview = await ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'preview-only-app',
      templateId: 'node-ts-minimal',
      gitInit: true,
      connectionId: ctx.connectionId,
      attachSessionId: session.id,
    });

    expect(preview.mode).toBe('create');
    expect(preview.workspaceName).toBe('preview-only-app');
    expect(preview.permissions).toEqual({ fileWrite: 'ask', commands: 'ask' });
    expect(preview.crossWorkspaceAccess).toBe('read-only');
    expect(preview.requiresWarningAcknowledgement).toBe(false);
    expect(preview.plannedActions.map(action => action.kind)).toEqual([
      'create-folder', 'write-file', 'write-file', 'write-file', 'write-file', 'git-init', 'register-workspace', 'attach-session',
    ]);
    expect(preview.attachSession).toMatchObject({ sessionId: session.id, title: session.title, transfersHistory: false });

    await expect(stat(preview.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const state = await ctx.host.getState();
    expect(state.workspaces).toEqual([]);
    expect(state.sessions.find(item => item.id === session.id)?.workspaceId).toBeNull();
  });

  it('creates projects for none, basic-readme, and node-ts-minimal templates with safe git init and empty-dir reuse', async () => {
    const ctx = await setup();

    // 1. templateId: 'none'
    const nonePreview = await ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'bare-app',
      templateId: 'none',
      gitInit: false,
      connectionId: ctx.connectionId,
    });
    const noneReceipt = await ctx.host.applyProjectProvision!({ reviewId: nonePreview.reviewId });
    expect(noneReceipt.ok).toBe(true);
    expect(noneReceipt.partial).toBe(false);
    expect(noneReceipt.workspace?.permissions).toEqual({ fileWrite: 'ask', commands: 'ask' });
    expect(noneReceipt.workspace?.crossWorkspaceAccess).toBe('read-only');
    expect((await stat(noneReceipt.targetPath)).isDirectory()).toBe(true);
    await expect(stat(path.join(noneReceipt.targetPath, 'README.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    // Non-replayable consumed review
    await expect(ctx.host.applyProjectProvision!({ reviewId: nonePreview.reviewId })).rejects.toThrow(/expired or is invalid/i);

    // 2. templateId: 'basic-readme' on an existing empty directory
    const emptyDir = path.join(ctx.projectsParent, 'empty-reuse');
    await mkdir(emptyDir);
    const basicPreview = await ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'empty-reuse',
      templateId: 'basic-readme',
      gitInit: false,
      connectionId: ctx.connectionId,
    });
    expect(basicPreview.warnings.map(w => w.code)).toContain('existing-empty-directory');
    expect(basicPreview.requiresWarningAcknowledgement).toBe(false);
    expect(basicPreview.plannedActions.some(a => a.kind === 'create-folder')).toBe(false);

    const basicReceipt = await ctx.host.applyProjectProvision!({ reviewId: basicPreview.reviewId });
    expect(basicReceipt.ok).toBe(true);
    expect(basicReceipt.steps.find(step => step.step === 'create-folder')?.status).toBe('skipped');
    expect(await readFile(path.join(basicReceipt.targetPath, 'README.md'), 'utf8')).toContain('# empty-reuse');
    expect(await readFile(path.join(basicReceipt.targetPath, '.gitignore'), 'utf8')).toContain('.env');

    // 3. templateId: 'node-ts-minimal' + gitInit: true + isolated cross-workspace access
    const nodePreview = await ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'ts-starter',
      workspaceName: 'TS Starter',
      templateId: 'node-ts-minimal',
      gitInit: true,
      crossWorkspaceAccess: 'isolated',
      connectionId: ctx.connectionId,
    });
    const nodeReceipt = await ctx.host.applyProjectProvision!({ reviewId: nodePreview.reviewId });
    expect(nodeReceipt.ok).toBe(true);
    expect(nodeReceipt.partial).toBe(false);
    expect(nodeReceipt.workspace?.name).toBe('TS Starter');
    expect(nodeReceipt.workspace?.crossWorkspaceAccess).toBe('isolated');
    expect((await stat(path.join(nodeReceipt.targetPath, '.git'))).isDirectory()).toBe(true);
    expect(await readFile(path.join(nodeReceipt.targetPath, 'src', 'index.ts'), 'utf8')).toContain('Hello from TS Starter');
    const pkg = JSON.parse(await readFile(path.join(nodeReceipt.targetPath, 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('ts-starter');
    expect(nodeReceipt.state?.workspaces.some(w => w.id === nodeReceipt.workspace?.id)).toBe(true);
  });

  it('atomically creates a project and attaches an unassigned session, preserving history, workspaceFileScopes, and unlocking workspace tools', async () => {
    const ctx = await setup({
      script: body => currentToolResults(body)
        ? reply([], 'Read README successfully')
        : (toolNames(body).includes('read_file')
          ? reply([{ name: 'read_file', args: { path: 'README.md' } }])
          : reply([], 'Planned project while unassigned')),
    });

    const session = await ctx.host.createSession(null, { connectionId: ctx.connectionId });
    await ctx.host.sendPrompt(session.id, 'Plan a starter TypeScript project before creating the folder.');
    await settled(ctx.runtime);
    expect(toolNames(ctx.bodies[0]!)).toEqual([]);

    const preAttachMessages = await ctx.store.readMessages(session.id);
    const preAttachEvents = await ctx.host.sessionEvents(session.id);
    const lastPreAttachEventId = preAttachEvents.at(-1)!.id;

    const preview = await ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'attached-app',
      templateId: 'basic-readme',
      gitInit: true,
      connectionId: ctx.connectionId,
      attachSessionId: session.id,
    });
    expect(preview.attachSession).toMatchObject({
      sessionId: session.id,
      transfersHistory: true,
      permissionMode: 'workspace',
    });

    const receipt = await ctx.host.applyProjectProvision!({ reviewId: preview.reviewId });
    expect(receipt.ok).toBe(true);
    expect(receipt.partial).toBe(false);
    expect(receipt.attachedSessionId).toBe(session.id);
    expect(receipt.workspace).toBeDefined();
    expect(receipt.steps.find(step => step.step === 'attach-session')).toMatchObject({
      status: 'completed',
      target: session.id,
    });

    const stored = (await ctx.store.get(session.id))!;
    const expectedBoundary = workspaceSessionBoundaryKey(receipt.workspace!.id, receipt.state!.workspaces);
    expect(stored.workspaceId).toBe(receipt.workspace!.id);
    expect(stored.workspaceBoundary).toBe(expectedBoundary);
    expect(stored.reviewedContextBoundary).toBe(expectedBoundary);
    expect(stored.workspaceFileRoot).toBe(receipt.workspace!.projectLocation);
    expect(stored.workspaceFileScopes).toEqual([
      { throughEventId: lastPreAttachEventId, workspaceId: '', projectLocation: '' },
    ]);
    expect(await ctx.store.readMessages(session.id)).toEqual(preAttachMessages);
    expect(await ctx.host.sessionEvents(session.id)).toEqual(preAttachEvents);

    // Subsequent turn gains workspace tools and reads the scaffolded README.md.
    await ctx.host.sendPrompt(session.id, 'Inspect README.md in the new project.');
    await settled(ctx.runtime);
    expect(toolNames(ctx.bodies[1]!)).toEqual(expect.arrayContaining(['read_file', 'write_file']));
    expect(currentToolResults(ctx.bodies.at(-1)!)).toContain('# attached-app');
  });

  it('enforces dirty-repository and protected-branch warning gates, refuses git init on existing repos, and supports workspace reuse on attach', async () => {
    const ctx = await setup();
    const repoDir = path.join(ctx.projectsParent, 'existing-repo');
    await mkdir(repoDir, { recursive: true });
    await runGit(repoDir, ['init', '-b', 'main']);
    await writeFile(path.join(repoDir, 'tracked.txt'), 'initial\n');
    await runGit(repoDir, ['add', 'tracked.txt']);
    await runGit(repoDir, ['commit', '-m', 'initial']);
    await writeFile(path.join(repoDir, 'tracked.txt'), 'uncommitted user edit\n');
    await writeFile(path.join(repoDir, 'untracked.txt'), 'draft\n');

    // Refuse gitInit on an existing Git repo.
    await expect(ctx.host.previewProjectProvision!({
      mode: 'open',
      targetPath: repoDir,
      gitInit: true,
      connectionId: ctx.connectionId,
    })).rejects.toThrow('This folder is already a Git repository.');

    const preview = await ctx.host.previewProjectProvision!({
      mode: 'open',
      targetPath: repoDir,
      connectionId: ctx.connectionId,
    });
    expect(preview.gitInspection).toMatchObject({
      isGitRepo: true,
      branch: 'main',
      dirty: true,
      dirtyChangeCount: 2,
      protectedBranch: true,
    });
    expect(preview.warnings.map(warning => warning.code)).toEqual(expect.arrayContaining(['dirty-repository', 'protected-branch']));
    expect(preview.requiresWarningAcknowledgement).toBe(true);

    // Refuses apply without acknowledgeWarnings.
    await expect(ctx.host.applyProjectProvision!({ reviewId: preview.reviewId })).rejects.toThrow(/Acknowledge/i);
    // Review is still valid after refusal before execution; succeeds once acknowledged.
    const receipt = await ctx.host.applyProjectProvision!({ reviewId: preview.reviewId, acknowledgeWarnings: true });
    expect(receipt.ok).toBe(true);
    expect(receipt.steps.find(step => step.step === 'create-folder')?.status).toBe('skipped');
    expect(receipt.steps.find(step => step.step === 'register-workspace')?.status).toBe('completed');
    // Uncommitted user edits must be preserved verbatim.
    expect(await readFile(path.join(repoDir, 'tracked.txt'), 'utf8')).toBe('uncommitted user edit\n');
    expect(await readFile(path.join(repoDir, 'untracked.txt'), 'utf8')).toBe('draft\n');

    // Duplicate open without attachSessionId is refused.
    await expect(ctx.host.previewProjectProvision!({
      mode: 'open',
      targetPath: repoDir,
      connectionId: ctx.connectionId,
    })).rejects.toThrow(/A workspace already uses this folder/i);

    // Open with attachSessionId reuses the existing managed Extalia Native workspace.
    const unassigned = await ctx.host.createSession(null, { connectionId: ctx.connectionId });
    const reusePreview = await ctx.host.previewProjectProvision!({
      mode: 'open',
      targetPath: repoDir,
      attachSessionId: unassigned.id,
    });
    expect(reusePreview.existingWorkspaceId).toBe(receipt.workspace!.id);
    expect(reusePreview.warnings.map(warning => warning.code)).toContain('already-registered-workspace');
    expect(reusePreview.plannedActions.some(action => action.kind === 'register-workspace')).toBe(false);
    expect(reusePreview.plannedActions.some(action => action.kind === 'attach-session')).toBe(true);

    const reuseReceipt = await ctx.host.applyProjectProvision!({ reviewId: reusePreview.reviewId, acknowledgeWarnings: true });
    expect(reuseReceipt.ok).toBe(true);
    expect(reuseReceipt.workspace?.id).toBe(receipt.workspace!.id);
    expect(reuseReceipt.attachedSessionId).toBe(unassigned.id);
    expect(reuseReceipt.steps.find(step => step.step === 'register-workspace')?.status).toBe('skipped');
    expect(reuseReceipt.steps.find(step => step.step === 'attach-session')?.status).toBe('completed');
    expect((await ctx.host.getState()).workspaces).toHaveLength(1);
  });

  it('refuses protected paths, symlinks, non-empty targets, folder traversal, and invalid attach targets', async () => {
    const ctx = await setup();

    // Protected paths: home directory, data directory, credential directory.
    await expect(ctx.host.previewProjectProvision!({
      mode: 'open',
      targetPath: ctx.homeDirectory,
      connectionId: ctx.connectionId,
    })).rejects.toThrow('Choose a project subfolder instead of your entire home directory.');

    await expect(ctx.host.previewProjectProvision!({
      mode: 'open',
      targetPath: ctx.dataDirectory,
      connectionId: ctx.connectionId,
    })).rejects.toThrow('Cannot use Extalia’s data directory as a project folder.');

    const sshDir = path.join(ctx.homeDirectory, '.ssh');
    await mkdir(sshDir, { recursive: true });
    await expect(ctx.host.previewProjectProvision!({
      mode: 'open',
      targetPath: sshDir,
      connectionId: ctx.connectionId,
    })).rejects.toThrow(/credential/i);

    // Symlink refusals (open target including trailing slash, create target, create parent).
    const realProject = path.join(ctx.projectsParent, 'real-project');
    await mkdir(realProject);
    const linkProject = path.join(ctx.projectsParent, 'link-project');
    await symlink(realProject, linkProject);

    await expect(ctx.host.previewProjectProvision!({
      mode: 'open',
      targetPath: linkProject,
      connectionId: ctx.connectionId,
    })).rejects.toThrow('Symbolic links cannot be attached as project roots. Choose the real folder path instead.');

    await expect(ctx.host.previewProjectProvision!({
      mode: 'open',
      targetPath: `${linkProject}${path.sep}`,
      connectionId: ctx.connectionId,
    })).rejects.toThrow('Symbolic links cannot be attached as project roots. Choose the real folder path instead.');

    await expect(ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'link-project',
      connectionId: ctx.connectionId,
    })).rejects.toThrow('Symlinks cannot be used as project creation targets.');

    await expect(ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: linkProject,
      folderName: 'child',
      connectionId: ctx.connectionId,
    })).rejects.toThrow(/Symbolic links cannot be used as parent/i);

    // Existing file and non-empty directory refusals in create mode.
    await writeFile(path.join(ctx.projectsParent, 'regular-file'), 'hello');
    await expect(ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'regular-file',
      connectionId: ctx.connectionId,
    })).rejects.toThrow(/file already exists/i);

    const nonEmptyDir = path.join(ctx.projectsParent, 'non-empty');
    await mkdir(nonEmptyDir);
    await writeFile(path.join(nonEmptyDir, 'index.ts'), 'export {};\n');
    await expect(ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'non-empty',
      connectionId: ctx.connectionId,
    })).rejects.toThrow(/Use Open existing project instead/i);

    // Traversal & invalid folder names.
    for (const badName of ['..', '../escape', 'nested/name', 'nested\\name', '.hidden', 'CON', 'trailing.']) {
      await expect(ctx.host.previewProjectProvision!({
        mode: 'create',
        parentPath: ctx.projectsParent,
        folderName: badName,
        connectionId: ctx.connectionId,
      })).rejects.toThrow();
    }

    // Cannot attach unassigned Native session to a Hermes workspace.
    const unassigned = await ctx.host.createSession(null, { connectionId: ctx.connectionId });
    await expect(ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'hermes-target',
      runtimeId: 'hermes',
      attachSessionId: unassigned.id,
    })).rejects.toThrow(/Extalia Native workspace/i);

    // Cannot attach to an observe-only existing workspace.
    const observeDir = path.join(ctx.projectsParent, 'observe-folder');
    await mkdir(observeDir);
    await ctx.host.saveWorkspace({
      name: 'Observe Only',
      mode: 'observe',
      projectLocation: observeDir,
      permissions: { fileWrite: 'ask', commands: 'ask' },
    });
    await expect(ctx.host.previewProjectProvision!({
      mode: 'open',
      targetPath: observeDir,
      attachSessionId: unassigned.id,
    })).rejects.toThrow(/not a managed Extalia Native workspace/i);
  });

  it('invalidates stale reviews when target directory, Git status, or session state changes, and rejects expired reviews', async () => {
    const ctx = await setup();

    // 1. Stale create review: target becomes populated between preview and apply.
    const createPreview = await ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'race-folder',
      templateId: 'basic-readme',
      connectionId: ctx.connectionId,
    });
    await mkdir(createPreview.targetPath);
    await expect(ctx.host.applyProjectProvision!({ reviewId: createPreview.reviewId })).rejects.toThrow(/changed since review/i);

    // 2. Stale open review: clean repo becomes dirty between preview and apply.
    const repoDir = path.join(ctx.projectsParent, 'clean-repo');
    await mkdir(repoDir);
    await runGit(repoDir, ['init', '-b', 'feature/test']);
    await writeFile(path.join(repoDir, 'a.txt'), 'clean\n');
    await runGit(repoDir, ['add', 'a.txt']);
    await runGit(repoDir, ['commit', '-m', 'init']);

    const openPreview = await ctx.host.previewProjectProvision!({
      mode: 'open',
      targetPath: repoDir,
      connectionId: ctx.connectionId,
    });
    expect(openPreview.requiresWarningAcknowledgement).toBe(false);
    await writeFile(path.join(repoDir, 'dirty.txt'), 'new change\n');
    await expect(ctx.host.applyProjectProvision!({ reviewId: openPreview.reviewId })).rejects.toThrow(/changed since review/i);

    // 3. Stale attach review: session renamed between preview and apply.
    const session = await ctx.host.createSession(null, { connectionId: ctx.connectionId });
    const attachPreview = await ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'session-race',
      connectionId: ctx.connectionId,
      attachSessionId: session.id,
    });
    await ctx.host.renameSession(session.id, 'Renamed after preview');
    await expect(ctx.host.applyProjectProvision!({ reviewId: attachPreview.reviewId })).rejects.toThrow(/changed since review/i);

    // 4. Expired review rejected.
    const expiryPreview = await ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'expiry-folder',
      connectionId: ctx.connectionId,
    });
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiryPreview.expiresAt) + 1);
    await expect(ctx.host.applyProjectProvision!({ reviewId: expiryPreview.reviewId })).rejects.toThrow(/expired or is invalid/i);
  });

  it('reports itemized partial failure and prevents replay when git is unavailable on isolated PATH', async () => {
    const emptyBin = await temp('extalia-empty-path-');
    const ctx = await setup({ envOverride: { PATH: emptyBin } });

    // Open mode with gitInit on a non-git folder emits git-unavailable warning during preview.
    const plainDir = path.join(ctx.projectsParent, 'plain-no-git');
    await mkdir(plainDir);
    const openPreview = await ctx.host.previewProjectProvision!({
      mode: 'open',
      targetPath: plainDir,
      gitInit: true,
      connectionId: ctx.connectionId,
    });
    expect(openPreview.gitInspection.isGitRepo).toBe(false);
    expect(openPreview.warnings.map(warning => warning.code)).toContain('git-unavailable');

    // Create mode with scaffold + gitInit fails on step 3 (git-init) after creating folder & files.
    const createPreview = await ctx.host.previewProjectProvision!({
      mode: 'create',
      parentPath: ctx.projectsParent,
      folderName: 'partial-app',
      templateId: 'basic-readme',
      gitInit: true,
      connectionId: ctx.connectionId,
    });

    const receipt = await ctx.host.applyProjectProvision!({ reviewId: createPreview.reviewId });
    expect(receipt.ok).toBe(false);
    expect(receipt.partial).toBe(true);
    expect(receipt.mode).toBe('create');
    expect(receipt.workspace).toBeUndefined();
    expect(receipt.error).toMatch(/Git is not installed or not on the PATH/i);
    expect(receipt.steps).toEqual([
      { step: 'create-folder', status: 'completed', target: createPreview.targetPath },
      { step: 'write-file', status: 'completed', target: 'README.md' },
      { step: 'write-file', status: 'completed', target: '.gitignore' },
      expect.objectContaining({ step: 'git-init', status: 'failed', target: createPreview.targetPath }),
    ]);

    // Folder & files exist on disk, workspace was NOT registered, and reviewId was consumed (no replay).
    expect(await readFile(path.join(createPreview.targetPath, 'README.md'), 'utf8')).toContain('# partial-app');
    expect((await ctx.host.getState()).workspaces).toEqual([]);
    await expect(ctx.host.applyProjectProvision!({ reviewId: createPreview.reviewId })).rejects.toThrow(/expired or is invalid/i);
  });
});
