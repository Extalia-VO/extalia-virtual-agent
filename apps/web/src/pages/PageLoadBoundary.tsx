import { Component, Suspense, type ReactNode } from 'react';
import type { Messages } from '../i18n';
import './pageLoading.css';

type PageMessages = Pick<Messages, 'pageLoading'>;
interface PageLoadProps { t: PageMessages; children: ReactNode }

export function PageLoadingStatus({ t }: { t: PageMessages }) {
  return <div className="page-load-state" role="status" aria-live="polite"><p>{t.pageLoading.loading}</p></div>;
}

export function PageLoadError({ t, onReload }: { t: PageMessages; onReload(): void }) {
  return <div className="page-load-state" role="alert">
    <h2>{t.pageLoading.failed}</h2><p className="muted">{t.pageLoading.recovery}</p>
    <button type="button" className="button" onClick={onReload}>{t.pageLoading.reload}</button>
  </div>;
}

/** Only page content is fenced; navigation, alerts and permission controls remain mounted. */
export class PageRenderBoundary extends Component<PageLoadProps, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override render() {
    // A rejected lazy import stays cached in React. Reload is an explicit user action, never a retry loop.
    return this.state.failed ? <PageLoadError t={this.props.t} onReload={() => window.location.reload()} /> : this.props.children;
  }
}

export function PageLoadBoundary({ t, children }: PageLoadProps) {
  return <PageRenderBoundary t={t}><Suspense fallback={<PageLoadingStatus t={t} />}>{children}</Suspense></PageRenderBoundary>;
}
