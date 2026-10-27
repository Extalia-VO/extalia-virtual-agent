import type { AgentHostApi, BuiltinSkillInfo, FileSystemCapability, HostState, SkillRegistryReport } from '@extalia/platform';
import { useEffect, useState } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { ProjectSkills, projectSkillsSupported } from './ProjectSkills';
import { SkillSecurityCenter } from './SkillSecurityCenter';
import { useSkillRegistryMode } from './skillCenterModel';
import { useBuiltinSkills } from './skillsModel';

/**
 * Skills: everything that decides which skills reach agents, in one page (moved out of Settings).
 * With the native core (`mode: 'registry'`) it is the Skill Security Center; otherwise W0 project-skill consent for
 * every workspace, grouped by workspace. Built-in skills are listed read-only in both modes.
 */

export interface SkillsPageProps {
  t: Messages;
  agents: AgentHostApi;
  state: HostState;
  picker?: FileSystemCapability;
  /** Open on one workspace only (Settings → Workspaces "Review"); used once, then the page shows all workspaces again on later visits. */
  focusWorkspaceId?: string;
  onFocusHandled?: () => void;
  /** After an allow, revoke or registry action, so the nav badge can be recomputed. */
  onChanged?: () => void;
}

export function SkillsPage({ t, agents, state, picker, focusWorkspaceId, onFocusHandled, onChanged }: SkillsPageProps) {
  const mode = useSkillRegistryMode(agents);
  const [filter, setFilter] = useState<string | null>(focusWorkspaceId ?? null);
  useEffect(() => { if (focusWorkspaceId) onFocusHandled?.(); }, [focusWorkspaceId, onFocusHandled]);
  const builtin = useBuiltinSkills(agents);
  return <SkillsPageView t={t} agents={agents} state={state} picker={picker} mode={mode} filter={filter} onFilter={setFilter}
    builtin={builtin.skills} builtinLoading={builtin.loading} onChanged={onChanged} />;
}

/** Hook-free shell so tests can render each mode; the sections it mounts load their own data. */
export function SkillsPageView({ t, agents, state, picker, mode, filter, onFilter, builtin, builtinLoading, onChanged }: {
  t: Messages;
  agents: AgentHostApi;
  state: HostState;
  picker?: FileSystemCapability | undefined;
  /** `null` while the host has not answered yet. */
  mode: SkillRegistryReport['mode'] | null;
  filter: string | null;
  onFilter: (workspaceId: string | null) => void;
  builtin: BuiltinSkillInfo[] | null;
  builtinLoading: boolean;
  onChanged?: (() => void) | undefined;
}) {
  const p = t.skillsPage;
  return (
    <div className="page skills-page">
      <header className="page-header">
        <h1>{p.title}</h1>
        <p className="lead">{p.lead}</p>
      </header>
      {mode === null && <p className="muted" role="status">{p.loading}</p>}
      {mode === 'registry' && <SkillSecurityCenter t={t} agents={agents} picker={picker} state={state} onChanged={onChanged} />}
      {mode === 'legacy' && projectSkillsSupported(agents) && (
        <ProjectSkillsSection t={t} agents={agents} workspaces={state.workspaces} filter={filter} onFilter={onFilter} onChanged={onChanged} />
      )}
      <BuiltinSkillsSection t={t} skills={builtin} loading={builtinLoading} />
    </div>
  );
}

type Workspace = HostState['workspaces'][number];

/** W0 consent for every workspace with a project folder, one group per workspace, optionally narrowed to one. */
function ProjectSkillsSection({ t, agents, workspaces, filter, onFilter, onChanged }: {
  t: Messages; agents: AgentHostApi; workspaces: readonly Workspace[]; filter: string | null; onFilter: (workspaceId: string | null) => void; onChanged?: (() => void) | undefined;
}) {
  const p = t.skillsPage;
  const withFolder = workspaces.filter(workspace => workspace.projectLocation);
  const focused = filter ? withFolder.find(workspace => workspace.id === filter) : undefined;
  const shown = focused ? [focused] : withFolder;
  return (
    <section className="card settings-section skills-projects" aria-labelledby="skills-projects-title">
      <div className="section-head">
        <div>
          <h2 id="skills-projects-title"><Icon name="folder" />{p.projectsTitle}</h2>
          <p className="muted small">{p.projectsLead}</p>
        </div>
        {focused && <button type="button" className="button small" onClick={() => onFilter(null)}>{p.showAll}</button>}
      </div>
      {focused && <p className="muted small" role="status">{p.filtered(focused.name)}</p>}
      {shown.length === 0 ? <p className="muted small">{p.noWorkspaces}</p> : (
        <div className="skills-workspaces">
          {shown.map(workspace => <ProjectSkills key={workspace.id} t={t} agents={agents} workspace={workspace} onChanged={onChanged} />)}
        </div>
      )}
      <p className="note small skills-registry-note"><Icon name="shield" /><span>{p.registryNote}</span></p>
    </section>
  );
}

/** Read-only: the skills that ship with the app. Hidden when the host does not list them. */
export function BuiltinSkillsSection({ t, skills, loading }: { t: Messages; skills: BuiltinSkillInfo[] | null; loading: boolean }) {
  const p = t.skillsPage;
  if (!skills && !loading) return null;
  return (
    <section className="card settings-section skills-builtin" aria-labelledby="skills-builtin-title">
      <h2 id="skills-builtin-title"><Icon name="spark" />{p.builtinTitle}</h2>
      <p className="muted small">{p.builtinLead}</p>
      {!skills ? <p className="muted small" role="status">{p.loading}</p> : (
        <ul className="skills-builtin-list">
          {skills.map(skill => (
            <li key={skill.name} className="skills-builtin-item">
              <code className="skills-builtin-name">{skill.name}</code>
              <span className="small">{skill.description}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
