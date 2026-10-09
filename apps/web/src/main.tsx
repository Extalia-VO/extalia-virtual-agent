import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolvePlatform } from './platform';
// Interface fonts ship with the app (SIL OFL 1.1): no third-party requests, and they work offline and under the CSP.
import '@fontsource-variable/geist';
import '@fontsource-variable/inter';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/quicksand';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

resolvePlatform().then(
  platform => root.render(<StrictMode><App platform={platform} /></StrictMode>),
  error => {
    console.error('Extalia could not start.', error);
    root.render(<p className="startup-error">Extalia could not start. See the console for details.</p>);
  },
);
