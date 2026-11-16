import { useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { subscribeContextRecovery, type OfficeContextState } from '../../contextRecovery';

/** Pausing the root retains geometry, camera and live character ownership during GPU loss. */
export function OfficeContextLifecycle({ onState }: { onState(state: OfficeContextState): void }) {
  const gl = useThree(state => state.gl);
  const recovery = useRef<ReturnType<typeof subscribeContextRecovery> | null>(null);
  useLayoutEffect(() => {
    const current = subscribeContextRecovery(gl.domElement, () => gl.getContext().isContextLost(), onState);
    recovery.current = current;
    return () => { current.dispose(); if (recovery.current === current) recovery.current = null; };
  }, [gl, onState]);
  useFrame(() => recovery.current?.frame(), -100);
  return null;
}
