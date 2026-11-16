import path from 'node:path';
import { runMcpStdioServer } from './hooks/mcp.js';

/** Private per-invocation entry point. It never installs external application settings. */
export async function runObservedCliArchiveReader(args: readonly string[]): Promise<number> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !['--data', '--app', '--session'].includes(key) || !value || values.has(key)) return 2;
    values.set(key, value);
  }
  const extaliaHome = values.get('--data'), app = values.get('--app'), sessionId = values.get('--session');
  if (!extaliaHome || !path.isAbsolute(extaliaHome) || !sessionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(sessionId)
    || (app !== 'codex' && app !== 'claude' && app !== 'gemini')) return 2;
  return runMcpStdioServer({ extaliaHome, app, sessionId, continuityOnly: true });
}
