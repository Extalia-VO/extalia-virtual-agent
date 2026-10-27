import type { AgentHostApi } from '@extalia/platform';
import { useEffect, useState } from 'react';

/**
 * ADR 0028: a suggested integration test gate for a workspace, read from its project files. It is
 * only ever offered as a button; nothing is applied without the user choosing it.
 *
 * - `package.json` with a real `test` script: `pnpm test`, `yarn test` or `npm test`, by lockfile.
 * - otherwise `Cargo.toml`: `cargo test`.
 */

/** The placeholder `npm init` writes; it always fails, so it is no test suite. */
const NPM_PLACEHOLDER = /no test specified/i;

export function suggestGateCommand(files: readonly string[], packageJson?: string): string | undefined {
  const names = new Set(files);
  if (names.has('package.json') && packageJson !== undefined) {
    let test: unknown;
    try { test = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> } | null)?.scripts?.test; } catch { test = undefined; }
    if (typeof test === 'string' && test.trim() && !NPM_PLACEHOLDER.test(test)) {
      return names.has('pnpm-lock.yaml') ? 'pnpm test' : names.has('yarn.lock') ? 'yarn test' : 'npm test';
    }
  }
  if (names.has('Cargo.toml')) return 'cargo test';
  return undefined;
}

type FileReader = Pick<AgentHostApi, 'listFiles' | 'readFile'>;

/** Reads the project folder's top level (and `package.json`, when present) through the host's file API. */
export async function loadGateSuggestion(agents: FileReader, workspaceId: string): Promise<string | undefined> {
  const listing = await agents.listFiles(workspaceId);
  const files = listing.entries.filter(entry => entry.kind === 'file' && !entry.credential).map(entry => entry.name);
  const packageJson = files.includes('package.json') ? (await agents.readFile(workspaceId, 'package.json').catch(() => undefined))?.content : undefined;
  return suggestGateCommand(files, packageJson);
}

/** The suggestion for a saved workspace, or undefined (unknown workspace, unreadable folder, nothing found). */
export function useGateSuggestion(agents: Partial<FileReader>, workspaceId: string | undefined): string | undefined {
  const [result, setResult] = useState<{ workspaceId: string; command?: string }>();
  useEffect(() => {
    if (!workspaceId || typeof agents.listFiles !== 'function' || typeof agents.readFile !== 'function') return;
    let live = true;
    loadGateSuggestion(agents as FileReader, workspaceId).then(
      command => { if (live) setResult({ workspaceId, ...(command ? { command } : {}) }); },
      () => { if (live) setResult({ workspaceId }); },
    );
    return () => { live = false; };
  }, [agents, workspaceId]);
  return result && result.workspaceId === workspaceId ? result.command : undefined;
}
