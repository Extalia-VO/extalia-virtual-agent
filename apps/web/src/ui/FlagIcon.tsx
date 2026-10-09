import type { Language } from '../i18n';

/**
 * Crisp SVG country flags for English (UK/US) and Indonesian (ID).
 */
export function FlagIcon({ language, className = '' }: { language: Language; className?: string }) {
  if (language === 'id') {
    // Indonesian Flag (Merah Putih): Top Red #E70011, Bottom White #FFFFFF
    return (
      <svg
        className={`flag-icon ${className}`}
        viewBox="0 0 20 14"
        width="18"
        height="12"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ borderRadius: '2px', boxShadow: '0 0 0 1px rgba(0,0,0,0.12)' }}
        aria-hidden="true"
      >
        <rect width="20" height="7" fill="#E70011" />
        <rect y="7" width="20" height="7" fill="#FFFFFF" />
      </svg>
    );
  }

  // English (UK Union Jack mini flag)
  return (
    <svg
      className={`flag-icon ${className}`}
      viewBox="0 0 20 14"
      width="18"
      height="12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ borderRadius: '2px', boxShadow: '0 0 0 1px rgba(0,0,0,0.12)' }}
      aria-hidden="true"
    >
      <rect width="20" height="14" fill="#012169" />
      <path d="M0 0L20 14M20 0L0 14" stroke="#FFFFFF" strokeWidth="2.5" />
      <path d="M0 0L20 14M20 0L0 14" stroke="#C8102E" strokeWidth="1.2" />
      <path d="M10 0V14M0 7H20" stroke="#FFFFFF" strokeWidth="4" />
      <path d="M10 0V14M0 7H20" stroke="#C8102E" strokeWidth="2.4" />
    </svg>
  );
}
