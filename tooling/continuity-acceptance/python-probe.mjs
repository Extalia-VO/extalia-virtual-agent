/** Interpreter startup is separate from the unchanged candidate execution budget. */
export function executePythonProbe({ spawn, executable, argv, input, cwd }) {
  return new Promise(resolve => {
    const ready = Buffer.from('EXTALIA-PYTHON-READY\n');
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), startup = Buffer.alloc(0);
    let problem, finished = false, admitted = false, killTimer;
    const child = spawn(executable, argv, { shell: false, windowsHide: true, cwd,
      env: { PATH: process.env.PATH ?? '', HOME: cwd, USERPROFILE: cwd, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (exitCode, signal) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(killTimer);
      if (!admitted) problem ??= 'Python did not reach the trusted startup boundary.';
      let out = '', err = '';
      try {
        out = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
        err = new TextDecoder('utf-8', { fatal: true }).decode(stderr);
      } catch { problem ??= 'Python output was not UTF-8.'; }
      resolve({ exitCode, signal, stdout: out, stderr: err, problem });
    };
    const stop = reason => {
      problem ??= reason;
      try { child.kill('SIGKILL'); } catch { /* already closed */ }
      if (!killTimer) killTimer = setTimeout(() => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); finish(null, 'unconfirmed-close');
      }, 250);
    };
    // This marker is emitted by controller code before importing/compiling the
    // candidate. It is consumed once; candidate output afterwards stays exact.
    let timer = setTimeout(() => stop('Python startup exceeded its 5-second budget.'), 5000);
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > 131072) stop('Python stdout exceeded its byte budget.');
      else stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', chunk => {
      if (!admitted) {
        startup = Buffer.concat([startup, chunk]);
        const prefix = startup.subarray(0, Math.min(startup.length, ready.length));
        if (!prefix.equals(ready.subarray(0, prefix.length))) { stop('Python startup marker was invalid.'); return; }
        if (startup.length < ready.length) return;
        admitted = true; clearTimeout(timer);
        timer = setTimeout(() => stop('Python probe exceeded its 2-second budget.'), 2000);
        chunk = startup.subarray(ready.length); startup = Buffer.alloc(0);
      }
      if (stderr.length + chunk.length > 131072) stop('Python stderr exceeded its byte budget.');
      else stderr = Buffer.concat([stderr, chunk]);
    });
    child.stdin.on('error', () => { /* Early interpreter exit is checked through its receipt. */ });
    child.once('error', error => { problem = error.message; finish(null, null); });
    child.once('close', finish);
    child.stdin.end(input);
  });
}
