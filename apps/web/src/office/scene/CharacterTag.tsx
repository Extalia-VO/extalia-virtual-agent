import { Html } from '@react-three/drei';
import type { Point3 } from './layout';

/**
 * Overhead name, shown only while the character is under the pointer (`revealed`).
 * Name only, no status or intent line, and never a focus or click target: the
 * agents board is the keyboard and screen-reader path to the same character.
 */
export function CharacterTag({ position, seated, revealed, name }: {
  position: Point3; seated: boolean; revealed: boolean; name: string;
}) {
  return <Html position={[position[0], position[1] + (seated ? 1.75 : 2.1), position[2]]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
    <span className={`office-character-tag ${revealed ? 'revealed' : ''}`} aria-hidden="true">{name}</span>
  </Html>;
}
