import type { AgentHostApi, FileContent } from '@extalia/platform';
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { resolveMessageFile, type MessageFileReference, type MessageFileScope } from './messageFilePaths';

export type { MessageFileReference, MessageFileScope, WorkspaceSummary } from './messageFilePaths';
export interface MessageFileProviderProps extends MessageFileScope { t: Messages; agents?: AgentHostApi; children: ReactNode }
export type OpenMessageFile = (file: MessageFileReference) => void;

const MessageFiles = createContext<OpenMessageFile | undefined>(undefined);
/** Static transcript exports omit file actions when no preview provider is available. */
export function useMessageFiles(): OpenMessageFile | undefined { return useContext(MessageFiles); }

type Preview = { kind: 'loading' | 'unavailable' | 'readFailed' | 'tooLarge' | 'binary' }
  | { kind: 'text'; content: string; truncated?: boolean }
  | { kind: 'image'; url: string };
interface OpenPreview { name: string; preview: Preview; local?: boolean; host?: AgentHostApi }

const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled):not([type="hidden"]), [href], [tabindex]:not([tabindex="-1"])';

function imageType(bytes: Uint8Array): string | undefined {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const header = String.fromCharCode(...bytes.subarray(0, 12));
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8) === 'WEBP') return 'image/webp';
  return undefined;
}

function hostPreview(file: FileContent): Preview {
  if (file.binary) return { kind: 'binary' };
  return { kind: 'text', content: file.content ?? '', truncated: file.truncated };
}

/** Scope changes remount the preview owner, cancelling all pending results and object URLs. */
export function MessageFileProvider(props: MessageFileProviderProps) {
  const scopeKey = JSON.stringify([props.workspaceId, props.projectPath, props.workspaces.map(workspace => [workspace.id, workspace.projectLocation])]);
  return <ScopedMessageFiles key={scopeKey} {...props} />;
}

function ScopedMessageFiles({ t, agents, workspaces, workspaceId, projectPath, children }: MessageFileProviderProps) {
  const [opened, setOpened] = useState<OpenPreview>();
  const version = useRef(0);
  const imageUrl = useRef<string | undefined>(undefined);
  const releaseImage = useCallback(() => {
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = undefined;
  }, []);
  const close = useCallback(() => { version.current++; releaseImage(); setOpened(undefined); }, [releaseImage]);
  useEffect(() => () => { version.current++; releaseImage(); }, [agents, releaseImage]);

  const openFile = useCallback<OpenMessageFile>(file => {
    const request = ++version.current;
    releaseImage();
    const resolved = resolveMessageFile(file, { workspaces, workspaceId, projectPath });
    const initial: OpenPreview = { name: file.name, host: agents, preview: { kind: resolved && agents?.readFile ? 'loading' : 'unavailable' } };
    setOpened(initial);
    if (!resolved || !agents?.readFile) return;
    void Promise.resolve().then(() => request === version.current ? agents.readFile(resolved.workspaceId, resolved.path) : undefined).then(result => {
      if (request === version.current && result) setOpened({ ...initial, preview: hostPreview(result) });
    }).catch(() => {
      if (request === version.current) setOpened({ ...initial, preview: { kind: 'readFailed' } });
    });
  }, [agents, workspaces, workspaceId, projectPath, releaseImage]);

  const chooseLocal = async (file: File) => {
    const request = ++version.current;
    releaseImage();
    const update = (preview: Preview) => {
      if (request === version.current) setOpened({ name: file.name, local: true, host: agents, preview });
    };
    update({ kind: 'loading' });
    if (file.size > IMAGE_LIMIT) { update({ kind: 'tooLarge' }); return; }
    try {
      // Sniff only a small header before deciding whether the larger image limit applies.
      const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      if (request !== version.current) return;
      const mime = imageType(header);
      if (mime) {
        const url = URL.createObjectURL(new Blob([file], { type: mime }));
        imageUrl.current = url;
        update({ kind: 'image', url });
        return;
      }
      if (file.type.startsWith('image/') || /\.svgz?$/i.test(file.name)) { update({ kind: 'binary' }); return; }
      if (file.size > TEXT_LIMIT) { update({ kind: 'tooLarge' }); return; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (request !== version.current) return;
      if (bytes.some(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) { update({ kind: 'binary' }); return; }
      try { update({ kind: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }); }
      catch { update({ kind: 'binary' }); }
    } catch { update({ kind: 'readFailed' }); }
  };

  // An API replacement cannot reveal a previous host's result while effect cleanup runs.
  const current = opened?.host === agents ? opened : undefined;
  return <MessageFiles.Provider value={openFile}>
    {children}
    {current && <FilePreviewDialog t={t} opened={current} onClose={close} onChoose={file => { void chooseLocal(file); }} onImageError={() => {
      releaseImage(); setOpened({ ...current, preview: { kind: 'binary' } });
    }} />}
  </MessageFiles.Provider>;
}

function FilePreviewDialog({ t, opened, onClose, onChoose, onImageError }: {
  t: Messages; opened: OpenPreview; onClose: () => void; onChoose: (file: File) => void; onImageError: () => void;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const localInput = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  const id = useId();
  useEffect(() => { close.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const keep = backdrop.current;
    if (!keep) return;
    const changed = new Set<HTMLElement>();
    const isolate = () => {
      for (const element of document.body.children) {
        if (!(element instanceof HTMLElement) || element === keep || element.tagName === 'SCRIPT' || element.inert) continue;
        changed.add(element); element.inert = true;
      }
    };
    isolate();
    const observer = new MutationObserver(isolate);
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      // Existing inert roots belong to the underlying modal and were never added.
      for (const element of changed) element.inert = false;
    };
  }, []);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeButton.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); close.current(); return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const elements = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => !element.hidden);
      const first = elements[0], last = elements.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.current.focus(); return; }
      if (!dialog.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      event.stopImmediatePropagation();
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) closeButton.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  if (typeof document === 'undefined') return null;
  const labels = t.messageFiles;
  const preview = opened.preview;
  return createPortal(<div ref={backdrop} className="message-file-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="message-file-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-name`} tabIndex={-1} data-message-file-preview onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
      <div className="message-file-head">
        <div><h2 id={`${id}-title`}>{labels.title}</h2><p id={`${id}-name`}>{opened.local ? `${labels.selectedFile}: ` : ''}{opened.name}</p></div>
        <button ref={closeButton} type="button" className="icon-button small" aria-label={labels.close} onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="message-file-content" aria-busy={preview.kind === 'loading'}>
        {preview.kind === 'text' ? <>{preview.truncated && <p role="status">{labels.truncated}</p>}{preview.content ? <pre>{preview.content}</pre> : <p>{labels.empty}</p>}</>
          : preview.kind === 'image' ? <img src={preview.url} alt={opened.name} onError={onImageError} />
            : <p role={preview.kind === 'readFailed' ? 'alert' : 'status'}>{preview.kind === 'loading' && <span className="spinner" aria-hidden="true" />}{labels[preview.kind]}</p>}
      </div>
      <div className="message-file-actions">
        <button type="button" className="button small" onClick={() => localInput.current?.click()}><Icon name="folder" />{labels.choose}</button>
        <input ref={localInput} hidden type="file" aria-label={labels.choose} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) onChoose(file); }} />
        <p>{labels.localOnly}</p>
      </div>
    </div>
  </div>, document.body);
}
