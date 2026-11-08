import { useEffect, useState } from 'react';
import { GRAPH_GALAXY_BACKDROP } from './graphReferenceStyle';

export interface GraphTheme {
  light: boolean;
  background: string;
}

const FALLBACK_LIGHT = '#eef2f7';

/** Use the reference galaxy backdrop in dark mode and the app's canvas tint in light mode. */
export function graphBackdrop(canvas: string, light: boolean): string {
  if (!light) return GRAPH_GALAXY_BACKDROP;
  const match = /^#([\da-f]{6})$/i.exec(canvas.trim());
  const source = match?.[1] ?? FALLBACK_LIGHT.slice(1);
  const tint = [244, 247, 252];
  const weight = .92;
  const channels = tint.map((value, index) => Math.round(parseInt(source.slice(index * 2, index * 2 + 2), 16) * weight + value * (1 - weight)));
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function readGraphTheme(): GraphTheme {
  if (typeof document === 'undefined') return { light: false, background: GRAPH_GALAXY_BACKDROP };
  const root = document.documentElement;
  const light = root.dataset.theme === 'light';
  const background = typeof window !== 'undefined'
    ? window.getComputedStyle(root).getPropertyValue('--canvas').trim()
    : '';
  return { light, background: graphBackdrop(background || FALLBACK_LIGHT, light) };
}

/** Read the app's current theme tokens and follow theme/material changes on the root element. */
export function useGraphTheme(): GraphTheme {
  const [theme, setTheme] = useState<GraphTheme>(readGraphTheme);
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const root = document.documentElement;
    const update = () => setTheme(readGraphTheme());
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-material', 'style', 'class'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
