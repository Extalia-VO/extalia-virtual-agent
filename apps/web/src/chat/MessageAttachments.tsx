import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { formatBytes, type AttachmentMetadata, type AttachmentPreviewLease, type AttachmentPreviewLoader } from './attachments';
import { useMessageFiles } from './MessageFilePreview';
import './messageAttachments.css';

type File = AttachmentMetadata & { path?: string };

// One observer serves the mounted transcript rather than allocating one per historical image.
let nearObserver: IntersectionObserver | undefined;
const nearCallbacks = new Map<Element, (visible: boolean) => void>();
function observeNear(node: Element, changed: (visible: boolean) => void): () => void {
  nearObserver ??= new IntersectionObserver(entries => {
    for (const entry of entries) nearCallbacks.get(entry.target)?.(entry.isIntersecting);
  }, { rootMargin: '160px' });
  nearCallbacks.set(node, changed); nearObserver.observe(node);
  return () => {
    nearCallbacks.delete(node); nearObserver?.unobserve(node);
    if (!nearCallbacks.size) { nearObserver?.disconnect(); nearObserver = undefined; }
  };
}

/** Metadata-only media; a label or local path never becomes an implicit image request. */
export function MessageAttachments({ t, files, load, label, className = '', allowOpenFile = false }: {
  t: Messages; files: readonly File[]; load?: AttachmentPreviewLoader; label: string; className?: string; allowOpenFile?: boolean;
}) {
  const [binding, setBinding] = useState({ load, key: 0 });
  if (binding.load !== load) setBinding({ load, key: binding.key + 1 });
  if (!files.length) return null;
  return <ul className={`bubble-files ${className}`.trim()} aria-label={label}>
    {files.map((file, index) => file.kind === 'image' && file.ref && load
      ? <AttachmentImage key={`${binding.key}:${index}:${file.ref}`} t={t} file={file} load={load} allowOpenFile={allowOpenFile} />
      : <li key={index} className={`bubble-file kind-${file.kind}`}><FileLabel t={t} file={file} allowOpenFile={allowOpenFile} /></li>)}
  </ul>;
}

function FileLabel({ t, file, allowOpenFile }: { t: Messages; file: File; allowOpenFile: boolean }) {
  const openFile = useMessageFiles();
  const content = <><Icon name="file" /><span className="bubble-file-name">{file.name}</span>{file.size > 0 && <span className="bubble-file-size">{formatBytes(file.size)}</span>}{file.kind === 'image' && <span className="bubble-preview-unavailable">{t.chat.imagePreviewUnavailable}</span>}</>;
  return allowOpenFile && openFile
    ? <button type="button" className="message-file-chip" onClick={() => openFile({ name: file.name, path: file.path })}>{content}</button>
    : content;
}

function PendingImage({ t, file }: { t: Messages; file: File }) {
  return <button type="button" className="bubble-thumb-button" title={file.name} aria-label={t.chat.openAttachment(file.name)} disabled>
    <span className="bubble-thumb-loading" aria-hidden="true" />
  </button>;
}

/** Folded runs never mount these; offscreen media releases its lease unless its dialog is open. */
function AttachmentImage({ t, file, load, allowOpenFile }: { t: Messages; file: File; load: AttachmentPreviewLoader; allowOpenFile: boolean }) {
  const element = useRef<HTMLLIElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [dialogOpen, setDialogOpen] = useState(false);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') return;
    return observeNear(node, setVisible);
  }, []);
  return <li ref={element} className="bubble-thumb">
    {visible || dialogOpen
      ? <LoadedImage t={t} file={file} load={load} allowOpenFile={allowOpenFile} onDialog={setDialogOpen} />
      : <PendingImage t={t} file={file} />}
  </li>;
}

