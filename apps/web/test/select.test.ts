import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Select } from '../src/ui/Select';

const options = [{ value: '', label: 'Workspace root' }, { value: 'option:', label: 'Literal ID' }, { value: 'other', label: 'Other' }];
const render = (props: Partial<Parameters<typeof Select>[0]> = {}) => renderToStaticMarkup(createElement(Select, {
  label: 'Repository', value: '', options, onChange: () => undefined, ...props,
}));

describe('shared library selection field', () => {
  it('displays a real empty choice separately from a placeholder or a literal encoded-looking ID', () => {
    expect(render()).toContain('Workspace root');
    expect(render({ value: 'option:' })).toContain('Literal ID');
    expect(render({ value: '', options: options.slice(1), placeholder: 'Choose repository' })).toContain('Choose repository');
  });

  it('links automatically generated and caller-provided labels to their trigger', () => {
    const html = render();
    const labelledId = html.match(/<label for="([^"]+)"/)?.[1];
    expect(labelledId).toBeTruthy();
    expect(html).toContain(`id="${labelledId}"`);
    expect(render({ id: 'repository' })).toContain('<label for="repository"');
  });

  it('preserves disabled, accessible description, error state, and escaped option labels', () => {
    const html = render({ disabled: true, 'aria-describedby': 'repository-help', 'aria-invalid': true, options: [{ value: '', label: '<literal>' }] });
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-describedby="repository-help"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('&lt;literal&gt;');
    expect(html).not.toContain('<literal>');
  });
});
