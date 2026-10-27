import { describe, expect, it } from 'vitest';
import { trackDocumentVisibility } from '../src/ui/documentVisibility';

function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    hidden: false,
    documentElement: { dataset: {} as Record<string, string> },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  const fire = (hidden: boolean) => { doc.hidden = hidden; listeners.forEach(fn => fn()); };
  return { doc, fire, listeners };
}

describe('trackDocumentVisibility', () => {
  it('mirrors document.hidden on <html data-document-hidden> and stops on dispose', () => {
    const { doc, fire, listeners } = fakeDocument();
    const stop = trackDocumentVisibility(doc as unknown as Document);
    expect('documentHidden' in doc.documentElement.dataset).toBe(false);
    fire(true);
    expect(doc.documentElement.dataset.documentHidden).toBe('');
    fire(false);
    expect('documentHidden' in doc.documentElement.dataset).toBe(false);
    stop();
    expect(listeners.size).toBe(0);
  });
});
