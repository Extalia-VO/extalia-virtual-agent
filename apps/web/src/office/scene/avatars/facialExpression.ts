import type { OfficeAgent } from '../../presence';
import type { CharacterMotion } from '../movement/walkCycle';
import { isBusy } from '../movement/workClip';

/** Cosmetic expression only: never changes the reported agent state or task progress. */
export type CharacterExpressionState = 'idle' | 'focused' | 'waiting' | 'talking' | 'moving' | 'offline';
export interface FacialPose {
  /** Zero is open; one closes the eyelids. */
  blink: number;
  gazeX: number;
  gazeY: number;
  headYaw: number;
  headPitch: number;
  yawn: number;
  mouthOpen: number;
  brow: number;
}
export function createFacialPose(): FacialPose {
  return { blink: 0, gazeX: 0, gazeY: 0, headYaw: 0, headPitch: 0, yawn: 0, mouthOpen: 0, brow: 0 };
}

type ExpressionAgent = Partial<Pick<OfficeAgent, 'status' | 'running' | 'control' | 'live' | 'activity' | 'phase' | 'earlier' | 'pendingApprovalId'>>;
export function expressionStateForAgent(agent?: ExpressionAgent): CharacterExpressionState {
  if (!agent) return 'idle';
  if (agent.earlier || agent.status === 'offline') return 'offline';
  if (agent.status === 'waiting' || agent.status === 'blocked' || agent.pendingApprovalId) return 'waiting';
  return agent.status && isBusy({ status: agent.status, control: agent.control, live: agent.live }) ? 'focused' : 'idle';
}

interface ExpressionBinding { state: CharacterExpressionState; motion?: CharacterMotion | undefined }
const bindings = new Map<string, ExpressionBinding>();
/** Scene characters own this binding; duplicate board/dialog portraits only read it. */
export function bindCharacterExpression(id: string, binding: ExpressionBinding): () => void {
  bindings.set(id, binding);
  return () => { if (bindings.get(id) === binding) bindings.delete(id); };
}
export function resolveCharacterExpression(id?: string, fallback: CharacterExpressionState = 'idle', motion?: CharacterMotion): CharacterExpressionState {
  const live = id ? bindings.get(id) : undefined;
  const current = live?.motion ?? motion;
  const state = live?.state ?? fallback;
  if (state === 'offline') return state;
  if (current && current.walk > 0.15) return 'moving';
  if (current?.clip === 'chat-talk' || current?.clip === 'bar-serve') return 'talking';
  return state;
}

/** One page-wide cosmetic clock keeps separately rendered portraits and the Office in phase. */
export function expressionTimeSeconds(): number {
  return typeof performance === 'undefined' ? 0 : performance.now() / 1000;
}

const smooth = (value: number) => { const x = Math.max(0, Math.min(1, value)); return x * x * (3 - 2 * x); };
/** Allocation-free deterministic expression: independently phased blinks, soft gaze and occasional idle yawns. */
export function writeFacialPose(out: FacialPose, seed: number, time: number, state: CharacterExpressionState, reducedMotion = false): FacialPose {
  out.blink = 0; out.gazeX = 0; out.gazeY = 0; out.headYaw = 0; out.headPitch = 0;
  out.yawn = 0; out.mouthOpen = 0; out.brow = state === 'focused' ? 0.32 : 0;
  if (reducedMotion || state === 'offline') return out;
  const phase = (seed >>> 0) % 1793 / 137;
  const t = Math.max(0, Number.isFinite(time) ? time : 0) + phase;
  const period = 3.2 + ((seed >>> 0) % 173) / 100;
  const blinkTime = t % period;
  const blink = blinkTime < 0.22 ? Math.sin(blinkTime / 0.22 * Math.PI) ** 2 : 0;
  const rest = state === 'idle' || state === 'waiting';
  const focus = state === 'focused';
  out.gazeX = (Math.sin(t * 0.37 + phase) * 0.7 + Math.sin(t * 1.9) * 0.12) * (focus ? 0.3 : 1);
  out.gazeY = Math.sin(t * 0.23 + phase) * (focus ? 0.12 : 0.28) - (focus ? 0.12 : 0);
  out.headYaw = Math.sin(t * 0.23 + phase) * (rest ? 0.055 : 0.012);
  out.headPitch = focus ? 0.015 : Math.sin(t * 0.19 + phase) * 0.014;
  if (rest) {
    // A rare quiet idle gesture, independent of how long a renderer has been mounted.
    const yawnTime = (t + phase * 7) % (47 + (seed >>> 0) % 23);
    if (yawnTime < 3.2) {
      out.yawn = smooth(yawnTime / 0.9) * (1 - smooth((yawnTime - 1.9) / 1.3));
      out.headPitch -= out.yawn * 0.065;
    }
  }
  out.blink = Math.max(blink, out.yawn * 0.85, state === 'waiting' ? 0.12 : 0);
  out.mouthOpen = out.yawn * 0.85 + (state === 'talking' ? (0.5 + Math.sin(t * 7.5) * 0.5) * 0.2 : 0);
  return out;
}
