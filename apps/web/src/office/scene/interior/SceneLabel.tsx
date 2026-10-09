import { Html } from '@react-three/drei';
import { cloneElement, isValidElement, type CSSProperties, type ReactNode, type ReactElement } from 'react';
import type { Point3 } from '../layout';
import { useInteriorText } from './FurnishedFloorContext';

function translateChildren(children: ReactNode, translate: (text: string) => string): ReactNode {
  if (typeof children === 'string') {
    const normalized = children.trim();
    const translated = translate(normalized);
    return translated === normalized ? children : translated;
  }
  if (Array.isArray(children)) return children.map(child => translateChildren(child, translate));
  if (isValidElement(children)) {
    const element = children as ReactElement<{ children?: ReactNode }>;
    return cloneElement(element, undefined, translateChildren(element.props.children, translate));
  }
  return children;
}

/** World-space architectural labels use the app language catalog. */
export function SceneLabel({ children, position, center = false, style }: {
  children: ReactNode; position: Point3; center?: boolean; style?: CSSProperties;
}) {
  const translate = useInteriorText();
  return <Html position={position} center={center} style={{ pointerEvents: 'none', ...style }} zIndexRange={[10, 0]}>
    {translateChildren(children, translate)}
  </Html>;
}
