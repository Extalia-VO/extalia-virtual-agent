import type { ObservedCodexAnswerInput, ObservedCodexMessageInput, ObservedCodexStatus, ObservedCodexApprovalAnswerInput, PromptSuggestionsStatus } from '@extalia/platform';
import { CodexObservedControl, type CodexObservedRpcFactory } from './codexObservedControl.js';
import { findOnPath, isExecutable } from './connect/util.js';

interface SourceBinding { threadId: string; cwd?: string; watching: boolean }
interface Options {
  target(id: string): SourceBinding | undefined;
  env: Readonly<Record<string, string | undefined>>;
  rpcFactory?: CodexObservedRpcFactory;
  onActivity?: (sessionId: string) => void;
}

/** Ephemeral, user-only connection registry. It never installs hooks or starts an agent engine. */
export class ObservedCodexService {
  private readonly controls = new Map<string, { fingerprint: string; control: CodexObservedControl }>();
  private readonly work = new Map<string, Promise<unknown>>();
  private closed = false;
  private readonly blocked = new Set<string>();
  private readonly cleanup = new Map<string, Promise<void>>();
  private readonly cleanupFailures = new Set<string>();
  private suggestionsPrivate = false;

  constructor(private readonly options: Options) {}

  private target(id: string): SourceBinding | undefined {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Choose an observed Codex session.');
    return this.options.target(id);
  }
  private fingerprint(binding: SourceBinding) { return JSON.stringify([binding.threadId, binding.cwd]); }
  private unavailable(id: string, problem: string): ObservedCodexStatus {
    return { sessionId: id, state: 'unavailable', canSend: false, canAnswer: false, requests: [], problem };
  }
  private stop(id: string, control: CodexObservedControl): Promise<void> {
    // Calling close seals the controller synchronously, before any persistence wait.
    const stopped = control.close();
    const previous = this.cleanup.get(id);
    const pending = Promise.all([previous, stopped]).then(() => undefined);
    this.cleanup.set(id, pending);
    void pending.then(() => {
      if (this.cleanup.get(id) === pending) this.cleanup.delete(id);
    }, () => {
      this.cleanupFailures.add(id);
      if (this.cleanup.get(id) === pending) this.cleanup.delete(id);
    });
    return pending;
  }
  private valid(id: string) {
    const binding = this.target(id);
    const entry = this.controls.get(id);
    if (!binding?.watching || this.blocked.has(id) || entry && entry.fingerprint !== this.fingerprint(binding)) {
      if (entry) { this.controls.delete(id); void this.stop(id, entry.control); }
      return { binding, entry: undefined };
    }
    return { binding, entry };
  }
  async status(id: string): Promise<ObservedCodexStatus> {
    if (this.closed) return this.unavailable(id, 'The Extalia host is closed.');
    const { binding, entry } = this.valid(id);
    if (!binding) return this.unavailable(id, 'Only an existing observed Codex session can be connected.');
    if (!binding.watching || this.blocked.has(id)) return this.unavailable(id, 'Resume observation before connecting to Codex.');
    if (this.cleanupFailures.has(id)) return this.unavailable(id, 'Codex proxy cleanup could not be confirmed. Control is disabled.');
    return entry?.control.status() ?? { sessionId: id, state: 'disconnected', canSend: false, canAnswer: false, requests: [] };
  }
  async suggestions(id: string): Promise<PromptSuggestionsStatus> {
    const unavailable: PromptSuggestionsStatus = { sessionId: id, state: this.suggestionsPrivate ? 'private' : 'unavailable', prompts: [], origin: 'harness', canRequest: false };
    if (this.closed || this.cleanupFailures.has(id)) return unavailable;
    return this.valid(id).entry?.control.suggestions() ?? unavailable;
  }
  setSuggestionsPrivacy(value: boolean): void {
    this.suggestionsPrivate = value;
    for (const { control } of this.controls.values()) control.setSuggestionsPrivacy(value);
  }
  async requestSuggestions(id: string, anchor: string): Promise<PromptSuggestionsStatus> {
    if (this.closed || this.cleanupFailures.has(id)) return this.suggestions(id);
    const { entry } = this.valid(id);
    if (!entry) return this.suggestions(id);
    await entry.control.requestSuggestions(anchor);
    // The same controller may have changed turn or privacy between continuations.
    return this.valid(id).entry === entry ? entry.control.suggestions() : this.suggestions(id);
  }
  private mutate<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.target(id);
    if (this.closed) return Promise.reject(new Error('The Extalia host is closed.'));
    if (this.work.has(id)) return Promise.reject(new Error('Wait for the current Codex operation to finish.'));
    const promise = Promise.resolve().then(action);
    this.work.set(id, promise);
    void promise.finally(() => { if (this.work.get(id) === promise) this.work.delete(id); }).catch(() => undefined);
    return promise;
  }
  async connect(id: string, socketPath: string): Promise<ObservedCodexStatus> {
    return this.mutate(id, async () => {
      const binding = this.target(id);
      if (!binding?.watching || this.blocked.has(id)) throw new Error('Choose a watched Codex session.');
      await this.cleanup.get(id);
      if (this.cleanupFailures.has(id)) throw new Error('Codex proxy cleanup could not be confirmed. Control is disabled.');
      const fingerprint = this.fingerprint(binding);
      const previous = this.controls.get(id);
      this.controls.delete(id);
      if (previous) await this.stop(id, previous.control);
      const override = this.options.env.EXTALIA_CODEX_BIN;
      const bin = override && await isExecutable(override) ? override : !override ? await findOnPath('codex', this.options.env, process.platform) : undefined;
      if (!bin) return this.unavailable(id, 'Codex CLI with app-server proxy support was not found.');
      if (this.closed || this.blocked.has(id) || this.fingerprint(this.target(id) ?? { threadId: '', watching: false }) !== fingerprint || !this.target(id)?.watching) throw new Error('The observed source changed. Connect again.');
      const control = new CodexObservedControl({
        sessionId: id, threadId: binding.threadId, ...(binding.cwd ? { cwd: binding.cwd } : {}), bin,
        env: { ...this.options.env }, ...(this.options.rpcFactory ? { rpcFactory: this.options.rpcFactory } : {}),
        onActivity: () => this.options.onActivity?.(id),
      });
      control.setSuggestionsPrivacy(this.suggestionsPrivate);
      this.controls.set(id, { fingerprint, control });
      try {
        const status = await control.connect(socketPath);
        if (this.closed || this.valid(id).entry?.control !== control) { await this.stop(id, control); throw new Error('The observed source changed. Connect again.'); }
        return status;
      } catch (error) { await this.stop(id, control); throw error; }
    });
  }
  private current(id: string, connectionId: string): CodexObservedControl {
    const { entry } = this.valid(id);
    if (!entry || typeof connectionId !== 'string' || entry.control.status().connectionId !== connectionId) throw new Error('This Codex connection is no longer active. Connect again.');
    return entry.control;
  }
  send(id: string, input: ObservedCodexMessageInput): Promise<ObservedCodexStatus> {
    return this.mutate(id, () => this.current(id, input?.connectionId).send(input));
  }
  answer(id: string, input: ObservedCodexAnswerInput): Promise<ObservedCodexStatus> {
    return this.mutate(id, () => this.current(id, input?.connectionId).answer(input));
  }
  answerApproval(id: string, input: ObservedCodexApprovalAnswerInput): Promise<ObservedCodexStatus> {
    return this.mutate(id, () => this.current(id, input?.connectionId).answerApproval(input));
  }
  disconnect(id: string, connectionId: string): Promise<ObservedCodexStatus> {
    return this.mutate(id, async () => {
      const control = this.current(id, connectionId);
      this.controls.delete(id);
      await this.stop(id, control);
      return this.status(id);
    });
  }
  /** Pause/delete invalidates control immediately, including in-flight attachment. */
  async drop(id: string): Promise<void> {
    this.blocked.add(id);
    const entry = this.controls.get(id);
    this.controls.delete(id);
    if (entry) await this.stop(id, entry.control);
    await this.work.get(id)?.catch(() => undefined);
    await this.cleanup.get(id);
    if (this.cleanupFailures.has(id)) throw new Error('Codex proxy cleanup could not be confirmed.');
  }
  resume(id: string): void { this.blocked.delete(id); }
  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.controls.entries()];
    this.controls.clear();
    const stopped = entries.map(([id, entry]) => this.stop(id, entry.control));
    const results = await Promise.allSettled([...stopped, ...this.cleanup.values()]);
    await Promise.allSettled([...this.work.values()]);
    if (this.cleanupFailures.size || results.some(result => result.status === 'rejected')) throw new Error('Codex control cleanup did not settle cleanly.');
  }
}
