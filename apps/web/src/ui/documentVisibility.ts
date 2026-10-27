/**
 * Mirror `document.hidden` on `<html data-document-hidden>` so CSS can pause
 * decorative animations (the Liquid Glass Pro plasma field) while the window
 * is hidden or minimised. Browsers usually stop compositing hidden documents
 * anyway; this makes the pause explicit for every engine and Electron.
 */
export function trackDocumentVisibility(doc: Document = document): () => void {
  const apply = () => {
    if (doc.hidden) doc.documentElement.dataset.documentHidden = '';
    else delete doc.documentElement.dataset.documentHidden;
  };
  apply();
  doc.addEventListener('visibilitychange', apply);
  return () => doc.removeEventListener('visibilitychange', apply);
}
