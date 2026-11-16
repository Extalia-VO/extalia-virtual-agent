type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void | Promise<void>;
};
type FullscreenRoot = HTMLElement & { webkitRequestFullscreen?: () => void | Promise<void> };

export function browserFullscreenActive(doc: Document): boolean {
  const compatible = doc as FullscreenDocument;
  return Boolean(doc.fullscreenElement ?? compatible.webkitFullscreenElement);
}

export function browserFullscreenAvailable(doc: Document): boolean {
  const compatible = doc as FullscreenDocument, root = doc.documentElement as FullscreenRoot;
  if ((doc.fullscreenEnabled ?? compatible.webkitFullscreenEnabled) === false) return false;
  return typeof root.requestFullscreen === 'function' || typeof root.webkitRequestFullscreen === 'function';
}

/** Called directly from a click, preserving the browser's required user gesture. */
export async function toggleBrowserFullscreen(doc: Document): Promise<void> {
  const compatible = doc as FullscreenDocument, root = doc.documentElement as FullscreenRoot;
  if (browserFullscreenActive(doc)) {
    if (typeof doc.exitFullscreen === 'function') return doc.exitFullscreen();
    if (typeof compatible.webkitExitFullscreen === 'function') { await compatible.webkitExitFullscreen(); return; }
  } else if (browserFullscreenAvailable(doc)) {
    if (typeof root.requestFullscreen === 'function') return root.requestFullscreen({ navigationUI: 'hide' });
    if (typeof root.webkitRequestFullscreen === 'function') { await root.webkitRequestFullscreen(); return; }
  }
  throw new Error('Fullscreen is unavailable.');
}
