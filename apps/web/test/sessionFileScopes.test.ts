import { createEvent, type EventBody } from '@extalia/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChangedFilesView } from '../src/chat/ChangedFilesView';
import { MessageFileProvider } from '../src/chat/MessageFilePreview';
import { TranscriptView } from '../src/chat/TranscriptView';
import { projectChangedFiles } from '../src/chat/changedFiles';
import { historicalSessionFilePath, resolveSessionMessageFile, sessionFileRoots } from '../src/chat/sessionFileScopes';
import { projectTranscript } from '../src/chat/transcript';
import { MESSAGES } from '../src/i18n';

const alpha = { workspaceId: 'alpha', projectLocation: '/projects/alpha' };
const beta = { workspaceId: 'beta', projectLocation: '/projects/beta' };
const workspaces = [alpha, beta].map(scope => ({ id: scope.workspaceId, projectLocation: scope.projectLocation }));
const current = { workspaces, workspaceId: beta.workspaceId, projectPath: beta.projectLocation };
const event = (id: string, body: EventBody) => createEvent({ id, sessionId: 'session', agentId: 'primary', source: { runtime: 'extalia-native', channel: 'stream' }, body });
const answer = (id: string) => event(id, { type: 'model.completed', text: 'See [source](src/a.ts).' });
const write = (id: string) => event(id, { type: 'file.written', path: 'src/a.ts', change: 'update' });
const provider = (children: ReturnType<typeof createElement>, registrations = workspaces) => createElement(MessageFileProvider, {
  t: MESSAGES.en, workspaces: registrations, workspaceId: beta.workspaceId, projectPath: beta.projectLocation, children,
});

