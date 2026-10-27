import { describe, expect, it, vi } from 'vitest';
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { classifyRoomEnvelope } from '../src/office/scene/interior/roomEnvelope';
import { roomById, type CampusRoom } from '../src/office/scene/interior/worldRegistry';
import { RoomShell } from '../src/office/scene/interior/RoomShell';
import { EnvelopeWall } from '../src/office/scene/interior/ExteriorEnvelopeContext';
import { OpenDoor } from '../src/office/scene/interior/prefabs/architecture/OpenDoor';
import { SlidingDoor } from '../src/office/scene/interior/prefabs/architecture/SlidingDoor';
import { SolidWall } from '../src/office/scene/interior/prefabs/architecture/SolidWall';
import { WindowWall } from '../src/office/scene/interior/prefabs/architecture/WindowWall';

vi.mock('../src/office/scene/interior/FloorVisibilityContext', () => ({ useFloorVisible: () => true }));

function room(id: string): CampusRoom {
  const value = roomById(id);
  if (!value) throw new Error('Missing test room');
  return value;
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return [child as ReactElement<Record<string, unknown>>, ...elements(child.props.children)];
  });
}

function shell(id: string, props: Partial<Parameters<typeof RoomShell>[0]> = {}) {
  const value = room(id);
  return RoomShell({ roomId: id, label: 'Test room', position: [0, 0, 0], size: value.size, ...props });
}

function wall(tree: ReactNode, face: string) {
  const result = elements(tree).find(element => element.type === EnvelopeWall && (element.props.name as string).endsWith(`:${face}`));
  if (!result) throw new Error('Missing wall wrapper');
  return result;
}

describe('room exterior envelope classification', () => {
  it('classifies actual perimeter corners while keeping corridor-facing windows and adjoining partitions internal', () => {
    expect(classifyRoomEnvelope(room('library'))).toEqual({ north: false, south: true, west: true, east: false });
    expect(classifyRoomEnvelope(room('entertainment'))).toEqual({ north: false, south: true, west: false, east: true });
    expect(classifyRoomEnvelope(room('executive'))).toEqual({ north: true, south: false, west: true, east: false });
    expect(classifyRoomEnvelope(room('meeting-a'))).toEqual({ north: false, south: false, west: true, east: false });
    expect(classifyRoomEnvelope(room('meeting-b'))).toEqual({ north: false, south: false, west: false, east: false });
    expect(classifyRoomEnvelope(room('operations')).west).toBe(false);
  });

  it('uses the third-floor setback without interpreting the terrace edge as the rear of floors one and two', () => {
    expect(classifyRoomEnvelope(room('sky-lounge'))).toEqual({ north: true, south: false, west: true, east: false });
    expect(classifyRoomEnvelope(room('fitness'))).toEqual({ north: false, south: true, west: false, east: true });
    expect(classifyRoomEnvelope(room('executive-studio')).south).toBe(true);
    expect(classifyRoomEnvelope(room('research'))).toEqual({ north: false, south: false, west: false, east: false });
    const fitness = room('fitness');
    expect(classifyRoomEnvelope({ ...fitness, floor: 2 }).south).toBe(false);
  });

  it('allows small authored-plane rounding, without hiding recessed or invalid walls', () => {
    const original = room('executive');
    expect(classifyRoomEnvelope({ ...original, center: [original.center[0] + 0.05, 0, original.center[2]] }).west).toBe(true);
    expect(classifyRoomEnvelope({ ...original, center: [original.center[0] + 0.07, 0, original.center[2]] }).west).toBe(false);
    expect(classifyRoomEnvelope({ ...original, center: [original.center[0] + 2, 0, original.center[2]] }).west).toBe(false);
    expect(classifyRoomEnvelope({ ...original, size: [-1, 2] })).toEqual({ north: false, south: false, west: false, east: false });
    expect(classifyRoomEnvelope({ ...original, center: [NaN, 0, 0] })).toEqual({ north: false, south: false, west: false, east: false });
  });
});

describe('RoomShell envelope ownership', () => {
  it('keeps the internal opposite window wall, and groups each side wall with its skirting and cap', () => {
    const tree = shell('meeting-a', { entrySide: 'back', oppositeWall: 'windows' });
    const south = wall(tree, 'south');
    expect(south.props.exterior).toBe(false);
    expect(elements(south.props.children as ReactNode).filter(element => element.type === WindowWall)).toHaveLength(1);
    for (const face of ['west', 'east']) {
      const side = wall(tree, face);
      expect(side.props.exterior).toBe(face === 'west');
      const children = elements(side.props.children as ReactNode);
      expect(children.filter(element => element.type === SolidWall)).toHaveLength(1);
      expect(children.filter(element => element.type === 'mesh')).toHaveLength(2);
    }
  });

  it('wraps exterior north/south surfaces without wrapping furnishings or either door role', () => {
    const furnishing = createElement('test-furnishing');
    const tree = shell('sky-lounge', { entrySide: 'front', oppositeWall: 'windows', exteriorDoor: true, children: furnishing });
    expect(wall(tree, 'north').props.exterior).toBe(true);
    expect(wall(tree, 'south').props.exterior).toBe(false);
    const all = elements(tree);
    const doors = all.filter(element => element.type === OpenDoor);
    expect(doors.map(element => element.props.role)).toEqual(['exterior', 'entry']);
    const wrapped = all.filter(element => element.type === EnvelopeWall).flatMap(element => elements(element.props.children as ReactNode));
    expect(wrapped.some(element => element.type === OpenDoor || element.type === SlidingDoor)).toBe(false);
    expect(wrapped.some(element => element.type === 'test-furnishing')).toBe(false);
    expect(all.some(element => element.type === 'test-furnishing')).toBe(true);
  });

  it('preserves a sliding entry even when the entry wall itself faces the facade', () => {
    const tree = shell('fitness', { entrySide: 'front', doorType: 'sliding', glassEntry: false });
    expect(wall(tree, 'south').props.exterior).toBe(true);
    expect(wall(tree, 'east').props.exterior).toBe(true);
    const entry = elements(tree).find(element => element.type === SlidingDoor);
    expect(entry?.props).toMatchObject({ role: 'entry', roomId: 'fitness', width: 1.15 });
    expect(elements(wall(tree, 'south').props.children as ReactNode).some(element => element.type === SlidingDoor)).toBe(false);
    expect(elements(wall(tree, 'south').props.children as ReactNode).filter(element => element.type === SolidWall)).toHaveLength(2);
  });
});
