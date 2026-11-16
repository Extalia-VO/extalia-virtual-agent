import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { DaemonSidecar } from '../src/daemon/index.js';
import { RustLearningBackend } from '../src/rustLearning.js';
import { DAEMON_BINARY } from './daemonBackend.js';

/** A genuine Rust process with only synthetic temporary profile state. */
export function useRustLearningBackend() {
  const owned: { daemon: DaemonSidecar; root: string }[] = [];
  afterEach(async () => {
    for (const { daemon, root } of owned.splice(0)) {
      await daemon.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  return async (dataDirectory?: string) => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-rust-learning-'));
    const data = dataDirectory ?? path.join(root, 'data');
    await mkdir(data, { recursive: true });
    const daemon = new DaemonSidecar({ binary: () => DAEMON_BINARY, dataDirectory: data, profile: 'default', clientVersion: 'test', env: {}, log: () => {} });
    owned.push({ daemon, root });
    return new RustLearningBackend(() => daemon.connect());
  };
}
