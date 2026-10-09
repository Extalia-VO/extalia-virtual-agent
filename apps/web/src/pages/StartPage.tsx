import type { Messages } from '../i18n';
import { CommandLine } from '../ui/CopyButton';
import { Icon } from '../ui/Icon';

const RELEASES_URL = 'https://github.com/Extalia-VO/extalia-virtual-agent/releases';

/** Get started for the static web build, where no agent host is reachable. */
export function StartPage({ t }: { t: Messages }) {
  return (
    <div className="page">
      <header className="page-header">
        <h1>{t.start.title}</h1>
        <p className="lead">{t.start.lead}</p>
      </header>
      <section className="card">
        <h2>{t.start.runTitle}</h2>
        <p className="muted">{t.start.runLead}</p>
        <div className="grid two top-gap">
          <div className="option">
            <h3><Icon name="monitor" />{t.start.desktopTitle}</h3>
            <p className="muted">{t.start.desktopLead}</p>
            <a className="button" href={RELEASES_URL} target="_blank" rel="noopener noreferrer"><Icon name="external" />{t.start.desktopLink}</a>
          </div>
          <div className="option">
            <h3><Icon name="terminal" />{t.start.cliTitle}</h3>
            <p className="muted">{t.start.cliLead}</p>
            <CommandLine command={t.start.installCommand} />
            <p className="muted">{t.start.cliRun}</p>
            <CommandLine command="extalia" />
          </div>
        </div>
      </section>
      <section className="card">
        <h2>{t.start.hereTitle}</h2>
        <ul className="checklist">
          {t.start.here.map(([title, text]) => (
            <li key={title}><Icon name="check" className="ok" /><span><strong>{title}</strong> — <span className="muted">{text}</span></span></li>
          ))}
        </ul>
      </section>
    </div>
  );
}
