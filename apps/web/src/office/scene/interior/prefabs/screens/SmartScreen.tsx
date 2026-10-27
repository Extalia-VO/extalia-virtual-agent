import { useEffect, useMemo, useRef } from 'react';
import type { Group } from 'three';
import type { SmartScreenData } from '../../screenData';
import { useFurnishedFloorState, useInteriorText } from '../../FurnishedFloorContext';
import { useSolarEnvironment } from '../../../Environment';
import {
  boardFromAgents, buildSurfaceSpec, occupantFromAgent, phaseFor, resolveScreenContent, surfaceGeometry,
  type ScreenDevice, type ScreenKind, type ScreenVariant,
} from './screenContent';
import { ScreenGlow, type DeskPool } from './screenGlow';
import { glowLayers, isNight, screenCastStrength, screenLightPriority } from './screenLightBudget';
import { displayEmission, LOCKED_BACKLIGHT } from './screenPhotometry';
import { registerScreenEmitter, updateScreenEmitter, type ScreenEmitter } from './screenEmitterRegistry';
import { screenTextures, type ScreenConsumer, type ScreenSurface } from './screenTextureHost';
import { shouldAnimateScreen } from './screenView';
import { WorkstationPart } from '../../WorkstationPart';
import WORKSTATION_PROFILE from '../../workstationAssetProfile.json';

export type { ScreenVariant } from './screenContent';

const LOCKED_FACE_TINT = '#dbe7ed';
const spillTint = (color: readonly [number, number, number]): [number, number, number] =>
  [0.45 + 0.55 * color[0], 0.45 + 0.55 * color[1], 0.45 + 0.55 * color[2]];
/** Kinds whose heading is an authored room label worth drawing. */
const TITLED_KINDS: ReadonlySet<ScreenKind> = new Set(['agents', 'docs', 'monitoring', 'diagram', 'signage']);

/**
 * A powered panel: bezel, glass, power light. Its picture comes from the shared screen cache
 * (see `screenContent` for what a given device, desk slot and seated agent show) and its colour and
 * brightness feed the scene's device lighting. With nobody home it shows an animated lock screen
 * that continues glowing when room lamps are turned off.
 */
