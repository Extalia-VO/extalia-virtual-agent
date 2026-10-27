import { Component, Fragment, type ReactNode } from 'react';
import { createPortal, createRoot, extend, useFrame, type Catalogue, type ReconcilerRoot, type RootStore } from '@react-three/fiber';
import * as THREE from 'three';
import { CharacterBody } from '../../scene/avatars/OfficeCharacter';
import { avatarVisual, characterHeightCm } from '../../scene/avatars/appearance';
import { expressionStateForAgent, resolveCharacterExpression } from '../../scene/avatars/facialExpression';
import { PORTRAIT_FRAME_MS, portraitFrameInterval, portraitSubject, type PortraitSubject } from './model';

const WIDTH = 192;
const HEIGHT = 224;
const FRAME_MS = PORTRAIT_FRAME_MS;

interface Target {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  visible: boolean;
  ready: boolean;
  report: (ready: boolean) => void;
}

interface Entry {
  key: string;
  subject: PortraitSubject;
  targets: Set<Target>;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  failed: boolean;
}

function sameSubject(a: PortraitSubject, b: PortraitSubject) {
  return a.characterId === b.characterId && a.appearance === b.appearance &&
    a.identity === b.identity && a.activity === b.activity && a.motion === b.motion;
}

class PortraitBoundary extends Component<{ children: ReactNode; onFailure: () => void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch() { this.props.onFailure(); }
  override render() { return this.state.failed ? null : this.props.children; }
}

function PortraitScene({ entry, reducedMotion }: { entry: Entry; reducedMotion: boolean }) {
  const resolved = portraitSubject(entry.subject);
  return <>
    <hemisphereLight args={['#f2f6ff', '#9a8c83', 2.2]} />
    <directionalLight position={[2, 4, 4]} intensity={2.8} color="#fff5eb" />
    <directionalLight position={[-3, 2, 1]} intensity={1.1} color="#d8e8ff" />
    <CharacterBody id={resolved.id} appearance={resolved.appearance} seated={false} typing={false} reducedMotion={reducedMotion}
      expressionId={entry.subject.characterId} expressionState={resolveCharacterExpression(entry.subject.characterId, expressionStateForAgent(entry.subject.activity), entry.subject.motion)} />
  </>;
}

function PortraitFrames({ manager, entries }: { manager: PortraitRenderer; entries: Entry[] }) {
  // A positive priority takes over automatic rendering. All avatar useFrame callbacks
  // run first, then each scene is copied before this shared drawing buffer is reused.
  useFrame(({ gl }) => manager.paint(gl, entries), 1);
  return <>{entries.map(entry => <Fragment key={entry.key}>{createPortal(
    <PortraitBoundary onFailure={() => manager.failEntry(entry)}>
      <PortraitScene entry={entry} reducedMotion={manager.reducedMotion} />
    </PortraitBoundary>, entry.scene, { camera: entry.camera },
  )}</Fragment>)}</>;
}

/** One lazily allocated WebGL context for the entire application, never one per row. */
class PortraitRenderer {
  readonly entries = new Map<string, Entry>();
  reducedMotion = false;
  private root: ReconcilerRoot<HTMLCanvasElement> | null = null;
  private configured = false;
  private store: RootStore | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private frame = 0;
  private lastFrame = 0;
  private animationTime = 0;
  private dirty = true;
  private settlingFrames = 0;
  private failed = false;
  private disposed = false;
  private disposal: ReturnType<typeof setTimeout> | null = null;
  private motionQuery: MediaQueryList | null = null;
  private advancedFrames = 0;
  private renderedScenes = 0;
  private copiedFrames = 0;

