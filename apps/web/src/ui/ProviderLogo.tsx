import type { ReactNode } from 'react';

/**
 * Official PNG brand marks for LLM Providers and Routers with full Dark/Light adaptive PNGs.
 * Uses exact high-resolution assets provided in apps/web/public/brand/providers/png.
 */
export function ProviderLogo({ preset, className = '' }: { preset: string; className?: string }): ReactNode {
  switch (preset) {
    case 'openai':
      return (
        <span className={`provider-logo-adaptive ${className}`}>
          <img src="/brand/providers/png/openai-dark.png" alt="OpenAI" width="20" height="20" className="logo-light" style={{ objectFit: 'contain' }} />
          <img src="/brand/providers/png/openai-light.png" alt="OpenAI" width="20" height="20" className="logo-dark" style={{ objectFit: 'contain' }} />
        </span>
      );

    case 'anthropic':
      return (
        <span className={`provider-logo-adaptive ${className}`}>
          <img src="/brand/providers/png/anthropic-dark.png" alt="Anthropic" width="20" height="20" className="logo-light" style={{ objectFit: 'contain' }} />
          <img src="/brand/providers/png/anthropic-light.png" alt="Anthropic" width="20" height="20" className="logo-dark" style={{ objectFit: 'contain' }} />
        </span>
      );

    case 'openrouter':
      return (
        <span className={`provider-logo-adaptive ${className}`}>
          <img src="/brand/providers/png/openrouter-dark.png" alt="OpenRouter" width="20" height="20" className="logo-light" style={{ objectFit: 'contain' }} />
          <img src="/brand/providers/png/openrouter-light.png" alt="OpenRouter" width="20" height="20" className="logo-dark" style={{ objectFit: 'contain' }} />
        </span>
      );

    case '9router':
      return (
        <span className={`provider-logo-adaptive ${className}`}>
          <img src="/brand/providers/png/9router-dark.png" alt="9Router" width="20" height="20" className="logo-light" style={{ objectFit: 'contain' }} />
          <img src="/brand/providers/png/9router-light.png" alt="9Router" width="20" height="20" className="logo-dark" style={{ objectFit: 'contain' }} />
        </span>
      );

    case 'omniroute':
      return (
        <span className={`provider-logo-adaptive ${className}`}>
          <img src="/brand/providers/png/omniroute-dark.png" alt="OmniRoute" width="20" height="20" className="logo-light" style={{ objectFit: 'contain' }} />
          <img src="/brand/providers/png/omniroute-light.png" alt="OmniRoute" width="20" height="20" className="logo-dark" style={{ objectFit: 'contain' }} />
        </span>
      );

    case 'ollama':
      return (
        <span className={`provider-logo-adaptive ${className}`}>
          <img src="/brand/providers/png/ollama-dark.png" alt="Ollama" width="20" height="20" className="logo-light" style={{ objectFit: 'contain' }} />
          <img src="/brand/providers/png/ollama-light.png" alt="Ollama" width="20" height="20" className="logo-dark" style={{ objectFit: 'contain' }} />
        </span>
      );

    default:
      return (
        <svg className={`provider-logo ${className}`} viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 2v6m6-6v6M4 8h16a1 1 0 0 1 1 1v2a6 6 0 0 1-6 6h-2v5"/>
        </svg>
      );
  }
}
