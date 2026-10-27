import type { KeyboardEvent } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { groupFocusTarget, OFFICE_VIEWS, useOfficeControls } from './officeControls';
import type { FurnishedOfficeView } from './scene/FurnishedFloors';
import { LIGHT_OVERRIDES } from './scene/environment/lightOverride';

/** Arrow keys move focus between the buttons of one group; Enter/Space press them. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
  const target = groupFocusTarget(event.key, buttons.indexOf(event.target as HTMLButtonElement), buttons.length);
  if (target === undefined) return;
  event.preventDefault();
  buttons[target]?.focus();
}

function viewLabel(t: Messages, view: FurnishedOfficeView): { text: string; label?: string } {
  if (view === 'campus') return { text: t.office.campus };
  if (view === 'stack') return { text: t.office.stack };
  return { text: `F${view}`, label: t.office[`f${view}`] };
}

/** Floor tabs and light switch in the App top bar, shown only while the 3D Office is open. */
export function OfficeTopbarControls({ t }: { t: Messages }) {
  const view = useOfficeControls(state => state.view);
  const setView = useOfficeControls(state => state.setView);
  const lightOverride = useOfficeControls(state => state.lightOverride);
  const setLightOverride = useOfficeControls(state => state.setLightOverride);
  return (
    <div className="topbar-office" role="toolbar" aria-label={t.nav.officeControls}>
      <div className="topbar-segment" role="group" aria-label={t.office.view} onKeyDown={moveFocus}>
        {OFFICE_VIEWS.map(option => {
          const { text, label } = viewLabel(t, option);
          return <button key={option} type="button" data-view={option} aria-pressed={view === option} aria-label={label} title={label ?? text} onClick={() => setView(option)}>{text}</button>;
        })}
      </div>
      <div className="topbar-segment topbar-lights" role="group" aria-label={t.office.lights} title={t.office.lightHints[lightOverride]} onKeyDown={moveFocus}>
        <Icon name="bulb" />
        {LIGHT_OVERRIDES.map(mode => <button key={mode} type="button" aria-pressed={lightOverride === mode} title={t.office.lightHints[mode]} onClick={() => setLightOverride(mode)}>{t.office.lightModes[mode]}</button>)}
      </div>
    </div>
  );
}