describe('session history file scopes', () => {
  it.each([null, {}, 'invalid', [null], [42], [{ ...alpha, throughEventId: 5 }],
    [{ ...alpha, throughEventId: 'a', projectLocation: 42 }], [{ ...alpha, throughEventId: 'a', workspaceId: '' }]].map(scopes => ({ scopes })))(
    'keeps malformed-present history scope metadata passive (%j)', ({ scopes }) => {
      const events = [answer('a'), write('b')];
      const roots = sessionFileRoots(events, scopes);
      expect([...roots]).toEqual([['a', null], ['b', null]]);
      const html = renderToStaticMarkup(provider(createElement(TranscriptView, { t: MESSAGES.en, language: 'en', items: projectTranscript(events, roots), onDecide: async () => undefined })));
      expect(html).not.toContain('class="message-file-link"');
    });

  it('assigns consecutive moves through their exact event cutoffs and leaves newer events current', () => {
    const events = [answer('a'), answer('b'), answer('c')];
    expect([...sessionFileRoots(events, [{ ...alpha, throughEventId: 'a' }, { ...beta, throughEventId: 'b' }])]).toEqual([
      ['a', alpha], ['b', beta],
    ]);
    expect([...sessionFileRoots(events)]).toEqual([]);
  });

  it('accepts moves without intervening events and disables ambiguous missing or reversed cutoffs', () => {
    const events = [answer('a'), answer('b')];
    expect([...sessionFileRoots(events, [{ ...alpha, throughEventId: 'a' }, { ...beta, throughEventId: 'a' }])]).toEqual([['a', alpha]]);
    for (const scopes of [
      [{ ...alpha, throughEventId: 'missing' }],
      [{ ...alpha, throughEventId: 'b' }, { ...beta, throughEventId: 'a' }],
    ]) expect([...sessionFileRoots(events, scopes)]).toEqual([['a', null], ['b', null]]);
  });

  it('keeps old and new same-name writes separate in Files and transcript projections without mutating events', () => {
    const events = [write('a'), event('end', { type: 'turn.completed' }), write('b')];
    const roots = sessionFileRoots(events, [{ ...alpha, throughEventId: 'end' }]);
    expect(projectChangedFiles(events, beta.projectLocation, roots)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/projects/alpha/src/a.ts', edits: 1, fileScope: alpha }),
      expect.objectContaining({ path: 'src/a.ts', edits: 1 }),
    ]));
    expect(projectChangedFiles(events, beta.projectLocation, roots)).toHaveLength(2);
    const files = projectTranscript(events, roots).filter(item => item.kind === 'files');
    expect(files.map(item => item.files[0]!.path)).toEqual(['/projects/alpha/src/a.ts', 'src/a.ts']);
    expect(events[0]!.body).toMatchObject({ path: 'src/a.ts' });
  });

  it('resolves old relative Markdown links in their source workspace and refuses removed or relocated sources', () => {
    const link = { name: 'a.ts', path: 'src/a.ts', link: true };
    expect(resolveSessionMessageFile(link, current, alpha)).toEqual({ workspaceId: 'alpha', path: 'src/a.ts' });
    expect(resolveSessionMessageFile(link, current)).toEqual({ workspaceId: 'beta', path: 'src/a.ts' });
    expect(resolveSessionMessageFile(link, current, null)).toBeUndefined();
    expect(resolveSessionMessageFile(link, { ...current, workspaces: workspaces.filter(workspace => workspace.id !== 'alpha') }, alpha)).toBeUndefined();
    expect(resolveSessionMessageFile(link, { ...current, workspaces: [{ id: 'alpha', projectLocation: '/projects/relocated' }, workspaces[1]!] }, alpha)).toBeUndefined();
    expect(resolveSessionMessageFile(link, current, { ...alpha, workspaceId: 'beta' })).toBeUndefined();
  });

  it('retains literal paths and Windows roots without accepting traversal', () => {
    expect(historicalSessionFilePath('report%20final.txt', alpha)).toBe('/projects/alpha/report%20final.txt');
    expect(historicalSessionFilePath('src\\a.ts', { workspaceId: 'win', projectLocation: 'C:\\Projects\\Alpha' })).toBe('C:\\Projects\\Alpha/src/a.ts');
    expect(historicalSessionFilePath('../beta/src/a.ts', alpha)).toBeUndefined();
  });

  it('renders historical user, assistant and approval links passively when their source is unavailable', () => {
    const events = [
      event('user', { type: 'prompt.submitted', text: 'See [source](src/a.ts).', via: 'extalia' }),
      answer('assistant'),
      event('approval', { type: 'approval.requested', approvalId: 'approval', action: 'See [source](src/a.ts).' }),
    ];
    const roots = sessionFileRoots(events, [{ ...alpha, throughEventId: 'approval' }]);
    const transcript = () => createElement(TranscriptView, { t: MESSAGES.en, language: 'en', items: projectTranscript(events, roots), onDecide: async () => undefined });
    expect(renderToStaticMarkup(provider(transcript())).match(/class="message-file-link"/g)).toHaveLength(3);
    const absent = renderToStaticMarkup(provider(transcript(), [workspaces[1]!]));
    expect(absent).not.toContain('class="message-file-link"');
    const ambiguous = projectTranscript(events, sessionFileRoots(events, [{ ...alpha, throughEventId: 'missing' }]));
    expect(renderToStaticMarkup(provider(createElement(TranscriptView, { t: MESSAGES.en, language: 'en', items: ambiguous, onDecide: async () => undefined })))).not.toContain('class="message-file-link"');
  });

  it('keeps ambiguous historical Files rows passive while current files remain previewable', () => {
    const events = [write('old')];
    const roots = sessionFileRoots(events, [{ ...alpha, throughEventId: 'missing' }]);
    const files = projectChangedFiles(events, beta.projectLocation, roots);
    const html = renderToStaticMarkup(provider(createElement(ChangedFilesView, { t: MESSAGES.en, language: 'en', files })));
    expect(html).toContain('changed-file static');
    expect(html).not.toContain('<button');
  });
});
