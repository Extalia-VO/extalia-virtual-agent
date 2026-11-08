import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { SkillBookNavigation } from '../src/skills/BookNavigationPanel';
import { paginateBookText } from '../src/skills/skillBookMotion';

describe('Grimoire navigation panel', () => {
  for (const language of ['en', 'id'] as const) it(`labels navigation and escapes literal headings in ${language}`, () => {
    const t = MESSAGES[language];
    const pages = paginateBookText('# <script>literal title</script>\n\n' + 'word '.repeat(180));
    const html = renderToStaticMarkup(createElement(SkillBookNavigation, { t, pages, page: 0, compact: false, onJump: () => undefined, onClose: () => undefined }));
    expect(html).toContain(t.skillLibrary.bookNavigation);
    expect(html).toContain(t.skillLibrary.findInBook);
    expect(html).toContain(t.skillLibrary.pageNumber);
    expect(html).toContain('min="1"');
    expect(html).toContain(`max="${pages.length}"`);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('&lt;script&gt;literal title&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('keeps page and search navigation available for metadata without headings', () => {
    const t = MESSAGES.en;
    const html = renderToStaticMarkup(createElement(SkillBookNavigation, { t, pages: paginateBookText('Only metadata is available.'), page: 0, compact: true, onJump: () => undefined, onClose: () => undefined }));
    expect(html).toContain(t.skillLibrary.noHeadings);
    expect(html).toContain(t.skillLibrary.goToPage);
    expect(html).toContain('type="search"');
  });
});
