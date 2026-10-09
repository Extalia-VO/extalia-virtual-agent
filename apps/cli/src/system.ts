import { spawn, type SpawnOptions } from 'node:child_process';
import { exitCodeFor } from './relaunch';
import { npmInstallCommand } from './update';

/** Real-process helpers behind the injected CLI host. */

export interface CommandSpec {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/** How to open a URL in the default browser on each OS. */
export function browserCommand(platform: string, url: string): CommandSpec {
  const options: SpawnOptions = { stdio: 'ignore', detached: true };
  if (platform === 'darwin') return { command: 'open', args: [url], options };
  // `start` is a cmd built-in; the empty title keeps it from treating the URL as the window title.
  // Verbatim arguments keep Node from escaping that empty title into literal quotes.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url], options: { ...options, windowsVerbatimArguments: true } };
  return { command: 'xdg-open', args: [url], options };
}

/** Open the URL; failures are reported, never fatal. */
export function openBrowser(url: string, platform: string, warn: (line: string) => void): void {
  const { command, args, options } = browserCommand(platform, url);
  const fail = () => warn(`Could not open a browser. Open ${url} yourself.`);
  try {
    const child = spawn(command, args, options);
    child.once('error', fail);
    child.once('exit', code => { if (code) fail(); });
    child.unref();
  } catch {
    fail();
  }
}

/** Run the npm update command with the terminal's stdio; resolves to npm's exit code. */
export function runNpmInstall(platform: string): Promise<number> {
  const { command, args, shell } = npmInstallCommand(platform);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(exitCodeFor(code, signal)));
  });
}
