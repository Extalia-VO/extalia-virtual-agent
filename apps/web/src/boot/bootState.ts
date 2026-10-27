/**
 * App boot coordination: which top-level surface may mount. Pure so it can be
 * unit tested; `useBoot` feeds it host results and timers.
 *
 * - `loading`: preferences are applied, the host state is not known yet (Splash).
 * - `setup-required`: the host reports setup incomplete; only the SetupWizard mounts.
 * - `ready`: the shell mounts and lands on the 3D Office (`resolveLandingPage`).
 * - `recoverable-error`: the host could not be reached or took too long; Retry.
 *
 * The Splash is a transition, not evidence of sessions: `restoredSessionCount`
 * is the host's own count and stays undefined until the host answers.
 */
export type BootPhase = 'loading' | 'setup-required' | 'ready' | 'recoverable-error';
export type BootErrorCategory = 'host-unreachable' | 'timeout';

export interface BootState {
  phase: BootPhase;
  /** Version of this boot contract; bump when the setup/landing policy changes. */
  configVersion: number;
  hostReady: boolean;
  setupComplete: boolean;
  restoredSessionCount?: number;
  error?: { category: BootErrorCategory; recoverable: boolean; message?: string };
}

export const BOOT_CONFIG_VERSION = 2;
/** Shortest Splash when boot is fast, so it reads as a transition rather than a flicker. */
export const SPLASH_MIN_MS = 700;
/** After this long without a host answer the Splash offers Retry and diagnostics. */
export const BOOT_TIMEOUT_MS = 15_000;

export interface BootInput {
  /** Whether this platform has an agent host at all (false in the static web build). */
  agents: boolean;
  host: { setupComplete: boolean; sessions: readonly unknown[] } | null;
  error: string | null;
  timedOut: boolean;
}

export function resolveBootState(input: BootInput): BootState {
  const base = { configVersion: BOOT_CONFIG_VERSION };
  // Without an agent host there is nothing to set up or restore: the shell shows Get started.
  if (!input.agents) return { ...base, phase: 'ready', hostReady: false, setupComplete: false };
  if (input.host) {
    const known = { ...base, hostReady: true, setupComplete: input.host.setupComplete, restoredSessionCount: input.host.sessions.length };
    return { ...known, phase: input.host.setupComplete ? 'ready' : 'setup-required' };
  }
  if (input.error) return { ...base, phase: 'recoverable-error', hostReady: false, setupComplete: false, error: { category: 'host-unreachable', recoverable: true, message: input.error } };
  if (input.timedOut) return { ...base, phase: 'recoverable-error', hostReady: false, setupComplete: false, error: { category: 'timeout', recoverable: true } };
  return { ...base, phase: 'loading', hostReady: false, setupComplete: false };
}

/**
 * How much longer the Splash stays after boot settled: tops a fast boot up to
 * `SPLASH_MIN_MS`, adds nothing to a slow one. Errors show at once.
 */
export function splashHoldMs(phase: BootPhase, elapsedMs: number, minMs = SPLASH_MIN_MS): number {
  if (phase === 'loading' || phase === 'recoverable-error') return 0;
  return Math.max(0, minMs - Math.max(0, elapsedMs));
}
