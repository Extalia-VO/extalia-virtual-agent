/**
 * Validation and policy for a user-requested Desktop relaunch. Pure and free of
 * Electron so the rules can be unit tested; `restartIpc.ts` connects it to IPC.
 * This is separate from updates: `autoUpdater.quitAndInstall()` never runs here.
 */

export interface RestartRequest {
  /** The user confirmed that agent work still running may be stopped. */
  acknowledgeActiveWork: boolean;
}

const OPTION_KEYS = ['acknowledgeActiveWork'];

/** Accept only `undefined` or `{ acknowledgeActiveWork?: boolean }`; anything else is refused with a safe message. */
export function parseRestartRequest(value: unknown): RestartRequest {
  if (value === undefined) return { acknowledgeActiveWork: false };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Restart options must be an object.');
  // Own keys only; a key such as `__proto__` arrives as an own key and is refused here.
  if (Object.keys(value).some(key => !OPTION_KEYS.includes(key))) throw new Error('Unknown restart option.');
  const { acknowledgeActiveWork } = value as { acknowledgeActiveWork?: unknown };
  if (acknowledgeActiveWork === undefined) return { acknowledgeActiveWork: false };
  // `null` and other non-booleans are refused rather than read as "no".
  if (typeof acknowledgeActiveWork !== 'boolean') throw new Error('acknowledgeActiveWork must be true or false.');
  return { acknowledgeActiveWork };
}

export const ACTIVE_WORK_REFUSAL = 'An agent is still working. Confirm the restart to stop it.';

/** Why a relaunch must not start now, or undefined when it may. Idle hosts restart without extra confirmation. */
export function restartBlockReason(input: { smokeTest: boolean; busy: boolean; acknowledgeActiveWork: boolean }): string | undefined {
  if (input.smokeTest) return 'Restart is disabled during smoke tests.';
  if (input.busy && !input.acknowledgeActiveWork) return ACTIVE_WORK_REFUSAL;
  return undefined;
}