  constructor() {
    this.motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    this.reducedMotion = this.motionQuery?.matches ?? false;
    this.motionQuery?.addEventListener('change', this.onMotion);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  attach(canvas: HTMLCanvasElement, subject: PortraitSubject, report: (ready: boolean) => void) {
    if (this.disposal) { clearTimeout(this.disposal); this.disposal = null; }
    const context = canvas.getContext('2d');
    if (!context || this.failed) return { update: (_subject: PortraitSubject) => {}, setVisible: (_visible: boolean) => {}, remove: () => {} };
    const resolved = portraitSubject(subject);
    let entry = this.entries.get(resolved.key);
    if (!entry) {
      const height = characterHeightCm(avatarVisual(resolved.id, resolved.appearance)) / 100;
      // Keep the same crown clearance (1.08 × standing height), but crop below
      // the shoulders so expressions remain legible in the small board tiles.
      const halfHeight = height * 0.15;
      const halfWidth = halfHeight * WIDTH / HEIGHT;
      const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.1, 10);
      camera.position.set(0, height * 0.93, 3);
      camera.lookAt(0, height * 0.93, 0);
      entry = { key: resolved.key, subject, targets: new Set(), scene: new THREE.Scene(), camera, failed: false };
      this.entries.set(entry.key, entry);
    }
    // Wait for IntersectionObserver before mounting models for offscreen rows.
    const target: Target = { canvas, context, visible: typeof IntersectionObserver === 'undefined', ready: false, report };
    entry.targets.add(target);
    const attachedEntry = entry;
    this.refresh();
    return {
      update: (next: PortraitSubject) => {
        if (sameSubject(attachedEntry.subject, next)) return;
        attachedEntry.subject = next;
        // Offscreen rows can retain the newest state without mounting or
        // reconciling every visible portrait. setVisible() refreshes on entry.
        if ([...attachedEntry.targets].some(item => item.visible)) this.refresh();
      },
      setVisible: (visible: boolean) => { if (visible === target.visible) return; target.visible = visible; this.refresh(); },
      remove: () => {
        attachedEntry.targets.delete(target);
        if (!attachedEntry.targets.size) this.entries.delete(attachedEntry.key);
        this.refresh();
        if (!this.entries.size) this.disposal = setTimeout(() => this.dispose(), 250);
      },
    };
  }

  failEntry(entry: Entry) {
    entry.failed = true;
    for (const target of entry.targets) { target.ready = false; target.report(false); }
  }

  diagnostics() {
    const entries = [...this.entries.values()];
    return {
      webglContexts: this.root && this.configured && !this.failed ? 1 : 0,
      subjects: entries.length,
      visibleScenes: this.visibleEntries().length,
      targets: entries.reduce((count, entry) => count + entry.targets.size, 0),
      visibleTargets: entries.reduce((count, entry) => count + [...entry.targets].filter(target => target.visible).length, 0),
      advancedFrames: this.advancedFrames, renderedScenes: this.renderedScenes, copiedFrames: this.copiedFrames,
      scheduled: Boolean(this.frame), reducedMotion: this.reducedMotion, failed: this.failed,
    };
  }

  inspectScenes() {
    return this.visibleEntries().map(entry => ({ characterId: entry.subject.characterId, scene: entry.scene, camera: entry.camera }));
  }

  paint(gl: THREE.WebGLRenderer, entries: Entry[]) {
    for (const entry of entries) {
      if (entry.failed) continue;
      let hasMesh = false;
      entry.scene.traverse(object => { if ((object as THREE.Mesh).isMesh) hasMesh = true; });
      // CharacterBody deliberately suspends its source model without a placeholder.
      if (!hasMesh) continue;
      gl.setClearColor(0x000000, 0);
      gl.clear();
      gl.render(entry.scene, entry.camera);
      this.renderedScenes += 1;
      for (const target of entry.targets) {
        if (!target.visible) continue;
        target.context.clearRect(0, 0, WIDTH, HEIGHT);
        target.context.drawImage(gl.domElement, 0, 0, WIDTH, HEIGHT);
        this.copiedFrames += 1;
        if (!target.ready) { target.ready = true; target.report(true); }
      }
    }
  }

  private visibleEntries() {
    return [...this.entries.values()].filter(entry => !entry.failed && [...entry.targets].some(target => target.visible));
  }

  private async initialize() {
    if (this.root || this.failed || this.disposed) return;
    const canvas = document.createElement('canvas');
    this.canvas = canvas;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    // A detached canvas is intentional: UI targets receive synchronous 2D copies.
    // No layout, pointer listener or additional displayed Canvas is needed.
    try {
      extend(Object.fromEntries(Object.entries(THREE).filter(([, value]) => typeof value === 'function')) as Catalogue);
      const root = createRoot(canvas);
      this.root = root;
      await root.configure({
        frameloop: 'never', dpr: 1, size: { width: WIDTH, height: HEIGHT, top: 0, left: 0 },
        gl: { alpha: true, antialias: true, powerPreference: 'low-power', preserveDrawingBuffer: false },
      });
      if (this.disposed) return;
      this.configured = true;
      this.refresh();
    } catch { this.failAll(); }
  }

