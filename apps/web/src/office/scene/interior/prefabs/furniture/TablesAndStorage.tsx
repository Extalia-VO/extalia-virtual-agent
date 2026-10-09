/** Furniture faces local +Z; keep that side accessible from the room. */
export function CoffeeTable({
  position = [0, 0, 0],
  rotationY = 0
}: {
  position?: [number, number, number];
  rotationY?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh castShadow receiveShadow position={[0, 0.38, 0]}>
        <boxGeometry args={[1.25, 0.07, 0.7]} />
        <meshStandardMaterial color="#a87b55" roughness={0.67} />
      </mesh>
      <mesh castShadow position={[0, 0.315, 0]}>
        <boxGeometry args={[1.19, 0.05, 0.64]} />
        <meshStandardMaterial color="#66574a" roughness={0.72} />
      </mesh>
      <mesh castShadow position={[0, 0.14, 0]}>
        <boxGeometry args={[1.03, 0.035, 0.48]} />
        <meshStandardMaterial color="#d1b69a" roughness={0.82} />
      </mesh>
      {[-0.49, 0.49].flatMap((x) =>
        [-0.23, 0.23].map((z) => (
          <mesh key={`${x}-${z}`} castShadow position={[x, 0.18, z]}>
            <cylinderGeometry args={[0.025, 0.025, 0.34, 8]} />
            <meshStandardMaterial color="#424f4e" metalness={0.4} roughness={0.5} />
          </mesh>
        ))
      )}
      <mesh position={[-0.27, 0.42, 0.04]} rotation={[0, -0.2, 0]}>
        <boxGeometry args={[0.35, 0.025, 0.25]} />
        <meshStandardMaterial color="#e5dbc5" roughness={0.9} />
      </mesh>
      <mesh castShadow position={[0.32, 0.45, -0.08]}>
        <cylinderGeometry args={[0.075, 0.07, 0.13, 12]} />
        <meshStandardMaterial color="#f1ede6" roughness={0.58} />
      </mesh>
    </group>
  );
}

export function Bookshelf({
  position = [0, 0, 0],
  rotationY = 0,
  width = 2.2,
  height = 2.25,
  doubleSided = false
}: {
  position?: [number, number, number];
  rotationY?: number;
  width?: number;
  height?: number;
  doubleSided?: boolean;
}) {
  const shelfLevels = [0.28, 0.91, 1.54, Math.min(height - 0.13, 2.17)];
  const bookColors = ["#5d7382", "#ab795c", "#7c927e", "#b7a181", "#746f89", "#9a6765"];
  const bookCount = Math.max(7, Math.floor((width - 0.26) / 0.16));

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Open office shelves are readable from both the room and corridor. */}
      {!doubleSided && <mesh castShadow position={[0, height / 2, -0.17]}>
        <boxGeometry args={[width, height, 0.055]} />
        <meshStandardMaterial color="#62594e" roughness={0.84} />
      </mesh>}
      {[-1, 1].map((side) => (
        <mesh key={side} castShadow position={[side * (width / 2 - 0.045), height / 2, 0]}>
          <boxGeometry args={[0.09, height, 0.43]} />
          <meshStandardMaterial color="#806953" roughness={0.75} />
        </mesh>
      ))}
      {shelfLevels.map((y, level) => (
        <group key={level}>
          <mesh castShadow position={[0, y, 0.02]}>
            <boxGeometry args={[width, 0.075, 0.43]} />
            <meshStandardMaterial color="#b09470" roughness={0.72} />
          </mesh>
          {level < 3 && Array.from({ length: bookCount }).map((_, i) => {
            const bookHeight = 0.39 + ((i * 7 + level * 3) % 4) * 0.035;
            return (
              <group key={i}>
                {(doubleSided ? [-1, 1] : [1]).map((side) => (
                  <mesh
                    key={side}
                    castShadow
                    position={[-width / 2 + 0.2 + i * (width - 0.4) / Math.max(1, bookCount - 1), y + 0.04 + bookHeight / 2, doubleSided ? side * 0.12 : 0.095]}
                    rotation={[0, 0, i % 7 === 0 ? -0.07 : 0]}
                  >
                    <boxGeometry args={[0.105 + (i % 3) * 0.012, bookHeight, doubleSided ? 0.13 : 0.21]} />
                    <meshStandardMaterial color={bookColors[(i + level * 2 + (side < 0 ? 3 : 0)) % bookColors.length]} roughness={0.85} />
                  </mesh>
                ))}
              </group>
            );
          })}
        </group>
      ))}
    </group>
  );
}

