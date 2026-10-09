import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { clip, countSecrets, redact, safeLabel } from '@extalia/core';
import type { AnyTool, ToolDefinition } from '@extalia/runtime';
import { isNotFound, writeFileAtomic } from './jsonStore.js';
import { bound, failure, text } from './tools/shared.js';

export const MEMORY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MEMORY_CONTENT_LIMIT = 20_000;

export interface MemoryNote {
  name: string;
  /** First non-empty line, without Markdown heading marks, at most 120 characters. */
  summary: string;
  updatedAt: string;
}

function checkName(name: string): string {
  if (typeof name !== 'string' || !MEMORY_NAME_PATTERN.test(name)) {
    throw new Error('Memory note names use lowercase letters, numbers and hyphens (up to 64 characters), for example "project-setup".');
  }
  return name;
}

function summarize(content: string): string {
  const line = content.split(/\r?\n/).map(item => item.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return clip(line, 120);
}

/** Extalia's own notes, one Markdown file per note. Credentials are masked before anything is saved. */
export class MemoryStore {
  constructor(readonly directory: string) {}

  private file(name: string): string {
    return path.join(this.directory, `${checkName(name)}.md`);
  }

  async list(): Promise<MemoryNote[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if (isNotFound(error)) return []; throw error; }
    const notes: MemoryNote[] = [];
    for (const entry of names.sort()) {
      const name = entry.endsWith('.md') ? entry.slice(0, -3) : '';
      if (!MEMORY_NAME_PATTERN.test(name)) continue;
      const file = path.join(this.directory, entry);
      try {
        const [content, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
        if (info.isFile()) notes.push({ name, summary: summarize(content), updatedAt: info.mtime.toISOString() });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return notes;
  }

  async read(name: string): Promise<string | undefined> {
    try { return await readFile(this.file(name), 'utf8'); }
    catch (error) { if (isNotFound(error)) return undefined; throw error; }
  }

  /** Save a note. Returns how many likely credentials were masked. */
  async write(name: string, content: string): Promise<{ masked: number }> {
    const file = this.file(name);
    if (typeof content !== 'string' || !content.trim()) throw new Error('A memory note needs content.');
    if (content.length > MEMORY_CONTENT_LIMIT) throw new Error(`A memory note is limited to ${MEMORY_CONTENT_LIMIT} characters; this one has ${content.length}. Keep notes short and specific.`);
    const masked = countSecrets(content);
    await writeFileAtomic(file, redact(content));
    return { masked };
  }

  async delete(name: string): Promise<void> {
    await rm(this.file(name), { force: true });
  }
}

type NameInput = { name: string };
type WriteInput = { name: string; content: string };

/** `memory_list`, `memory_read`, `memory_write`: the agent's long-term notes. */
export function createMemoryTools(store: MemoryStore): AnyTool[] {
  const nameProperty = { type: 'string', description: 'Note name: lowercase letters, numbers and hyphens, for example "build-commands".' } as const;
  const list: ToolDefinition<Record<string, never>> = {
    name: 'memory_list',
    description: 'List saved memory notes with a one-line summary each. Notes persist across sessions.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    access: 'memory',
    kind: 'knowledge',
    describe: () => ({ label: 'Listing memory notes' }),
    run: async () => {
      const notes = await store.list();
      if (!notes.length) return { ok: true, output: 'No memory notes yet.' };
      return { ok: true, output: bound(notes.map(note => `${note.name} — ${note.summary || '(empty)'} (updated ${note.updatedAt})`).join('\n')) };
    },
  };
  const read: ToolDefinition<NameInput> = {
    name: 'memory_read',
    description: 'Read a saved memory note.',
    parameters: { type: 'object', properties: { name: nameProperty }, required: ['name'], additionalProperties: false },
    access: 'memory',
    kind: 'knowledge',
    describe: input => ({ label: `Reading memory ${safeLabel(input.name, 64)}`, target: safeLabel(input.name, 64) }),
    run: async input => {
      const name = text(input.name);
      if (!MEMORY_NAME_PATTERN.test(name)) return failure(`"${safeLabel(name, 64)}" is not a valid memory note name.`);
      const content = await store.read(name);
      if (content !== undefined) return { ok: true, output: bound(content) };
      const names = (await store.list()).map(note => note.name);
      return failure(`There is no memory note "${name}".${names.length ? ` Available: ${names.join(', ')}.` : ''}`);
    },
  };
  const write: ToolDefinition<WriteInput> = {
    name: 'memory_write',
    description: `Create or replace a memory note (Markdown, up to ${MEMORY_CONTENT_LIMIT} characters). Save durable facts worth remembering across sessions, such as build commands or user preferences. Never save credentials; they are masked.`,
    parameters: {
      type: 'object',
      properties: { name: nameProperty, content: { type: 'string', description: 'Full note content. The first line is used as its summary.' } },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    access: 'memory',
    kind: 'knowledge',
    describe: input => ({ label: `Saving memory ${safeLabel(input.name, 64)}`, target: safeLabel(input.name, 64) }),
    run: async input => {
      try {
        const { masked } = await store.write(text(input.name), text(input.content));
        return { ok: true, output: `Saved memory note "${input.name}".${masked ? ` ${masked} likely credential(s) were masked.` : ''}` };
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
  return [list, read, write];
}