function LoadedImage({ t, file, load, allowOpenFile, onDialog }: {
  t: Messages; file: File; load: AttachmentPreviewLoader; allowOpenFile: boolean; onDialog: (open: boolean) => void;
}) {
  const [url, setUrl] = useState<string | null>();
  const [fullUrl, setFullUrl] = useState<string>();
  const opener = useRef<HTMLButtonElement>(null);
  const leaseRef = useRef<AttachmentPreviewLease | undefined>(undefined);
  const mounted = useRef(false), viewing = useRef(false), generation = useRef(0);
  useEffect(() => {
    let live = true;
    mounted.current = true;
    generation.current++;
    const lease = load.acquire?.(file.ref!);
    leaseRef.current = lease;
    void (lease?.value ?? Promise.resolve().then(() => load(file.ref!))).then(value => {
      if (live) setUrl(value && value.startsWith('blob:') ? value : null);
    }, () => { if (live) setUrl(null); });
    return () => { live = false; mounted.current = false; lease?.release(); };
  }, [file.ref, load]);
  useEffect(() => {
    if (!fullUrl) return;
    const lease = leaseRef.current;
    // The modal image is removed before this cleanup revokes its original URL.
    return () => lease?.closeOriginal?.();
  }, [fullUrl]);
  const close = () => { generation.current++; viewing.current = false; setFullUrl(undefined); onDialog(false); };
  const failed = () => { close(); setUrl(null); leaseRef.current?.release(); };
  const open = async () => {
    if (!url || viewing.current) return;
    viewing.current = true; onDialog(true);
    const request = ++generation.current, lease = leaseRef.current;
    try {
      const original = lease?.original ? await lease.original() : url;
      if (!mounted.current || request !== generation.current) { lease?.closeOriginal?.(); return; }
      if (original?.startsWith('blob:')) setFullUrl(original);
      else failed();
    } catch { if (mounted.current && request === generation.current) failed(); }
  };
  if (url === null) return <span className="bubble-file kind-image"><FileLabel t={t} file={file} allowOpenFile={allowOpenFile} /></span>;
  return <>
    <button ref={opener} type="button" className="bubble-thumb-button" title={file.name} aria-label={t.chat.openAttachment(file.name)} disabled={!url}
      onClick={() => { void open(); }}>
      {url ? <img src={url} alt="" width={64} height={64} decoding="async" onError={failed} /> : <span className="bubble-thumb-loading" aria-hidden="true" />}
    </button>
    {fullUrl && <AttachmentImageDialog t={t} file={file} url={fullUrl} onClose={close} onError={failed} returnFocus={opener} />}
  </>;
}

/** A private blob image in an isolated, keyboard-contained portal; no local-file or remote URLs. */
function AttachmentImageDialog({ t, file, url, onClose, onError, returnFocus }: {
  t: Messages; file: File; url: string; onClose: () => void; onError: () => void; returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const root = backdrop.current;
    if (!root) return;
    const changed = new Set<HTMLElement>();
    const isolate = () => {
      for (const element of document.body.children) {
        if (!(element instanceof HTMLElement) || element === root || element.tagName === 'SCRIPT' || element.inert) continue;
        changed.add(element); element.inert = true;
      }
    };
    isolate();
    const observer = new MutationObserver(isolate); observer.observe(document.body, { childList: true });
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { observer.disconnect(); for (const element of changed) element.inert = false; document.body.style.overflow = previousOverflow; };
  }, []);
  useEffect(() => {
    const previous = returnFocus.current;
    closeButton.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
      else if (event.key === 'Tab') { event.preventDefault(); event.stopImmediatePropagation(); closeButton.current?.focus(); }
    };
    const focus = (event: FocusEvent) => {
      if (event.target !== closeButton.current) closeButton.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', key, true); document.addEventListener('focusin', focus);
    return () => {
      document.removeEventListener('keydown', key, true); document.removeEventListener('focusin', focus);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [returnFocus]);
  if (typeof document === 'undefined') return null;
  return createPortal(<div ref={backdrop} className="attachment-viewer" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <figure role="dialog" aria-modal="true" aria-label={file.name} onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
      <img src={url} alt={file.name} onError={onError} />
      <figcaption><span>{file.name}</span>{file.size > 0 && <span>{formatBytes(file.size)}</span>}
        <button ref={closeButton} type="button" className="icon-button small" aria-label={t.chat.closeAttachment} onClick={onClose}><Icon name="close" /></button>
      </figcaption>
    </figure>
  </div>, document.body);
}
