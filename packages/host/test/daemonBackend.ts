/**
 * Test backends for native missions: today's TypeScript core and the Rust core daemon
 * (audit PR 8). The Rust backend needs the debug daemon (`cargo build -p extalia-daemon`,
 * which `pnpm check` runs first); without it those cases are skipped with a notice.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentHostOptions } from '../src/service.js';

export type Backend = 'typescript' | 'rust';
export const DAEMON_BINARY = fileURLToPath(new URL(`../../../target/debug/extalia-daemon${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
export const HAS_DAEMON = existsSync(DAEMON_BINARY);
let noticed = false;
/** Backends to parameterize suites over. */
export function backends(): Backend[] {
  if (!HAS_DAEMON && !noticed) {
    noticed = true;
    console.warn(`Rust core cases skipped: ${path.relative(process.cwd(), DAEMON_BINARY)} is not built (run: cargo build -p extalia-daemon).`);
  }
  return HAS_DAEMON ? ['typescript', 'rust'] : ['typescript'];
}
/** Host environment entries selecting `backend`. */
export function backendEnv(backend: Backend): Record<string, string> {
  return backend === 'rust' ? { EXTALIA_NATIVE_CORE: 'rust', EXTALIA_DAEMON_PATH: DAEMON_BINARY } : {};
}
/** Host options for `backend`; daemon diagnostics are collected instead of printed. */
export function backendOptions(backend: Backend, log: string[] = []): Pick<AgentHostOptions, 'daemon'> {
  return backend === 'rust' ? { daemon: { log: line => { log.push(line); } } } : {};
}

export const coreFile = (data: string) => path.join(data, 'state', 'core.sqlite');
/** Read-only query of the daemon's store (tests only; the daemon is its single writer). */
export function queryCore<T>(data: string, sql: string, ...params: string[]): T[] {
  const db = new DatabaseSync(coreFile(data), { readOnly: true });
  try { return db.prepare(sql).all(...params) as T[]; } finally { db.close(); }
}
/** Make the daemon's next insert of an `eventType` journal record fail (rolled back by SQLite). */
export function failCoreEvent(data: string, eventType: string, trigger: string): void {
  const db = new DatabaseSync(coreFile(data));
  try { db.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON events WHEN NEW.event_type='${eventType}' BEGIN SELECT RAISE(ABORT, 'synthetic core failure'); END;`); } finally { db.close(); }
}
export function dropCoreTrigger(data: string, trigger: string): void {
  const db = new DatabaseSync(coreFile(data));
  try { db.exec(`DROP TRIGGER ${trigger};`); } finally { db.close(); }
}
