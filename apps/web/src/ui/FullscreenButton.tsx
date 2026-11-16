import { useEffect, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { Icon } from './Icon';
import { browserFullscreenActive, browserFullscreenAvailable, toggleBrowserFullscreen } from './browserFullscreen';
import './fullscreen.css';

export function FullscreenButton({ t }: { t: Messages }) {
  const [display, setDisplay] = useState({ active: false, available: false });
  const [changing, setChanging] = useState(false);
  const [failed, setFailed] = useState(false);
  const admitted = useRef(false);
  useEffect(() => {
    const update = () => setDisplay({ active: browserFullscreenActive(document), available: browserFullscreenAvailable(document) });
    const error = () => setFailed(true);
    update();
    for (const event of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(event, update);
    for (const event of ['fullscreenerror', 'webkitfullscreenerror']) document.addEventListener(event, error);
    return () => {
      for (const event of ['fullscreenchange', 'webkitfullscreenchange']) document.removeEventListener(event, update);
      for (const event of ['fullscreenerror', 'webkitfullscreenerror']) document.removeEventListener(event, error);
    };
  }, []);
  const toggle = () => {
    if (admitted.current) return;
    admitted.current = true; setChanging(true); setFailed(false);
    void toggleBrowserFullscreen(document).catch(() => setFailed(true)).finally(() => {
      admitted.current = false; setChanging(false);
      setDisplay({ active: browserFullscreenActive(document), available: browserFullscreenAvailable(document) });
    });
  };
  const label = display.active ? t.fullscreen.exit : t.fullscreen.enter;
  return <div className="fullscreen-control">
    <button type="button" className="icon-button app-fullscreen" aria-label={label} title={display.available || display.active ? label : t.fullscreen.unavailable}
      aria-pressed={display.active} disabled={changing || (!display.available && !display.active)} onClick={toggle}>
      <Icon name={display.active ? 'minimize' : 'maximize'} />
    </button>
    {failed && <span className="fullscreen-error" role="alert">{t.fullscreen.failed}</span>}
  </div>;
}