export function DisplayCabinet({
  position = [0, 0, 0],
  rotationY = 0,
  width = 3.8
}: {
  position?: [number, number, number];
  rotationY?: number;
  width?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh castShadow position={[0, 1.1, -0.2]}>
        <boxGeometry args={[width, 2.2, 0.055]} />
        <meshStandardMaterial color="#62594e" roughness={0.79} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} castShadow position={[side * (width / 2 - 0.05), 1.1, 0]}>
          <boxGeometry args={[0.1, 2.2, 0.5]} />
          <meshStandardMaterial color="#806953" roughness={0.77} />
        </mesh>
      ))}
      {[0.07, 0.77, 1.48, 2.16].map((y, i) => (
        <mesh key={i} castShadow position={[0, y, 0.02]}>
          <boxGeometry args={[width, 0.075, 0.5]} />
          <meshStandardMaterial color="#b89b78" roughness={0.73} />
        </mesh>
      ))}
      {[-width / 6, width / 6].map((x) => (
        <mesh key={`divider-${x}`} castShadow position={[x, 1.12, -0.08]}>
          <boxGeometry args={[0.045, 2.08, 0.37]} />
          <meshStandardMaterial color="#806953" roughness={0.78} />
        </mesh>
      ))}
      {Array.from({ length: Math.max(4, Math.floor(width / 0.48)) }).map((_, i) => (
        <mesh key={i} castShadow position={[-width / 2 + 0.35 + i * (width - 0.7) / Math.max(1, Math.floor(width / 0.48) - 1), 0.39, 0.04]}>
          <boxGeometry args={[0.25, 0.53, 0.28]} />
          <meshStandardMaterial color={i % 2 ? "#71857b" : "#a98c6f"} roughness={0.8} />
        </mesh>
      ))}
      {[-width / 4, width / 4].map((x) => (
        <mesh key={x} castShadow position={[x, 1.04, 0.03]}>
          <boxGeometry args={[0.48, 0.42, 0.27]} />
          <meshStandardMaterial color="#d3c1a0" roughness={0.85} />
        </mesh>
      ))}
      {[-width / 3, 0, width / 3].map((x, i) => (
        <group key={`vase-${i}`} position={[x, 1.63, 0.02]}>
          <mesh castShadow position={[0, 0.13, 0]}>
            <cylinderGeometry args={[0.09, 0.13, 0.25, 12]} />
            <meshStandardMaterial color={i === 1 ? "#d9c9af" : "#799087"} roughness={0.86} />
          </mesh>
          <mesh position={[0, 0.26, 0]}>
            <torusGeometry args={[0.09, 0.012, 6, 16]} />
            <meshStandardMaterial color="#d0b18a" roughness={0.73} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export function StorageCabinet({
  position = [0, 0, 0],
  rotationY = 0,
  width = 1.6
}: {
  position?: [number, number, number];
  rotationY?: number;
  width?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh castShadow position={[0, 0.55, 0]}>
        <boxGeometry args={[width, 1.1, 0.48]} />
        <meshStandardMaterial color="#b9b4a9" roughness={0.9} />
      </mesh>
      {[-0.25, 0.25].map((ratio) => (
        <mesh key={`door-${ratio}`} castShadow position={[width * ratio, 0.55, 0.247]}>
          <boxGeometry args={[width / 2 - 0.025, 0.99, 0.02]} />
          <meshStandardMaterial color="#dcd7cd" roughness={0.87} />
        </mesh>
      ))}
      <mesh position={[0, 1.11, 0]}>
        <boxGeometry args={[width + 0.06, 0.055, 0.53]} />
        <meshStandardMaterial color="#ad8867" roughness={0.75} />
      </mesh>
      {[-0.25, 0.25].map((ratio) => (
        <mesh key={ratio} position={[width * ratio + (ratio < 0 ? 0.15 : -0.15), 0.58, 0.267]}>
          <boxGeometry args={[0.02, 0.14, 0.018]} />
          <meshStandardMaterial color="#657471" metalness={0.45} roughness={0.42} />
        </mesh>
      ))}
    </group>
  );
}
