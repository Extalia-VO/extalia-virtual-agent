import {
  MAX_TEAM_MODELS, MEMBER_ACCESS, MEMBER_GENDERS, decodeAgentTeam, generateFullName, newTeamMemberId,
  type AgentTeam, type MemberAccess, type MemberGender, type TeamMember,
} from '@extalia/core';
import type { EventBody } from '@extalia/protocol';
import { findTeamMember } from './delegation.js';
import type { ToolDefinition } from './tools.js';

/**
 * `manage_team`: the lead adds, updates or removes members of its own subagent
 * team, for example when the user asks in plain words ("make two backend
 * subagents …"). The result is validated like a team saved in the UI, saved
 * with the session, and new members appear in the Office at once.
 */
export interface ManageTeamOptions {
  /** The current team (undefined: none yet). */
  getTeam(): AgentTeam | undefined;
  /** Persist a validated team; returns the saved team. Errors are shown to the model. */
  saveTeam(team: AgentTeam): Promise<AgentTeam>;
  /** Names used elsewhere in the Office (other sessions' leads and members), for unique names. */
  takenNames(): Iterable<string>;
  /** Seed for generated names (for example the session id). */
  seed: string;
  emit(body: EventBody): void;
  newId?: () => string;
}

type ManageInput = {
  action: 'add' | 'update' | 'remove' | 'list';
  member?: string;
  name?: string;
  gender?: MemberGender;
  role?: string;
  task?: string;
  soul?: string;
  models?: string[];
  access?: MemberAccess;
  scope?: string[];
  forbidden?: string[];
};

const line = (value: string) => value.replace(/\s+/g, ' ').trim();

export function describeTeam(team: AgentTeam | undefined): string {
  if (!team?.members.length) return 'The team has no members.';
  return [`Team (${team.enabled ? 'enabled' : 'disabled'}):`, ...team.members.map(member => {
    const access = member.access === 'write'
      ? `can edit${member.scope?.length ? ` ${member.scope.join(', ')}` : ' the workspace'}${member.forbidden?.length ? `, never ${member.forbidden.join(', ')}` : ''}`
      : 'read-only';
    return `- ${member.name} (${member.role}; ${access}; models: ${member.models.join(' → ') || 'lead chain'})${member.task ? `: ${line(member.task)}` : ''}`;
  })].join('\n');
}

