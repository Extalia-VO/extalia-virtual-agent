/**
 * Official SVG brand marks for LLM Providers and Routers.
 */

export function ProviderLogo({ preset, className = '' }: { preset: string; className?: string }) {
  switch (preset) {
    case 'openai':
      return (
        <svg className={`provider-logo ${className}`} viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <path d="M22.28 9.58a5.53 5.53 0 0 0-.46-4.38 5.74 5.74 0 0 0-4.9-2.73 5.6 5.6 0 0 0-1.63.24 5.5 5.5 0 0 0-4.14-1.84 5.73 5.73 0 0 0-5.46 3.96 5.55 5.55 0 0 0-3.3 2.4A5.67 5.67 0 0 0 2 10.98a5.56 5.56 0 0 0 1.28 4.23 5.53 5.53 0 0 0 .46 4.38 5.74 5.74 0 0 0 4.9 2.73 5.6 5.6 0 0 0 1.63-.24 5.5 5.5 0 0 0 4.14 1.84 5.73 5.73 0 0 0 5.46-3.96 5.55 5.55 0 0 0 3.3-2.4 5.67 5.67 0 0 0 .4-3.75 5.56 5.56 0 0 0-1.29-4.23ZM12.9 21.1a4.23 4.23 0 0 1-2.46-.77l.12-.07 4.09-2.36a.78.78 0 0 0 .39-.68v-5.75l1.73 1a.06.06 0 0 1 .04.05v4.71a4.27 4.27 0 0 1-3.91 3.87Zm-8.4-3.64a4.2 4.2 0 0 1-.54-2.52l.13.08 4.08 2.35a.77.77 0 0 0 .78 0l4.98-2.88v2a.06.06 0 0 1-.03.05l-4.08 2.36a4.27 4.27 0 0 1-5.32-1.44Zm-1.88-8.2a4.2 4.2 0 0 1 1.93-1.74v4.87a.77.77 0 0 0 .39.68l4.98 2.87-1.73 1a.06.06 0 0 1-.06 0L4.05 9.6a4.27 4.27 0 0 1-1.43-5.34Zm14.28 2.45-4.98-2.88 1.73-1a.06.06 0 0 1 .06 0l4.08 2.36a4.26 4.26 0 0 1-.41 7.68V12.4a.77.77 0 0 0-.48-.69ZM20.1 9.27l-.13-.07-4.08-2.36a.77.77 0 0 0-.78 0l-4.98 2.88V7.72a.06.06 0 0 1 .03-.05l4.08-2.36A4.27 4.27 0 0 1 19.56 6.7a4.2 4.2 0 0 1 .54 2.57Zm-9-5.17a4.23 4.23 0 0 1 2.46.77l-.12.07-4.09 2.36a.78.78 0 0 0-.39.68v5.75l-1.73-1a.06.06 0 0 1-.04-.05V10a4.27 4.27 0 0 1 3.91-3.9Zm-.83 7.82 2.2-1.27 2.2 1.27v2.54l-2.2 1.27-2.2-1.27v-2.54Z"/>
        </svg>
      );

    case 'anthropic':
      return (
        <svg className={`provider-logo ${className}`} viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <path d="m13.8 3.5-6.6 17h3.1l1.4-3.8h4.6l1.4 3.8h3.1l-6.6-17h-.4zm-.8 10.7 1.5-4.2 1.5 4.2h-3zM4.2 20.5h3L12 7.7 9.8 2 4.2 20.5z" />
        </svg>
      );

    case 'ollama':
      return (
        <svg className={`provider-logo ${className}`} viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="8" r="3.5"/>
          <circle cx="16" cy="8" r="3.5"/>
          <path d="M12 11c-3.3 0-6 2.7-6 6v3h12v-3c0-3.3-2.7-6-6-6z"/>
          <circle cx="8" cy="7.5" r="1" fill="#000"/>
          <circle cx="16" cy="7.5" r="1" fill="#000"/>
        </svg>
      );

    case 'openrouter':
      return (
        <svg className={`provider-logo ${className}`} viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1"/>
        </svg>
      );

    case 'omniroute':
    case '9router':
      return (
        <svg className={`provider-logo ${className}`} viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="2" width="20" height="8" rx="2"/>
          <rect x="2" y="14" width="20" height="8" rx="2"/>
          <line x1="6" y1="6" x2="6.01" y2="6"/>
          <line x1="6" y1="18" x2="6.01" y2="18"/>
          <path d="M10 6h8M10 18h8"/>
        </svg>
      );

    default:
      // Custom generic endpoint icon
      return (
        <svg className={`provider-logo ${className}`} viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
      );
  }
}