export function SmartScreen({
  data: authoredData, resourceId, position = [0, 0, 0], rotationY = 0,
  width = 2.8, height = 1.55, bezel = 0.055, depth = 0.06,
  variant, device, slot = 1, slots = 1, idleContent, powered = true, deskPool, housingAsset, frame = true,
}: {
  data: SmartScreenData; resourceId?: string; position?: [number, number, number]; rotationY?: number;
  width?: number; height?: number; bezel?: number; depth?: number;
  variant?: ScreenVariant;
  /** Physical device; defaults to a desk monitor for small panels and a wall panel otherwise. */
  device?: ScreenDevice;
  /** Role on a multi-screen desk (1 = main/editor, 2 = terminal/tests, 3 = docs) and how many screens it has. */
  slot?: number; slots?: number;
  /** What an unoccupied workstation screen shows. */
  idleContent?: 'lock' | 'welcome';
  powered?: boolean;
  /** Where the screen's glow lands on the desk, in this panel's local frame. */
  deskPool?: DeskPool;
  /** Replace only the housing; the live picture, emitters and status LED stay in this component. */
  housingAsset?: 'monitor-shell';
  frame?: boolean;
}) {
  const state = useFurnishedFloorState();
  const t = useInteriorText();
  const env = useSolarEnvironment();
  const group = useRef<Group>(null);
  const seatId = resourceId ?? authoredData.resourceId;
  const resolvedDevice: ScreenDevice = device ?? (width <= 1.2 ? 'monitor' : 'wall');
  const wall = resolvedDevice === 'wall' || resolvedDevice === 'tv';
  const effectiveNight = env.lightOverride === 'off' ? 1 : env.state.factors.nightFactor;

  const allocation = seatId ? state.allocations.find(entry => entry.resourceId === seatId) : undefined;
  const agent = allocation ? state.agents.find(entry => entry.id === allocation.agentId) : undefined;
  const occupant = useMemo(() => occupantFromAgent(agent), [agent]);
  const resolved = resolveScreenContent({
    device: resolvedDevice, variant, slot, slots, occupant, idleContent, powered,
    lightsOn: env.lightsOn, night: isNight(effectiveNight), reducedMotion: env.reducedMotion,
  });
  const board = useMemo(() => (resolved.kind === 'agents' ? boardFromAgents(state.agents) : undefined), [resolved.kind, state.agents]);
  const titled = wall && TITLED_KINDS.has(resolved.kind);
  const spec = buildSurfaceSpec(resolved, surfaceGeometry(width, height), {
    language: state.language,
    phase: phaseFor(seatId ?? `${position.join(',')}:${rotationY}`),
    title: titled && authoredData.title ? t(authoredData.title) : undefined,
    subtitle: titled && authoredData.subtitle ? t(authoredData.subtitle) : undefined,
    board,
  });
  const lit = resolved.mode !== 'off';
  const backlight = resolved.mode === 'locked' ? LOCKED_BACKLIGHT : 1;
  // Desks where an agent is working claim the pooled spot lights before idle desks and wall boards.
  const priority = screenLightPriority(resolved, wall);
  // Obtained while rendering so the first frame already has its picture; the effect below holds it.
  const surface: ScreenSurface | null = lit ? screenTextures.obtain(spec) : null;
  const key = lit ? spec.key : '';

  useEffect(() => {
    const node = group.current;
    if (!node || !lit) return;
    const emitter: ScreenEmitter = {
      group: node, width, height, depth, intensity: 0, color: [0, 0, 0], priority,
      ...(seatId ? { cluster: seatId } : {}),
    };
    const unregister = registerScreenEmitter(emitter);
    const consumer: ScreenConsumer = {
      group: node,
      isVisible: () => shouldAnimateScreen(node, height),
      onPaint(painted) {
        const intensity = displayEmission(width * height, painted.luminance * backlight);
        const changed = Math.abs(intensity - emitter.intensity) > Math.max(0.5, emitter.intensity * 0.12);
        // Panel light reads close to white on nearby surfaces; the picture's hue only tints it.
        emitter.color = spillTint(painted.color);
        if (!changed) return;
        emitter.intensity = intensity;
        updateScreenEmitter();
      },
    };
    const release = screenTextures.retain(key, consumer);
    return () => { release(); unregister(); };
  }, [key, lit, width, height, depth, backlight, seatId, priority]);

  useEffect(() => {
    const node = group.current;
    if (!node || !import.meta.env.DEV) return;
    node.userData.screenDiagnostics = {
      resourceId: seatId, device: resolvedDevice, slot, slots, mode: resolved.mode, kind: resolved.kind,
      detail: resolved.detail, hot: resolved.hot, style: resolved.style, key: lit ? key : null,
    };
  });

  // Halo and desk pool only in a dark room (night, lamps off); otherwise the panel is emissive only.
  const castStrength = screenCastStrength(env.state.factors.nightFactor, env.lightsOn);
  const layers = useMemo(() => glowLayers(castStrength), [castStrength]);
  const resolvedPool = useMemo<DeskPool | undefined>(() => (
    deskPool ?? (wall ? { center: [0, -height / 2 - 0.32, 0.72], width: Math.max(1.8, width * 1.35), depth: 1.35 } : undefined)
  ), [deskPool, wall, width, height]);
  // A white page throws more light than a dark editor, while dark-room screens stay clearly luminous.
  const brightness = surface ? Math.max(0.52, Math.min(1, Math.sqrt(surface.luminance / 0.22))) * (resolved.mode === 'locked' ? 0.88 : 1) : 0;
  const ledColor = !lit ? '#2a1414' : resolved.mode === 'locked' ? '#c9a24d' : '#71f0ca';

  return <group ref={group} position={position} rotation={[0, rotationY, 0]} name="smart-screen">
    {frame && (housingAsset ? <WorkstationPart asset={housingAsset} modelScale={[
      (width + bezel) / (WORKSTATION_PROFILE.monitor.width + WORKSTATION_PROFILE.monitor.bezel),
      (height + bezel) / (WORKSTATION_PROFILE.monitor.height + WORKSTATION_PROFILE.monitor.bezel),
      depth / WORKSTATION_PROFILE.monitor.depth,
    ]}>
      <mesh><boxGeometry args={[width + bezel, height + bezel, depth]} /><meshStandardMaterial color="#101820" metalness={.34} roughness={.24} /></mesh>
    </WorkstationPart> : <mesh>
      <boxGeometry args={[width + bezel, height + bezel, depth]} />
      <meshStandardMaterial color="#101820" metalness={0.34} roughness={0.24} />
    </mesh>)}
    <mesh position={[0, 0, depth / 2 + 0.001]} userData={{ officeDynamic: true }}>
      <planeGeometry args={[width, height]} />
      {lit
        ? <meshBasicMaterial map={surface?.texture ?? null} color={surface ? (resolved.mode === 'locked' ? LOCKED_FACE_TINT : '#ffffff') : '#000000'} toneMapped={false} fog={false} />
        : <meshStandardMaterial color="#070b0e" metalness={0.55} roughness={0.16} />}
    </mesh>
    <mesh position={[-width / 2 + bezel * 0.38, -height / 2 - bezel * 0.22, depth / 2 + 0.003]} userData={{ officeDynamic: true }}>
      <circleGeometry args={[Math.max(0.008, bezel * 0.15), 12]} />
      <meshBasicMaterial color={ledColor} toneMapped={false} fog={false} />
    </mesh>
    {lit && surface && <ScreenGlow width={width} height={height} depth={depth} color={surface.color}
      layers={layers} brightness={brightness} pool={resolvedPool} />}
  </group>;
}
