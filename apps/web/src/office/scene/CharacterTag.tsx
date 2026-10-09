import { Html } from '@react-three/drei';
import type { OfficeAgent } from '../presence';
import type { Point3 } from './layout';
import { officeCharacterStatusColor } from './avatars/OfficeCharacter';

/**
 * Name and status above a character, so people can be found and picked at
 * whole-floor zoom where a figure is only a few pixels tall.
 */
export function CharacterTag({ agent, position, seated, selected, label, onSelect }: {
  agent: OfficeAgent; position: Point3; seated: boolean; selected: boolean; label: string; onSelect: (id: string) => void;
}) {
  return <Html position={[position[0], position[1] + (seated ? 1.75 : 2.1), position[2]]} center zIndexRange={[10, 0]}>
    <button type="button" className={`office-character-tag ${selected ? 'selected' : ''}`} aria-pressed={selected} aria-label={label}
      onClick={event => { event.stopPropagation(); onSelect(agent.id); }}>
      <span className="office-character-dot" style={{ background: officeCharacterStatusColor(agent) }} aria-hidden="true" />
      <span className="office-character-name">{agent.displayName}</span>
    </button>
  </Html>;
}
