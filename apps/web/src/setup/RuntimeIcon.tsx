import { useId } from 'react';
import { SYMBOL_GRADIENT, SYMBOL_PATH } from '../branding/identity';

/** Brand mark of a managed runtime; Hermes switches between its light and dark artwork with the theme. */
export function RuntimeIcon({ runtime, size = 16 }: { runtime: 'extalia-native' | 'hermes'; size?: number }) {
  const gradient = useId();
  if (runtime === 'extalia-native') {
    return (
      <svg viewBox="0 0 1.41 1" width={size} height={Math.round(size * 0.75)} style={{ display: 'block' }} aria-hidden="true">
        <defs>
          <linearGradient id={gradient} x1="0" y1="1" x2="0" y2="0">
            {SYMBOL_GRADIENT.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}
          </linearGradient>
        </defs>
        <path d={SYMBOL_PATH} fill={`url(#${gradient})`} />
      </svg>
    );
  }
  return (
    <span className="runtime-logo-adaptive">
      <img src="/brand/hermes-logo.svg" alt="" width={size} height={size} className="logo-dark" style={{ objectFit: 'contain' }} />
      <img src="/brand/hermes-logo-black.svg" alt="" width={size} height={size} className="logo-light" style={{ objectFit: 'contain' }} />
    </span>
  );
}
