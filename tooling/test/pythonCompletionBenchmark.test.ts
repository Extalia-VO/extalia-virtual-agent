import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { completionCommand, spawnCompletionChild } from '../bench/provider-completion-worker.mjs';

const workerId = '00000000-0000-4000-8000-000000000001';
const config = { backend: 'python', python: { executable: '/runtime/python3', script: '/repo/tooling/bench/python/provider_worker.py' } };

describe('Python completion benchmark launch adapter', () => {
  it('launches the selected isolated interpreter with the real worker correlation ID', () => {
    expect(completionCommand(config, '/unused/native', ['--provider-worker', workerId])).toEqual({
      binary: '/runtime/python3', args: ['-I', '-B', '-u', config.python.script, '--provider-worker', workerId],
    });
    for (const args of [['--provider-complete'], ['--provider-worker', 'untrusted'], ['--provider-worker', workerId, '--extra']]) {
      expect(() => completionCommand(config, '/unused/native', args)).toThrow('Invalid Python worker launch');
    }
  });

  it('returns the original child and preserves the host credential-free environment', () => {
    const child = Object.assign(new EventEmitter(), { pid: 123, kill: vi.fn() });
    const spawn = vi.fn(() => child);
    const env = { TMPDIR: '/temporary' };
    const actual = spawnCompletionChild(config, '/unused/native', ['--provider-worker', workerId], { cwd: '/temporary', env }, spawn);
    expect(actual).toBe(child);
    expect(spawn).toHaveBeenCalledExactlyOnceWith('/runtime/python3', ['-I', '-B', '-u', config.python.script, '--provider-worker', workerId], {
      cwd: '/temporary', env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(spawn.mock.calls[0]![2].env).toBe(env);
    const closed = vi.fn(); actual.once('close', closed); actual.kill('SIGKILL'); child.emit('close', 0);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(closed).toHaveBeenCalledOnce();
  });

  it('uses the identical Python command only inside the separate OS diagnostic wrapper', () => {
    const child = new EventEmitter(); const spawn = vi.fn(() => child);
    expect(spawnCompletionChild(config, '/unused/native', ['--provider-worker', workerId], { env: {} }, spawn, '/temporary/time.txt')).toBe(child);
    const flags = process.platform === 'darwin' ? ['-l', '-o', '/temporary/time.txt'] : ['-v', '-o', '/temporary/time.txt'];
    expect(spawn.mock.calls[0]![0]).toBe('/usr/bin/time');
    expect(spawn.mock.calls[0]![1]).toEqual([...flags, '/runtime/python3', '-I', '-B', '-u', config.python.script, '--provider-worker', workerId]);
  });

  it('keeps both existing Rust launch forms unchanged', () => {
    for (const args of [['--provider-worker', workerId], ['--provider-complete']]) {
      expect(completionCommand({ backend: 'rust' }, '/runtime/native', args)).toEqual({ binary: '/runtime/native', args });
    }
  });
});
