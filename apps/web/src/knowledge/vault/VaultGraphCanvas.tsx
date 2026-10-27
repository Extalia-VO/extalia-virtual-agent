import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type ComponentRef, type RefObject } from 'react';
import type { PerspectiveCamera } from 'three';
import { useBudgetPixelRatio } from '../../office/scene/environment/AdaptiveRenderBudget';
import { VaultGraphRenderer, type GraphOptions } from './vaultGraphRenderer';
import { GRAPH_BACKGROUND } from './vaultGraphModel';

/**
 * The whole-vault 3D graph canvas (lazy chunk): a small R3F canvas that renders on demand, with
 * the pixel ratio of the shared render budget. The scene itself is `VaultGraphRenderer`.
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
      <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.12} rotateSpeed={0.55} zoomSpeed={0.9} minDistance={6} maxDistance={5000}
        onStart={() => renderer.current?.userStart()} />
    </>
  );
}

export default function VaultGraphCanvas(props: VaultGraphCanvasProps) {
  const dpr = useBudgetPixelRatio();
  const labels = useRef<HTMLDivElement>(null);
  const fps = useRef<HTMLDivElement>(null);
  const showFps = import.meta.env.DEV && props.showFps;
  return (
    <div className="vault-graph-canvas">
      <Canvas frameloop={showFps ? 'always' : 'demand'} dpr={dpr} camera={{ fov: 50, near: 0.5, far: 20_000, position: [0, 40, 420] }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }} aria-hidden="true">
        <GraphScene options={{ ...props, showFps }} labels={labels} fps={fps} />
      </Canvas>
      <div ref={labels} className="vault-graph-labels" aria-hidden="true" />
      {showFps && <div ref={fps} className="vault-graph-fps" aria-hidden="true">…</div>}
    </div>
  );
}
