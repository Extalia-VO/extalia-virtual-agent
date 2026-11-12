import {
  normalizeMemoryDelete, normalizeMemoryListOptions, normalizeMemoryName, normalizeMemoryReadOptions, normalizeMemoryWrite,
  type AgentHostApi,
} from '@extalia/platform';
import { MemoryConflictError, type MemoryStore } from './memory.js';

type Methods = Pick<Required<AgentHostApi>, 'nativeMemoryList' | 'nativeMemoryRead' | 'nativeMemoryWrite' | 'nativeMemoryDelete'>;

/** User operations only; agent access remains feature-gated through createMemoryTools. */
export class NativeMemoryService {
  private closed = false;
  private pending = new Map<Promise<unknown>, string>();
  private removing = new Set<string>();
  constructor(private readonly options: {
    store(workspaceId: string): MemoryStore;
    checkOpen(): void;
    checkAdmission?(): void;
    /** Pending ownership is reserved before awaiting foreground maintenance drain. */
    beforeForeground?(): Promise<void> | void;
    onIdle?(): void;
  }) {}

  isBusy(workspaceId?: string): boolean {
    return workspaceId === undefined ? this.pending.size > 0 : [...this.pending.values()].includes(workspaceId);
  }
  private check(workspaceId: string) {
    this.options.checkOpen();
    if (this.closed) throw new Error('Workspace memory is closing.');
    if (typeof workspaceId !== 'string' || this.removing.has(workspaceId)) throw new Error('Workspace memory is unavailable.');
  }
  private run<T>(workspaceId: string, action: (store: MemoryStore) => Promise<T>): Promise<T> {
    this.check(workspaceId);
    this.options.checkAdmission?.();
    // Resolving the store validates membership in the current profile before any file access.
    const store = this.options.store(workspaceId);
    const work = Promise.resolve().then(async () => {
      await this.options.beforeForeground?.();
      return action(store);
    }).finally(() => {
      this.pending.delete(work);
      if (!this.pending.size) this.options.onIdle?.();
    });
    this.pending.set(work, workspaceId);
    return work;
  }

  readonly methods: Methods = {
    nativeMemoryList: async (workspaceId, input) => {
      const page = normalizeMemoryListOptions(input);
      return this.run(workspaceId, async store => ({ workspaceId, ...await store.listPage(page) }));
    },
    nativeMemoryRead: async (workspaceId, name, input) => {
      const noteName = normalizeMemoryName(name);
      const page = normalizeMemoryReadOptions(input);
      return this.run(workspaceId, async store => {
        try {
          const note = await store.readPage(noteName, page);
          return note ? { status: 'found', note: { workspaceId, ...note } } : { status: 'missing' };
        } catch (error) {
          if (error instanceof MemoryConflictError) return { status: 'conflict' };
          throw error;
        }
      });
    },
    nativeMemoryWrite: async (workspaceId, input) => {
      const request = normalizeMemoryWrite(input);
      return this.run(workspaceId, async store => {
        try {
          const result = await store.write(request.name, request.content, { expectedRevision: request.expectedRevision });
          return { status: 'saved', ...result };
        } catch (error) {
          if (error instanceof MemoryConflictError) return { status: 'conflict' };
          throw error;
        }
      });
    },
    nativeMemoryDelete: async (workspaceId, input) => {
      const request = normalizeMemoryDelete(input);
      return this.run(workspaceId, async store => {
        try {
          await store.delete(request.name, { expectedRevision: request.expectedRevision });
          return { status: 'deleted' };
        } catch (error) {
          if (error instanceof MemoryConflictError) return { status: 'conflict' };
          throw error;
        }
      });
    },
  };

  /** Reserve deletion synchronously, preventing new memory operations after the busy check. */
  async withWorkspaceDeletion<T>(workspaceId: string, remove: () => Promise<T>): Promise<T> {
    this.check(workspaceId);
    if (this.isBusy(workspaceId)) throw new Error('Wait for workspace memory operations before deleting this workspace.');
    this.removing.add(workspaceId);
    const work = Promise.resolve().then(remove).finally(() => {
      this.removing.delete(workspaceId);
      this.pending.delete(work);
      if (!this.pending.size) this.options.onIdle?.();
    });
    this.pending.set(work, workspaceId);
    return work;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending.keys()]);
  }
}
