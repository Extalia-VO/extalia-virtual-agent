import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type ComponentRef, type RefObject } from 'react';
import { MOUSE, TOUCH, type PerspectiveCamera } from 'three';
import { VaultGraphRenderer, type GraphOptions } from './vaultGraphRenderer';
import { useGraphTheme } from './graphTheme';
import { GRAPH_BACKGROUND } from './vaultGraphModel';

/**
 * The whole-vault 3D graph canvas (lazy chunk): a small R3F canvas that renders on demand, with
 * a bounded native pixel ratio. Its demand loop cannot drive Office's FPS controller.
 * The scene itself is `VaultGraphRenderer`.
 */
export type VaultGraphCanvasProps = Omit<GraphOptions, never>;

function GraphScene({ options, labels, fps }: { options: GraphOptions; labels: RefObject<HTMLDivElement | null>; fps: RefObject<HTMLDivElement | null> }) {
  const scene = useThree(state => state.scene);
  const camera = useThree(state => state.camera) as PerspectiveCamera;
  const gl = useThree(state => state.gl);
  const invalidate = useThree(state => state.invalidate);
  const controls = useRef<ComponentRef<typeof OrbitControls> | null>(null);
  const renderer = useRef<VaultGraphRenderer | null>(null);

  useEffect(() => {
    const created = new VaultGraphRenderer({ scene, camera, gl, invalidate, labels: labels.current, fps: fps.current });
    renderer.current = created;
    return () => { created.dispose(); renderer.current = null; };
  }, [scene, camera, gl, invalidate, labels, fps]);
  // Every render: the renderer applies only what changed.
  useEffect(() => {
    renderer.current?.setControls(controls.current);
    renderer.current?.update(options);
  });
  useFrame((state, delta) => renderer.current?.frame(state.size, delta, state.clock.elapsedTime));

  return (
    <>
      <fog attach="fog" args={[GRAPH_BACKGROUND, 200, 900]} />
      <OrbitControls key={options.dimensions ?? 3} ref={controls} makeDefault enableRotate={options.dimensions !== 2}
        mouseButtons={{ LEFT: options.dimensions === 2 ? MOUSE.PAN : MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
        touches={{ ONE: options.dimensions === 2 ? TOUCH.PAN : TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }} enableDamping dampingFactor={0.12} rotateSpeed={0.55} zoomSpeed={0.9} minDistance={6} maxDistance={5000}
        onStart={() => renderer.current?.userStart()} />
    </>
  );
}

export default function VaultGraphCanvas(props: VaultGraphCanvasProps) {
  const theme = useGraphTheme();
  const labels = useRef<HTMLDivElement>(null);
  const fps = useRef<HTMLDivElement>(null);
  const showFps = import.meta.env.DEV && props.showFps;
  return (
    <div className="vault-graph-canvas" style={{ backgroundColor: theme.background }}>
      <Canvas frameloop={showFps ? 'always' : 'demand'} dpr={[0, 1.25]} camera={{ fov: 50, near: 0.5, far: 20_000, position: [0, props.dimensions === 2 ? 0 : 40, 420] }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }} aria-hidden="true">
        <GraphScene options={{ ...props, showFps, theme }} labels={labels} fps={fps} />
      </Canvas>
      <div ref={labels} className="vault-graph-labels" aria-hidden="true" />
      {showFps && <div ref={fps} className="vault-graph-fps" aria-hidden="true">…</div>}
    </div>
  );
}
