import { useEffect, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { Brand } from '../ui/Brand';
import { CopyButton } from '../ui/CopyButton';
import { Icon } from '../ui/Icon';
import type { BootState } from './bootState';
import { readSplashMotion, splashMedia, splashUsesVideo } from './splashMedia';

/**
 * Pre-rendered 3D-office loop behind the wordmark (no WebGL). The poster frame paints at once;
 * the muted video fades in only when it can play, so a slow or missing video never delays boot.
 * Reduced motion, Save-Data and playback errors keep the poster.
 */
function SplashBackdrop() {
  const [media] = useState(() => splashMedia(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', import.meta.env.BASE_URL));
  const [video] = useState(() => splashUsesVideo(readSplashMotion()));
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // A decode error does not make the browser try the next <source>: remount from the next format.
  const [first, setFirst] = useState(0);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Muted as a property too, so autoplay policies accept it; a refused play() keeps the poster.
    element.muted = true;
    element.play().catch(() => undefined);
  }, [first]);
  const sources = media.sources.slice(first);
  const playbackFailed = () => {
    setReady(false);
    if (first + 1 < media.sources.length) setFirst(first + 1);
    else setFailed(true);
  };
  return (
    <div className={`splash-backdrop ${ready && !failed ? 'splash-video-ready' : ''}`} aria-hidden="true">
      <div className="splash-scene">
        <img className="splash-poster" src={media.poster} alt="" decoding="async" draggable={false} />
        {video && !failed && (
          <video key={first} ref={ref} className="splash-video" muted playsInline loop autoPlay preload="auto" poster={media.poster}
            disablePictureInPicture tabIndex={-1} onCanPlay={() => setReady(true)} onError={playbackFailed}>
            {/* No source loads (missing files, unsupported formats): the last <source> reports it. */}
            {sources.map((source, index) => (
              <source key={source.type} src={source.src} type={source.type}
                {...(index === sources.length - 1 ? { onError: () => setFailed(true) } : {})} />
            ))}
          </video>
        )}
      </div>
      <div className="splash-scrim" />
      <span /><span /><span />
    </div>
  );
}

/**
 * Lightweight branded start screen: markup, CSS and a pre-rendered video only (no WebGL),
 * so it paints immediately and costs nothing once the shell mounts. Loading shows a
 * status label without a fake percentage; a failed or slow boot turns into a
 * recovery panel with Retry and copyable details.
 */
export function Splash({ t, error, details, onRetry }: {
  t: Messages;
  error?: BootState['error'];
  /** Plain-text diagnostics shown and copied in the recovery panel. */
  details?: string;
  onRetry?: () => void;
}) {
  return (
    <div className={`splash ${error ? 'splash-error' : ''}`}>
      <SplashBackdrop />
      <div className="splash-card">
        <h1 className="splash-brand"><span aria-hidden="true"><Brand /></span><span className="visually-hidden">EXTALIA — Virtual Agent</span></h1>
        <p className="splash-tagline">{t.startup.tagline}</p>
        {error ? (
          <div className="splash-recovery" role="alert">
            <p><strong>{error.category === 'timeout' ? t.startup.timeout : t.startup.failed}</strong></p>
            <p className="muted">{error.category === 'timeout' ? t.startup.timeoutHint : error.message}</p>
            {onRetry && <div className="actions"><button type="button" className="primary" autoFocus onClick={onRetry}><Icon name="refresh" />{t.common.retry}</button></div>}
            {details && <details className="splash-details">
              <summary>{t.startup.diagnostics}</summary>
              <pre>{details}</pre>
              <CopyButton text={details} label={t.startup.diagnostics} />
            </details>}
          </div>
        ) : (
          <p className="splash-status" role="status" aria-live="polite"><span className="splash-bar" aria-hidden="true" /><span>{t.startup.loading}</span></p>
        )}
      </div>
    </div>
  );
}
