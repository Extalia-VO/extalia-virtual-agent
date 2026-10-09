import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { clip, safeLabel } from '@extalia/core';
import type { AnyTool, ToolDefinition } from '@extalia/runtime';
import { BUILTIN_SKILLS } from './builtinSkills.js';
import { isNotFound } from './jsonStore.js';
import { bound, failure, text } from './tools/shared.js';

export type SkillSource = 'builtin' | 'user' | 'workspace';

export interface Skill {
  name: string;
  description: string;
  source: SkillSource;
  /** Instructions in Markdown, without the front matter. */
  body: string;
}

export interface LoadSkillsOptions {
  /** Directory with the user's skills (`<dir>/<skill>/SKILL.md`). */
  userDirectory?: string;
  /** Workspace whose `.extalia/skills/<skill>/SKILL.md` files are loaded. */
  workspaceRoot?: string;
}

export interface LoadedSkills {
  skills: Skill[];
  /** Skill files that were skipped, with the reason. */
  warnings: string[];
}

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 256 * 1024;
const DESCRIPTION_LIMIT = 500;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0];
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Parse a SKILL.md file: a front matter block (`---`, `name: …`,
 * `description: …`, `---`) followed by the instructions. The name defaults to
 * the skill's directory name. Throws with the reason when the file is invalid.
 */
export function parseSkill(content: string, fallbackName: string, source: SkillSource): Skill {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new Error('missing front matter (the file must start with a "---" line).');
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close === -1) throw new Error('front matter is not closed with a "---" line.');
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    const match = /^([A-Za-z][\w-]*)\s*:(.*)$/.exec(line);
    if (match) fields[match[1]!.toLowerCase()] = unquote(match[2]!);
  }
  const name = fields.name || fallbackName;
  if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`invalid name "${safeLabel(name, 64)}" (use lowercase letters, numbers and hyphens).`);
  const description = fields.description?.trim();
  if (!description) throw new Error('missing "description" in front matter.');
  const body = lines.slice(close + 1).join('\n').trim();
  if (!body) throw new Error('the skill has no instructions after the front matter.');
  return { name, description: clip(description, DESCRIPTION_LIMIT), source, body };
}

async function loadDirectory(directory: string, source: SkillSource, label: string, warnings: string[]): Promise<Skill[]> {
  let entries: Dirent[];
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (!isNotFound(error)) warnings.push(`${label}: cannot read the skills folder.`);
    return [];
  }
  // Workspace content is not trusted: links could point at files outside the project.
  const followLinks = source !== 'workspace';
  const skills: Skill[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory() && !(followLinks && entry.isSymbolicLink())) continue;
    const file = path.join(directory, entry.name, 'SKILL.md');
    const where = `${label}/${entry.name}/SKILL.md`;
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() && !followLinks) { warnings.push(`${where}: symbolic links are not loaded from a workspace.`); continue; }
      if (info.size > MAX_SKILL_BYTES) { warnings.push(`${where}: larger than 256 KB.`); continue; }
      skills.push(parseSkill(await readFile(file, 'utf8'), entry.name, source));
    } catch (error) {
      if (isNotFound(error)) continue;
      warnings.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return skills;
}

/** Built-in skills, then user skills, then workspace skills; a later skill replaces an earlier one with the same name. */
export async function loadSkills({ userDirectory, workspaceRoot }: LoadSkillsOptions = {}): Promise<LoadedSkills> {
  const warnings: string[] = [];
  const byName = new Map<string, Skill>();
  for (const skill of BUILTIN_SKILLS) byName.set(skill.name, { ...skill });
  if (userDirectory) for (const skill of await loadDirectory(userDirectory, 'user', 'user skills', warnings)) byName.set(skill.name, skill);
  if (workspaceRoot) {
    const directory = path.join(workspaceRoot, '.extalia', 'skills');
    for (const skill of await loadDirectory(directory, 'workspace', '.extalia/skills', warnings)) byName.set(skill.name, skill);
  }
  const skills = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { skills, warnings };
}

type ReadInput = { name: string };

/** `skill_read`: the model reads a skill's instructions on demand. Returns no tools when there are no skills. */
export function createSkillTools(skills: readonly Skill[]): AnyTool[] {
  if (!skills.length) return [];
  const byName = new Map(skills.map(skill => [skill.name, skill]));
  const catalog = skills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n');
  const read: ToolDefinition<ReadInput> = {
    name: 'skill_read',
    description: bound(`Read the instructions of a skill before doing the task it covers. Available skills:\n${catalog}`, 8000),
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name.', enum: skills.map(skill => skill.name) } },
      required: ['name'],
      additionalProperties: false,
    },
    access: 'meta',
    kind: 'knowledge',
    describe: input => ({ label: `Reading skill ${safeLabel(input.name, 64)}`, target: safeLabel(input.name, 64) }),
    run: async input => {
      const skill = byName.get(text(input.name));
      if (!skill) return failure(`There is no skill "${safeLabel(input.name, 64)}". Available: ${[...byName.keys()].join(', ')}.`);
      return { ok: true, output: bound(`# Skill: ${skill.name}\n${skill.description}\n\n${skill.body}`) };
    },
  };
  return [read];
}