  private refresh() {
    this.dirty = true;
    this.settlingFrames = 3;
    if (this.failed || this.disposed) return;
    const entries = this.visibleEntries();
    if (!this.root) { if (entries.length) void this.initialize(); return; }
    // configure resolves asynchronously. Rendering waits for its completed state.
    if (!this.configured) return;
    this.store = this.root.render(<PortraitFrames manager={this} entries={entries} />);
    if (entries.length && !document.hidden) this.schedule();
    else { cancelAnimationFrame(this.frame); this.frame = 0; this.lastFrame = 0; }
  }

  private schedule() {
    if (!this.frame && !this.failed && !this.disposed && !document.hidden) this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (time: number) => {
    this.frame = 0;
    const entries = this.visibleEntries();
    if (document.hidden || this.failed || this.disposed || !this.store || !entries.length) { this.lastFrame = 0; return; }
    const visibleSizes: Array<{ width: number; height: number }> = [];
    let pending = false;
    for (const entry of entries) for (const target of entry.targets) {
      if (!target.visible) continue;
      visibleSizes.push({ width: target.canvas.clientWidth, height: target.canvas.clientHeight });
      if (!target.ready) pending = true;
    }
    // Initial/load-settling frames stay responsive. A newly attached dialog or
    // changed subject is dirty and need not wait for the thumbnail interval.
    const interval = pending ? FRAME_MS : portraitFrameInterval(visibleSizes);
    const elapsed = this.lastFrame ? time - this.lastFrame : FRAME_MS;
    if (this.dirty || elapsed >= interval) {
      this.lastFrame = time;
      if (!this.reducedMotion || this.dirty || this.settlingFrames > 0 || pending) {
        // Allow one display-frame of cadence quantization at 10 FPS, without
        // slowing the pose clock; the existing long-stall cap stays at 15 FPS.
        this.animationTime += Math.min(elapsed, Math.max(100, interval + 1000 / 60)) / 1000;
        this.dirty = false;
        this.settlingFrames = Math.max(0, this.settlingFrames - 1);
        try { this.store.getState().advance(this.animationTime, false); this.advancedFrames += 1; } catch { this.failAll(); return; }
      }
    }
    pending = entries.some(entry => [...entry.targets].some(target => target.visible && !target.ready));
    if (!this.reducedMotion || this.dirty || this.settlingFrames > 0 || pending) this.schedule();
  };

  private onMotion = () => { this.reducedMotion = this.motionQuery?.matches ?? false; this.refresh(); };
  private onVisibility = () => { this.lastFrame = 0; this.refresh(); };
  private onContextLost = (event: Event) => { event.preventDefault(); this.failAll(); };

  private failAll() {
    this.failed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const entry of this.entries.values()) this.failEntry(entry);
    this.root?.unmount();
    this.root = null;
  }

  private dispose() {
    if (this.entries.size) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.motionQuery?.removeEventListener('change', this.onMotion);
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost);
    this.root?.unmount();
    this.root = null;
    if (shared === this) shared = null;
  }
}

let shared: PortraitRenderer | null = null;

export function attachPortrait(canvas: HTMLCanvasElement, subject: PortraitSubject, report: (ready: boolean) => void) {
  shared ??= new PortraitRenderer();
  return shared.attach(canvas, subject, report);
}

/** Read-only counters for browser QA; inspecting them never allocates a context. */
export function getPortrait3DDiagnostics() {
  return shared?.diagnostics() ?? {
    webglContexts: 0, subjects: 0, visibleScenes: 0, targets: 0, visibleTargets: 0,
    advancedFrames: 0, renderedScenes: 0, copiedFrames: 0, scheduled: false, reducedMotion: false, failed: false,
  };
}

/** Development inspection only: returns existing models and never creates a renderer. */
export function getPortrait3DScenes(): ReadonlyArray<{
  readonly characterId: string;
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
}> {
  return import.meta.env.DEV ? shared?.inspectScenes() ?? [] : [];
}
