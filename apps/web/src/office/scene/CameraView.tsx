/* eslint-disable react-hooks/immutability -- Three.js camera transforms are mutable renderer objects. */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { OrthographicCamera, type Vector3 } from 'three';
import type { FurnishedOfficeView } from './FurnishedFloors';
import type { CharacterFloor, CharacterPositionSource } from './movement/positionStore';
import { cameraProgress, buildingMinimumZoom, buildingOverviewPose, characterFocusPose, floorOverviewPose, stackOverviewPose, panelClearance, roomFocusZoom, type CameraPose, type FocusPoint } from './cameraFocus';
import type { Point3 } from './layout';

/** Closest zoom (pixels per metre): a standing character fills about 440 px. */
export const MAX_ZOOM = 260;
const lerp3 = (from: Point3, to: Point3, t: number): Point3 => [0, 1, 2].map(axis => from[axis]! + (to[axis]! - from[axis]!) * t) as Point3;

/**
 * Floor presets, plus an explicit move that frames the selected character at its
 * live position (`focus` is its seat as a fallback). With `following` the camera
 * then keeps a walking character in frame until the user drags the view;
 * `focusPoint` frames a point such as a room.
 */
export function CameraView({ view, viewRequest = 0, focus, focusId, live, focusRequest = 0, reducedMotion, following = false, focusPoint, onFollowEnd, onFollowFloor }: {
  view: FurnishedOfficeView; focus?: Point3; focusId?: string | null; live?: CharacterPositionSource; focusRequest?: number; reducedMotion: boolean;
  viewRequest?: number;
  following?: boolean; focusPoint?: FocusPoint | undefined; onFollowEnd?: (() => void) | undefined;
  onFollowFloor?: ((floor: CharacterFloor) => void) | undefined;
}) {
  const camera = useThree(s => s.camera);
  const size = useThree(s => s.size);
  const controls = useThree(s => s.controls) as unknown as { target: Vector3; minZoom: number; update(): void } | null;
  const move = useRef<{ elapsed: number; from: CameraPose; to: CameraPose } | null>(null);
  const follow = useRef<{ id: string; last: Point3; waiting: boolean } | null>(null);
  const followMode = useRef({ following, focusId });
  useLayoutEffect(() => { followMode.current = { following, focusId }; });
  const lastOverview = useRef<{ camera: typeof camera; controls: typeof controls; view: FurnishedOfficeView; request: number } | null>(null);
  const followEnd = useRef(onFollowEnd);
  useLayoutEffect(() => { followEnd.current = onFollowEnd; });
  const level = typeof view === 'number' ? (view - 1) * 6.4 : view === 'campus' ? 9.2 : 6.4;
  const floorPose = useMemo(() => typeof view === 'number' ? floorOverviewPose(level, size.width, size.height) : view === 'campus' ? buildingOverviewPose(size.width, size.height) : stackOverviewPose(size.width, size.height), [view, level, size.width, size.height]);
  const buildingZoomFloor = view === 'campus' ? buildingMinimumZoom(size.width, size.height, floorPose.position, floorPose.target) : 2;
  const target = floorPose.target;
  useLayoutEffect(() => {
    if (!(camera instanceof OrthographicCamera)) return;
    const previous = lastOverview.current;
    const explicitView = previous !== null && previous.request !== viewRequest;
    lastOverview.current = { camera, controls, view, request: viewRequest };
    // Resizing the stage (including opening detail panels) changes its projection,
    // but must preserve the user's orbit, pan and zoom. Fit only on mount/view requests.
    if (previous && previous.camera === camera && previous.controls === controls && previous.view === view && !explicitView) return;
    // Changing the visible floor during Follow must not reset the user's zoom, orbit or pending focus move.
    // Read the mode without making starting/stopping Follow itself trigger a floor overview.
    if (followMode.current.following && follow.current?.id === followMode.current.focusId) {
      if (!explicitView) return;
      followEnd.current?.();
    }
    camera.position.set(...floorPose.position);
    camera.lookAt(...target);
    camera.zoom = floorPose.zoom;
    camera.updateProjectionMatrix();
    if (controls) { controls.target.set(...target); controls.update(); }
    move.current = null;
    follow.current = null;
  }, [camera, controls, view, viewRequest, level, target, floorPose, size.width, size.height]);
  const focusKey = focus?.join(',');
  const lastFocusRequest = useRef(focusRequest);
  const lastFollowing = useRef<{ following: boolean; id?: string | null }>({ following: false });
  useEffect(() => {
    const requested = lastFocusRequest.current !== focusRequest;
    const startedFollowing = following && (!lastFollowing.current.following || lastFollowing.current.id !== focusId);
    lastFollowing.current = { following, id: focusId };
    if (follow.current && follow.current.id !== focusId) { follow.current = null; move.current = null; }
    // A highlight, quick card, dialog or updated desk allocation is not a camera request.
    if (!requested && !startedFollowing) return;
    const at = (focusId ? live?.position(focusId) : undefined) ?? focus;
    if (!at || !(camera instanceof OrthographicCamera)) return;
    lastFocusRequest.current = focusRequest;
    const point: Point3 = [at[0], at[1], at[2]];
    const from: CameraPose = { position: camera.position.toArray() as Point3, target: controls ? controls.target.toArray() as Point3 : target, zoom: camera.zoom };
    move.current = { elapsed: 0, from, to: characterFocusPose(point, undefined, panelClearance(size.width, size.height)) };
    // A character still queued at the entrance is framed as soon as it steps in.
    follow.current = focusId ? { id: focusId, last: point, waiting: !live?.position(focusId) } : null;
    // Read position and available canvas only when Locate/Follow requests a move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, focusId, focusRequest, following, camera, controls]);
  const framedPoint = useRef<FocusPoint | undefined>(undefined);
  useEffect(() => {
    // A room (or any point) is framed once per request and is not a walker, so tracking ends.
    if (!focusPoint || framedPoint.current === focusPoint || !(camera instanceof OrthographicCamera)) return;
    framedPoint.current = focusPoint;
    const from: CameraPose = { position: camera.position.toArray() as Point3, target: controls ? controls.target.toArray() as Point3 : target, zoom: camera.zoom };
    const zoom = focusPoint.size ? roomFocusZoom(focusPoint.size, size.width) : undefined;
    move.current = { elapsed: 0, from, to: characterFocusPose(focusPoint.point, zoom, panelClearance(size.width, size.height)) };
    follow.current = null;
    // The request object identifies the move; the pose is read once when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPoint, camera, controls]);
  useEffect(() => {
    // Dragging hands the camera back to the user and ends following; zooming alone keeps a followed character in frame.
    const events = controls as unknown as { addEventListener?(type: string, listener: () => void): void; removeEventListener?(type: string, listener: () => void): void } | null;
    if (!events?.addEventListener) return;
    let wheel = false;
    const onWheel = () => { wheel = true; setTimeout(() => { wheel = false; }, 0); };
    const stop = () => {
      if (wheel) return;
      follow.current = null;
      move.current = null;
      followEnd.current?.();
    };
    // Capture runs before the controls' own wheel handler, which dispatches 'start' synchronously.
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    events.addEventListener('start', stop);
    return () => { window.removeEventListener('wheel', onWheel, { capture: true }); events.removeEventListener?.('start', stop); };
  }, [controls]);
  useFrame((_, delta) => {
    if (controls && camera instanceof OrthographicCamera) {
      const groundMinimum = view === 'campus' ? buildingMinimumZoom(size.width, size.height, camera.position.toArray() as Point3, controls.target.toArray() as Point3) : 2;
      // Panning beyond the disc cannot be repaired by zoom. Freeze outward zoom
      // at the current level until the user pans back, without snapping inward.
      controls.minZoom = Number.isFinite(groundMinimum) ? groundMinimum : camera.zoom;
      // Zoom-to-cursor also pans, so recheck the final view after each controls update.
      if (view === 'campus' && camera.zoom < controls.minZoom) {
        camera.zoom = controls.minZoom;
        camera.updateProjectionMatrix();
      }
    }
    const tracked = follow.current;
    const point = tracked && live ? live.position(tracked.id) : undefined;
    // Position subscriptions do not fire at every stair/elevator midpoint. Read the current floor each frame.
    if (following && tracked && point) {
      const floor = live?.floor(tracked.id);
      if (floor && view !== floor) onFollowFloor?.(floor);
    }
    if (tracked && !point) {
      if (!tracked.waiting) { follow.current = null; if (following) followEnd.current?.(); }
    }
    else if (tracked?.waiting && point && camera instanceof OrthographicCamera) {
      tracked.waiting = false;
      tracked.last[0] = point[0]; tracked.last[1] = point[1]; tracked.last[2] = point[2];
      const from: CameraPose = { position: camera.position.toArray() as Point3, target: controls ? controls.target.toArray() as Point3 : target, zoom: camera.zoom };
      move.current = { elapsed: 0, from, to: characterFocusPose([point[0], point[1], point[2]], undefined, panelClearance(size.width, size.height)) };
    } else if (tracked && point) {
      const dx = point[0] - tracked.last[0], dy = point[1] - tracked.last[1], dz = point[2] - tracked.last[2];
      tracked.last[0] = point[0]; tracked.last[1] = point[1]; tracked.last[2] = point[2];
      // Follow keeps the same framing through horizontal and vertical travel; Locate still frames only once.
      if (following && (dx || dy || dz)) {
        const pending = move.current?.to;
        if (pending) {
          pending.position[0] += dx; pending.position[1] += dy; pending.position[2] += dz;
          pending.target[0] += dx; pending.target[1] += dy; pending.target[2] += dz;
        } else {
          camera.position.set(camera.position.x + dx, camera.position.y + dy, camera.position.z + dz);
          if (controls) { controls.target.set(controls.target.x + dx, controls.target.y + dy, controls.target.z + dz); controls.update(); }
        }
      }
    }
    const current = move.current;
    if (!current || !(camera instanceof OrthographicCamera)) return;
    current.elapsed += delta;
    const t = cameraProgress(current.elapsed, 0.8, reducedMotion);
    camera.position.set(...lerp3(current.from.position, current.to.position, t));
    camera.zoom = current.from.zoom + (current.to.zoom - current.from.zoom) * t;
    camera.updateProjectionMatrix();
    if (controls) { controls.target.set(...lerp3(current.from.target, current.to.target, t)); controls.update(); }
    if (t >= 1) move.current = null;
  });
  // Zoom follows the cursor and goes in close enough to see a character's hands on the keyboard (1 m ≈ 260 px).
  return <OrbitControls makeDefault enableDamping={false} zoomToCursor minZoom={buildingZoomFloor} maxZoom={MAX_ZOOM} minPolarAngle={0.25} maxPolarAngle={Math.PI * 0.48} />;
}

