import { useId } from 'react';
import { SYMBOL_GRADIENT, SYMBOL_PATH, WORDMARK_PATH, WORDMARK_WIDTH } from '../branding/identity';

export function Brand({ compact = false }: { compact?: boolean }) {
  const gradientId = `extalia-mark-${useId().replace(/:/g, '')}`;
  return (
    <div className="brand" role="img" aria-label="Extalia">
      <svg className="brand-symbol" viewBox="0 0 1.41 1" aria-hidden="true" focusable="false">
        <defs>
          {/* Vertical gradient from the base of the mark to its top. */}
          <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
            {SYMBOL_GRADIENT.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}
          </linearGradient>
        </defs>
        <path d={SYMBOL_PATH} fill={`url(#${gradientId})`} />
      </svg>
      {!compact && (
        <svg className="brand-wordmark" viewBox={`0 -0.03 ${WORDMARK_WIDTH} 1.06`} aria-hidden="true" focusable="false">
          <path d={WORDMARK_PATH} fillRule="evenodd" />
        </svg>
      )}
    </div>
  );
}
