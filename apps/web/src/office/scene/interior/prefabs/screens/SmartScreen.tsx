import { useEffect, useMemo, useRef } from 'react';
import type { Group} from 'three';
import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import type { SmartScreenData } from '../../screenData';
import { useFurnishedFloorState, useInteriorText } from '../../FurnishedFloorContext';
import { screenForLocation } from '../../screenData';
import { registerScreenEmitter, type ScreenEmitter } from './screenEmitterRegistry';
import { screenPhotometry } from './screenPhotometry';

export type ScreenVariant = 'code' | 'chart' | 'ops' | 'status' | 'presentation' | 'media';

/** Original panel/bezel geometry; pixels describe real sessions or an idle screen. */
export function SmartScreen({ data: authoredData, resourceId, position = [0, 0, 0], rotationY = 0,
  width = 2.8, height = 1.55, bezel = 0.055, depth = 0.06, powered = true,
}: {
  data: SmartScreenData; resourceId?: string; position?: [number, number, number]; rotationY?: number;
  width?: number; height?: number; bezel?: number; depth?: number; variant?: ScreenVariant; powered?: boolean;
}) {
  const state = useFurnishedFloorState();
  const t = useInteriorText();
  const seatId = resourceId ?? authoredData.resourceId;
  const allocation = state.allocations.find(entry => entry.resourceId === seatId);
  const agent = state.agents.find(entry => entry.id === allocation?.agentId);
  const data = agent ? { ...screenForLocation(state, seatId ?? ''), title: agent.displayName,
    subtitle: agent.summary, status: agent.status, sessionBacked: true,
    rows: [{ label: t('STATUS'), value: agent.status }, ...(agent.activity ? [{ label: t('ACTIVITY'), value: agent.activity }] : []),
      ...(agent.target ? [{ label: t('TARGET'), value: agent.target }] : [])] } : authoredData;
  const active = Boolean(data.sessionBacked);
  const canvas = useMemo(() => {
    const value = document.createElement('canvas');
    value.width = width <= 1.2 ? 512 : 1024;
    value.height = Math.round(value.width * 9 / 16);
    return value;
  }, [width]);
  const texture = useMemo(() => {
    const value = new CanvasTexture(canvas);
    value.colorSpace = SRGBColorSpace; value.minFilter = LinearFilter; value.magFilter = LinearFilter;
    return value;
  }, [canvas]);
  const textureRef = useRef(texture);
  const group = useRef<Group>(null);
  const fingerprint = JSON.stringify(data);
  useEffect(() => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(canvas.width / 1024, 0, 0, canvas.height / 576, 0, 0);
    ctx.fillStyle = active ? '#0b1820' : '#071014'; ctx.fillRect(0, 0, 1024, 576);
    ctx.fillStyle = active ? '#83dfc6' : '#45606a';
    ctx.font = '600 24px system-ui'; ctx.fillText('EXTALIA', 42, 54);
    if (!active) {
      ctx.fillStyle = '#728891'; ctx.font = '500 24px system-ui'; ctx.fillText(t('STANDBY'), 42, 520);
    } else {
      ctx.fillStyle = '#f0f8f8'; ctx.font = '600 40px system-ui'; ctx.fillText(data.title.slice(0, 38), 42, 130);
      if (data.subtitle) { ctx.fillStyle = '#9db7bd'; ctx.font = '400 24px system-ui'; ctx.fillText(data.subtitle.slice(0, 66), 42, 179); }
      ctx.font = '500 22px system-ui';
      (data.rows ?? []).slice(0, 6).forEach((row, index) => {
        ctx.fillStyle = '#72979e'; ctx.fillText(row.label.slice(0, 24), 42, 260 + index * 42);
        ctx.fillStyle = '#d7e6e8'; ctx.fillText(row.value.slice(0, 52), 275, 260 + index * 42);
      });
    }
    textureRef.current.needsUpdate = true;
  }, [canvas, texture, fingerprint, active, state.language, data.title, data.subtitle, data.rows, t]);
  useEffect(() => {
    if (!group.current || !powered) return;
    const sample = document.createElement('canvas'); sample.width = 16; sample.height = 9;
    const ctx = sample.getContext('2d'); if (!ctx) return;
    ctx.drawImage(canvas, 0, 0, 16, 9);
    const photometry = screenPhotometry(ctx.getImageData(0, 0, 16, 9).data, width * height, powered, active ? 1 : 0.22);
    const emitter: ScreenEmitter = { group: group.current, width, height, depth, ...photometry };
    return registerScreenEmitter(emitter);
  }, [canvas, fingerprint, powered, active, width, height, depth]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <group ref={group} position={position} rotation={[0, rotationY, 0]} name="smart-screen">
    <mesh><boxGeometry args={[width + bezel, height + bezel, depth]} /><meshStandardMaterial color="#101820" metalness={0.34} roughness={0.24} /></mesh>
    <mesh position={[0, 0, depth / 2 + 0.001]} userData={{ officeDynamic: true }}>
      <planeGeometry args={[width, height]} /><meshBasicMaterial map={powered ? texture : null} color={powered ? '#ffffff' : '#000000'} toneMapped={false} />
    </mesh>
    <mesh position={[-width / 2 + bezel * 0.38, -height / 2 - bezel * 0.22, depth / 2 + 0.003]} userData={{ officeDynamic: true }}>
      <circleGeometry args={[Math.max(0.008, bezel * 0.15), 12]} /><meshBasicMaterial color={powered ? active ? '#71f0ca' : '#45606a' : '#000000'} toneMapped={false} />
    </mesh>
  </group>;
}
