import { parseEventLines, type ExtaliaEvent } from '@extalia/protocol';
import { useMemo, useState } from 'react';
import { demoSessionLines } from '../demoEvents';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';

/** `loadCurrent` offers the events of the session open in Chat, when agents are available. */
export function EventLogPage({ t, loadCurrent }: { t: Messages; loadCurrent?: () => Promise<ExtaliaEvent[]> }) {
  const [input, setInput] = useState(demoSessionLines);
  const [checked, setChecked] = useState(input);
  const results = useMemo(() => parseEventLines(checked), [checked]);
  const valid = results.filter(entry => entry.result.ok).length;

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t.logs.title}</h1>
        <p className="lead">{t.logs.lead}</p>
      </header>
      <section className="card">
        <label className="field">
          <span>{t.logs.input}</span>
          <textarea className="code-input" value={input} onChange={event => setInput(event.target.value)} rows={8} spellCheck={false} />
        </label>
        <div className="actions">
          <button type="button" className="primary" onClick={() => setChecked(input)}>{t.logs.validate}</button>
          <button type="button" onClick={() => { const sample = demoSessionLines(); setInput(sample); setChecked(sample); }}>
            <Icon name="refresh" />{t.logs.sample}
          </button>
          {loadCurrent && (
            <button type="button" onClick={() => { loadCurrent().then(events => { const lines = events.map(item => JSON.stringify(item)).join('\n'); setInput(lines); setChecked(lines); }, () => undefined); }}>
              <Icon name="chat" />{t.logs.current}
            </button>
          )}
          <span className="muted" role="status">{t.logs.summary(valid, results.length)}</span>
        </div>
      </section>
      <section className="card table-card">
        {results.length === 0 ? <p className="muted">{t.logs.empty}</p> : (
          <table>
            <thead><tr><th>{t.logs.line}</th><th>{t.logs.type}</th><th>{t.logs.agent}</th><th>{t.logs.result}</th></tr></thead>
            <tbody>
              {results.map(({ line, result }) => (
                <tr key={line}>
                  <td className="numeric">{line}</td>
                  <td><code>{result.ok ? result.event.body.type : '—'}</code></td>
                  <td>{result.ok ? result.event.agentId ?? '—' : '—'}</td>
                  <td>
                    {result.ok
                      ? <span className="status ok"><Icon name="check" />{t.logs.ok}</span>
                      : <span className="status error"><Icon name="alert" />{result.errors.join(' ')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
