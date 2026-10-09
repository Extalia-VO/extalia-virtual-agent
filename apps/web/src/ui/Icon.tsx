const paths = {
  chat: ['M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z', 'M7 9h9m-9 4h6'],
  terminal: ['M3 4h18v16H3Z', 'm7 8 3 4-3 4m6 0h4'],
  files: ['M3 6V4h6l2 2h10v14H3V6Z'],
  logs: ['M5 2h9l5 5v15H5Z', 'M14 2v5h5M8 12h8m-8 4h5'],
  start: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z', 'm15.5 8.5-2 5-5 2 2-5 5-2Z'],
  diagnostics: ['M3 12h4l3-8 4 16 3-8h4'],
  settings: ['M4 7h6m4 0h6M4 17h10m4 0h2', 'M10 4v6m4 4v6'],
  panel: ['M3 4h18v16H3Z', 'M9 4v16'],
  check: ['m5 12 4 4L19 6'],
  alert: ['M12 3 2 20h20L12 3Z', 'M12 10v4m0 3v.01'],
  folder: ['M3 6V4h6l2 2h10v14H3V6Z', 'M12 11v5m-2.5-2.5h5'],
  refresh: ['M20 11a8 8 0 0 0-14.8-4M4 4v4h4', 'M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4'],
  plus: ['M12 5v14M5 12h14'],
  send: ['M4 12 20 4l-6 16-3-7-7-1Z', 'm11 13 3.5-3.5'],
  stop: ['M7 7h10v10H7Z'],
  edit: ['M4 20h4L19 9l-4-4L4 16v4Z', 'm13 7 4 4'],
  trash: ['M4 7h16M10 11v6m4-6v6', 'M6 7l1 13h10l1-13M9 7V4h6v3'],
  copy: ['M9 9h11v11H9Z', 'M5 15H4V4h11v1'],
  close: ['M6 6l12 12M18 6 6 18'],
  chevron: ['m9 6 6 6-6 6'],
  file: ['M6 2h8l5 5v15H6Z', 'M14 2v5h5'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'm20 20-4-4'],
  globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z'],
  users: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M2 21a7 7 0 0 1 14 0', 'M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3'],
  book: ['M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4Z', 'M20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6Z'],
  spark: ['M12 3v4m0 10v4M3 12h4m10 0h4', 'm6 6 2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6'],
  tool: ['M14.5 6.5a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8-1.5-1.5a4 4 0 0 1-5-5L13 2', 'M3 21l6-6'],
  beaker: ['M9 3h6M10 3v6l-5 10a1.5 1.5 0 0 0 1.4 2h11.2a1.5 1.5 0 0 0 1.4-2L14 9V3', 'M7.5 15h9'],
  shield: ['M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z', 'M12 8v5m0 3v.01'],
  key: ['M15 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z', 'M10.8 13.2 3 21m3-3 2 2m0-4 2 2'],
  download: ['M12 3v12m-5-5 5 5 5-5', 'M4 21h16'],
  external: ['M14 4h6v6M20 4l-9 9', 'M18 14v6H4V6h6'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'],
  moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z'],
  monitor: ['M3 4h18v12H3Z', 'M8 20h8m-4-4v4'],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof paths;

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name].map(path => <path d={path} key={path} />)}
    </svg>
  );
}
