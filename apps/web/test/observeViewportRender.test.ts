import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { PortableMessage } from '@extalia/core';
import { LibraryTranscript } from '../src/library/LibraryTranscript';
import { ConversationTabs } from '../src/chat/ChangedFilesView';
import { MESSAGES } from '../src/i18n';

it('opens the latest window in Observe while preserving History’s oldest-first default', () => {
  const messages: PortableMessage[] = Array.from({ length: 250 }, (_, index) => ({ role: 'assistant', index, content: `Recorded message ${index}`, createdAt: '2026-01-01T00:00:00Z' }));
  const observed = renderToStaticMarkup(createElement(LibraryTranscript, { t: MESSAGES.en, messages, latest: true }));
  expect(observed).toContain('>Recorded message 249<');
  expect(observed).toContain('>Recorded message 50<');
  expect(observed).not.toContain('>Recorded message 0<');
  const history = renderToStaticMarkup(createElement(LibraryTranscript, { t: MESSAGES.en, messages }));
  expect(history).toContain('>Recorded message 0<');
  expect(history).not.toContain('>Recorded message 249<');
});

it('keeps the viewport outside file-scope content ownership', () => {
  const html = renderToStaticMarkup(createElement(ConversationTabs, { t: MESSAGES.en, language: 'en', files: [], children: 'Recorded text', wrapContent: children => createElement('section', { 'data-test-scope': 'scope' }, children) }));
  expect(html).toContain('class="conversation-panel" role="tabpanel"><section data-test-scope="scope">Recorded text</section></div>');
});
