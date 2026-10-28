import type { FolderCheck } from '@extalia/platform';
import type { WorkspaceDraft } from './validation';

export interface WorkspaceFolderRequest {
  generation: number;
  name: string;
  previousFolderName?: string;
}

/** Latest editor state and cancellation tokens for native selection and validation. */
export function createWorkspaceFolderRequests(initial: WorkspaceDraft) {
  let draft = initial;
  let generation = 0;
  const invalidate = () => { generation++; };
  const sync = (next: WorkspaceDraft) => {
    const changed = next.id !== draft.id || next.folderInput !== draft.folderInput || next.folder?.path !== draft.folder?.path;
    if (changed) invalidate();
    draft = next;
    return changed;
  };
  const begin = (): WorkspaceFolderRequest => ({ generation: ++generation, name: draft.name, previousFolderName: draft.folder?.name });
  const current = (request: WorkspaceFolderRequest) => request.generation === generation;
  return {
    invalidate, sync, begin, current,
    draft: () => draft,
    check(path: string) {
      const request = begin();
      draft = { ...draft, folderInput: path.trim(), folder: undefined };
      return { request, draft };
    },
    accept(request: WorkspaceFolderRequest, result: FolderCheck): WorkspaceDraft | undefined {
      if (!current(request) || !result.ok || !result.path) return undefined;
      const name = result.name ?? result.path.split(/[\\/]/).pop() ?? result.path;
      // Suggest a name only if it was blank/derived before checking and has not
      // since been edited. All unrelated fields come from the latest draft.
      const suggest = draft.name === request.name && (!request.name.trim() || request.name === request.previousFolderName);
      draft = { ...draft, folderInput: result.path, folder: { path: result.path, name }, ...(suggest ? { name } : {}) };
      return draft;
    },
  };
}
