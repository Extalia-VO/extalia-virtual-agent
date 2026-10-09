import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolvePlatform } from './platform';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

resolvePlatform().then(
  platform => root.render(<StrictMode><App platform={platform} /></StrictMode>),
  error => {
    console.error('Extalia could not start.', error);
    root.render(<p className="startup-error">Extalia could not start. See the console for details.</p>);
  },
);
