import { useEffect, useMemo, useRef } from 'react';
import { Color, Object3D, type Group } from 'three';
import { registerFixture, type RegisteredFixture } from '../../lighting/FixtureLighting';

/** Original finite beam and fixture geometry, registered in the shared irradiance volume. */
export function FixtureSpotLight({ position, aim, intensity, color = '#ffe2bc', distance = 7, angle = 0.8,
  penumbra = 0.65, shadow = false, name, floorY,
}: {
  position: [number, number, number]; aim: [number, number, number]; intensity: number;
  color?: string; distance?: number; angle?: number; penumbra?: number; shadow?: boolean; name?: string; floorY?: number;
}) {
  const anchor = useRef<Group>(null);
  const target = useMemo(() => new Object3D(), []);
  useEffect(() => {
    if (shadow || !anchor.current) return;
    const source: RegisteredFixture = { anchor: anchor.current, target, intensity, color: new Color(color), distance,
      angle, penumbra, name: name ?? 'fixture-beam', floorY };
    return registerFixture(source);
  }, [target, shadow, intensity, color, distance, angle, penumbra, name, floorY]);
  return <group ref={anchor} position={shadow ? [0, 0, 0] : position} userData={{ officeDynamic: true }}>
    <primitive object={target} position={shadow ? aim : [aim[0] - position[0], aim[1] - position[1], aim[2] - position[2]]} />
    {shadow && intensity > 0.001 && <spotLight name={name} position={position} target={target} intensity={intensity} color={color}
      distance={distance} angle={angle} penumbra={penumbra} decay={2} castShadow
      shadow-mapSize-width={512} shadow-mapSize-height={512} shadow-bias={-0.0002} shadow-normalBias={0.03} />}
  </group>;
}
