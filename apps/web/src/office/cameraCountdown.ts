import { CAMERA_ARRIVAL_SETTLEMENT, CAMERA_ATTENTION_DELAY, CAMERA_WORKING_DWELL_MAX,
  type CameraDirectorInput, type CameraDirectorState } from './cameraDirector';

export interface CameraTourCountdown {
  targetId: string;
  seconds: number;
  windowSeconds: 5 | 10;
}

/** Preview the director's next ordinary visit after stepping its shared clock. */
export function cameraTourCountdown(state: CameraDirectorState, input: CameraDirectorInput): CameraTourCountdown | null {
  const command = state.command;
  if (!input.enabled || input.suspended || input.reducedMotion || state.pausedAt !== null
    || input.lastInteractionAt !== state.observedInteractionAt || state.heldAttentionId || input.attentionIds.length
    || command?.mode !== 'tour' || command.phase !== 'focus') return null;
  if (![input.now, input.lastInteractionAt, state.phaseStartedAt, state.dwellMs, state.pausedDuration, state.idleDelayMs].every(Number.isFinite)
    || state.dwellMs <= 0 || state.pausedDuration < 0 || state.idleDelayMs < 0
    || state.movementStoppedAt !== null && !Number.isFinite(state.movementStoppedAt)) return null;

  const tourIds = [...new Set([...input.workingIds, ...(input.idleIds ?? [])])];
  const index = tourIds.indexOf(command.targetId);
  if (index < 0 || tourIds.length < 2) return null;
  const targetId = tourIds[(index + 1) % tourIds.length]!;
  const continuingNewcomer = state.newcomerTargetId === command.targetId;
  const inactiveFor = Math.max(0, input.now - input.lastInteractionAt - state.pausedDuration);
  if (inactiveFor < (continuingNewcomer ? CAMERA_ATTENTION_DELAY : state.idleDelayMs)) return null;

  let deadline = state.phaseStartedAt + state.dwellMs;
  if (state.movementSeen) {
    const hardCap = state.phaseStartedAt + CAMERA_WORKING_DWELL_MAX;
    deadline = Math.max(deadline, state.movementStoppedAt === null ? hardCap
      : Math.min(hardCap, state.movementStoppedAt + CAMERA_ARRIVAL_SETTLEMENT));
  }
  if (continuingNewcomer) deadline = Math.max(deadline, input.lastInteractionAt + state.pausedDuration + state.idleDelayMs);
  const remaining = deadline - input.now;
  const windowSeconds = input.workingIds.includes(targetId) ? 10 : 5;
  return remaining > 0 && remaining <= windowSeconds * 1000
    ? { targetId, seconds: Math.ceil(remaining / 1000), windowSeconds } : null;
}
