import type { DirectoryPickerOptions, DirectorySelection } from '@extalia/platform';
import type { BrowserWindow, Dialog, OpenDialogOptions } from 'electron';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const hasControls = (value: string) => /\p{Cc}/u.test(value);

/** Renderer hints choose presentation only; they never authorize access or save configuration. */
function parseOptions(raw: unknown): DirectoryPickerOptions {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(raw))) throw new Error('Invalid folder picker options.');
  const options = raw as Record<string, unknown>;
  if (Object.keys(options).some(key => !['title', 'initialPath', 'purpose'].includes(key))) throw new Error('Invalid folder picker options.');
  if (options.title !== undefined && (typeof options.title !== 'string' || !options.title.trim() || options.title.length > 160 || hasControls(options.title)))
    throw new Error('Invalid folder picker title.');
  if (options.initialPath !== undefined && (typeof options.initialPath !== 'string' || options.initialPath.length > 4096 || hasControls(options.initialPath)))
    throw new Error('Invalid folder picker location.');
  if (options.purpose !== undefined && (typeof options.purpose !== 'string' || !['project', 'knowledge-vault', 'skill', 'export'].includes(options.purpose)))
    throw new Error('Invalid folder picker purpose.');
  return { ...(options.title !== undefined ? { title: options.title as string } : {}),
    ...(options.initialPath !== undefined ? { initialPath: options.initialPath as string } : {}),
    ...(options.purpose !== undefined ? { purpose: options.purpose as DirectoryPickerOptions['purpose'] } : {}) };
}

const directoryExists = async (folder: string): Promise<boolean> => (await stat(folder).catch(() => undefined))?.isDirectory() ?? false;

/** One native, parented OS chooser; cancellation and invalid selection have no side effects. */
export async function selectNativeDirectory(owner: BrowserWindow | null, raw: unknown, options: {
  homeDirectory: string;
  dialog: Pick<Dialog, 'showOpenDialog'>;
}): Promise<DirectorySelection | null> {
  const input = parseOptions(raw);
  if (!owner || owner.isDestroyed()) return null;
  const initial = input.initialPath;
  const defaultPath = initial && path.isAbsolute(initial) && await directoryExists(initial) ? initial : options.homeDirectory;
  if (owner.isDestroyed()) return null;
  const settings: OpenDialogOptions = { ...(input.title ? { title: input.title } : {}), defaultPath,
    properties: input.purpose === 'skill' ? ['openDirectory'] : ['openDirectory', 'createDirectory'] };
  const result = await options.dialog.showOpenDialog(owner, settings);
  if (owner.isDestroyed() || result.canceled || result.filePaths.length !== 1) return null;
  const selected = result.filePaths[0];
  if (!selected || selected.length > 4096 || hasControls(selected) || !path.isAbsolute(selected) || !await directoryExists(selected)) return null;
  if (owner.isDestroyed()) return null;
  return { name: path.basename(selected) || selected, path: selected };
}
