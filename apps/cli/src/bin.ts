import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentHost } from '@extalia/host';
import { resolveDataDirectory } from '@extalia/platform';
import { run } from './cli';
import { takeRelaunchToken } from './relaunch';
import { startBridge } from './start';
import { openBrowser, runNpmInstall } from './system';
import { createUpdater, installKind, readInstalledVersion, runUpdateCommand } from './update';

declare const __CLI_VERSION__: string;

// Taken first so agents and the commands they run never inherit it.
const relaunchToken = takeRelaunchToken(process.env);
// The bundle itself (Node resolves the npm bin symlink); dist/web sits next to it.
const binPath = fileURLToPath(import.meta.url);
const homeDirectory = homedir();
const dataDirectory = resolveDataDirectory({ platform: process.platform, env: process.env, homeDirectory });
const out = (line: string) => { process.stdout.write(`${line}\n`); };
const err = (line: string) => { process.stderr.write(`${line}\n`); };

const updater = () => createUpdater({
  current: __CLI_VERSION__,
  kind: installKind(binPath),
  cacheFile: path.join(dataDirectory, 'state', 'update-check.json'),
  fetch: globalThis.fetch,
  runInstall: () => runNpmInstall(process.platform),
  installedVersion: () => readInstalledVersion(binPath),
});

const code = await run(process.argv.slice(2), {
  version: __CLI_VERSION__,
  out,
  err,
  readFile: file => readFile(file, 'utf8'),
  exists: file => access(file).then(() => true, () => false),
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  env: process.env,
  homeDirectory,
  start: options => startBridge(options, {
    version: __CLI_VERSION__,
    out,
    err,
    env: process.env,
    dataDirectory,
    webRoot: path.join(path.dirname(binPath), 'web'),
    ...(relaunchToken ? { token: relaunchToken } : {}),
    createAgentHost,
    updater: updater(),
    openBrowser: url => openBrowser(url, process.platform, err),
    signals: process,
    relaunch: { execPath: process.execPath, execArgv: process.execArgv, binPath, args: process.argv.slice(2) },
    spawn: (command, args, options) => spawn(command, args, options),
  }),
  update: options => runUpdateCommand(options, updater(), { out, err }),
});
process.exitCode = code;
// Exit even if a library left a handle open (for example the agent host after a timed-out close).
setTimeout(() => process.exit(code), 1000).unref();