export function createManageTeamTool(options: ManageTeamOptions): ToolDefinition<ManageInput> {
  const newId = options.newId ?? newTeamMemberId;
  const list = { type: 'array' as const, items: { type: 'string' as const } };
  return {
    name: 'manage_team',
    description:
      'Create and configure your own subagent team when the user asks for subagents or a team. add: a new member (role required; leave name empty to get a ' +
      'generated unique full name). update: change a member\'s fields. remove: take a member off the team. list: show the team. Members with access "write" may edit ' +
      'files inside scope (never forbidden paths), one writer at a time; "read" members only research. models is an ordered fallback chain: use only model ids ' +
      'the user named or the team already allows. Hand work to members with delegate_task.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove', 'list'], description: 'What to do.' },
        member: { type: 'string', description: 'For update and remove: the member\'s name or id.' },
        name: { type: 'string', description: 'Full name (first and last). Leave out to generate one.' },
        gender: { type: 'string', enum: MEMBER_GENDERS, description: 'female or male (for the avatar). Leave out to choose with the generated name.' },
        role: { type: 'string', description: 'Short role, for example "Backend Engineer".' },
        task: { type: 'string', description: 'The member\'s standing responsibility.' },
        soul: { type: 'string', description: 'Persona and working principles (up to 1000 characters).' },
        models: { ...list, description: 'Ordered model ids: preferred first, then fallbacks. Empty: your own model chain.' },
        access: { type: 'string', enum: MEMBER_ACCESS, description: 'read (default) or write.' },
        scope: { ...list, description: 'Workspace-relative directories, files or globs a write member may edit. Empty: the whole workspace.' },
        forbidden: { ...list, description: 'Workspace-relative paths the member must never edit (wins over scope).' },
      },
      required: ['action'],
    },
    access: 'meta',
    kind: 'delegate',
    describe: input => ({
      label: input.action === 'list' ? 'Reading the team'
        : `${input.action === 'add' ? 'Adding' : input.action === 'update' ? 'Updating' : 'Removing'} ${line(input.name || input.member || input.role || 'a member').slice(0, 60)}`,
      target: 'team',
    }),
    async run(input) {
      const current = options.getTeam();
      if (input.action === 'list') return { ok: true, output: describeTeam(current) };
      const members: TeamMember[] = (current?.members ?? []).map(member => ({ ...member }));
      const allowedModels = [...(current?.allowedModels ?? [])];
      for (const model of input.models ?? []) if (!allowedModels.includes(model)) allowedModels.push(model);
      if (allowedModels.length > MAX_TEAM_MODELS) return { ok: false, output: `A team can allow at most ${MAX_TEAM_MODELS} models.` };
      const others = new Set([...options.takenNames()].map(name => name.toLowerCase()));
      const named = input.name?.trim() ? line(input.name) : undefined;
      if (named && others.has(named.toLowerCase())) return { ok: false, output: `"${named}" is already used by another agent in the Office. Choose another name or leave name out to generate one.` };

      let changed: TeamMember | undefined;
      let removed: TeamMember | undefined;
      if (input.action === 'add') {
        if (!input.role?.trim()) return { ok: false, output: 'Give the new member a role.' };
        let name = named, gender = input.gender;
        if (!name) {
          const used = new Set([...others, ...members.map(member => member.name.toLowerCase())]);
          const generated = generateFullName(`${options.seed}#member#${members.length}#${input.role}`, used, gender);
          name = generated.name; gender = generated.gender;
        }
        changed = {
          id: newId(), name, ...(gender ? { gender } : {}), role: line(input.role), ...(input.task?.trim() ? { task: input.task.trim() } : {}),
          models: [...(input.models ?? [])], ...(input.soul?.trim() ? { soul: input.soul.trim() } : {}), access: input.access ?? 'read',
          ...(input.scope?.length ? { scope: input.scope } : {}), ...(input.forbidden?.length ? { forbidden: input.forbidden } : {}),
        };
        members.push(changed);
      } else {
        const target = input.member?.trim() ? findTeamMember(members, input.member) : undefined;
        if (!target) return { ok: false, output: `There is no team member "${input.member ?? ''}". ${describeTeam(current)}` };
        if (input.action === 'remove') {
          removed = target;
          members.splice(members.indexOf(target), 1);
        } else {
          if (named) target.name = named;
          if (input.gender) target.gender = input.gender;
          if (input.role?.trim()) target.role = line(input.role);
          if (input.task !== undefined) { if (input.task.trim()) target.task = input.task.trim(); else delete target.task; }
          if (input.soul !== undefined) { if (input.soul.trim()) target.soul = input.soul.trim(); else delete target.soul; }
          if (input.models) target.models = [...input.models];
          if (input.access) target.access = input.access;
          if (input.scope) { if (input.scope.length) target.scope = input.scope; else delete target.scope; }
          if (input.forbidden) { if (input.forbidden.length) target.forbidden = input.forbidden; else delete target.forbidden; }
          changed = target;
        }
      }
      const draft = {
        enabled: input.action === 'remove' ? (current?.enabled ?? false) && members.length > 0 : true,
        allowedModels, members,
        ...(current?.goal ? { goal: current.goal } : {}), ...(current?.rules?.length ? { rules: current.rules } : {}),
      };
      const decoded = decodeAgentTeam(draft);
      if (!decoded.ok) return { ok: false, output: `The team was not changed: ${decoded.errors.join(' ')}` };
      let saved: AgentTeam;
      try { saved = await options.saveTeam(decoded.value); }
      catch (error) { return { ok: false, output: `The team was not changed: ${error instanceof Error ? error.message : String(error)}` }; }
      if (changed) {
        const member = saved.members.find(item => item.id === changed!.id) ?? changed;
        options.emit({ type: 'subagent.spawned', subagentId: member.id, role: member.role, label: member.name });
        options.emit({ type: 'subagent.state', subagentId: member.id, state: 'idle', summary: input.action === 'add' ? 'Joined the team' : 'Updated' });
      }
      if (removed) options.emit({ type: 'subagent.state', subagentId: removed.id, state: 'offline', summary: 'Removed from the team' });
      const verb = input.action === 'add' ? `Added ${changed!.name}` : input.action === 'update' ? `Updated ${changed!.name}` : `Removed ${removed!.name}`;
      return { ok: true, output: `${verb}.\n${describeTeam(saved)}` };
    },
  };
}
