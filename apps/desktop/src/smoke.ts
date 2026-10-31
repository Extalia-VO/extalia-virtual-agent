import { nativeTheme, type BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * `electron . --smoke-test` loads the bundled UI in a hidden window, checks that
 * the preload bridge and the shell (or the first-run setup) rendered, prints a
 * JSON report and exits. With EXTALIA_SMOKE_SCREENSHOTS=<dir> it also saves
 * screenshots for review.
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(window: BrowserWindow, expression: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression).catch(() => false)) return true;
    await delay(100);
  }
  return false;
}

type Page = 'start' | 'logs' | 'diagnostics' | 'office' | 'settings';
const SHELL = `document.querySelector('.brand') && document.querySelector('.topbar-meta')`;
const SETUP = `document.querySelector('[data-onboarding-step]')`;
// Navigation before buttons carried data-page: the page is identified by its position.
const LEGACY_ORDER = ['office', 'chat', 'console', 'tasks', 'terminal', 'files', 'git', 'logs', 'start', 'diagnostics', 'settings'];

/** Open a page from the sidebar. Returns false when this build has no such page. */
async function open(window: BrowserWindow, page: Page): Promise<boolean> {
  const opened = await window.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('.nav-item')];
    const button = items.some(item => item.dataset.page) ? items.find(item => item.dataset.page === ${JSON.stringify(page)}) : items[${LEGACY_ORDER.indexOf(page)}];
    button?.click();
    return Boolean(button);
  })()`).catch(() => false) as boolean;
  if (opened) await settle(window);
  return opened;
}

/** Wait for layout, entrance animations and transitions to finish before reading or capturing. */
async function settle(window: BrowserWindow): Promise<void> {
  await delay(100);
  await window.webContents.executeJavaScript('Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getTiming().iterations)).map(animation => animation.finished.catch(() => undefined))).then(() => true)').catch(() => false);
  await delay(100);
}

type Theme = 'light' | 'dark';
type Material = 'standard' | 'liquid-glass';
const SHOTS: [Page, Theme, Material, number, number][] = [
  ['start', 'light', 'standard', 1280, 820], ['logs', 'dark', 'standard', 1280, 820], ['diagnostics', 'dark', 'standard', 1280, 820],
  ['start', 'light', 'standard', 390, 844], ['start', 'light', 'liquid-glass', 1280, 820], ['logs', 'light', 'liquid-glass', 1280, 820],
  ['diagnostics', 'dark', 'liquid-glass', 1280, 820], ['logs', 'dark', 'liquid-glass', 1280, 820],
];

async function captureScreenshots(window: BrowserWindow, directory: string, setup: boolean): Promise<string[]> {
  await mkdir(directory, { recursive: true });
  window.setMinimumSize(320, 480);
  // The first-run setup replaces the shell, so capture it once per theme, material and width instead of per page.
  const shots = setup ? SHOTS.filter(([, theme, material, width], index) => SHOTS.findIndex(other => other[1] === theme && other[2] === material && other[3] === width) === index) : SHOTS;
  const files: string[] = [];
  let material: Material = 'standard';
  for (const [page, theme, nextMaterial, width, height] of shots) {
    if (nextMaterial !== material) {
      // Preferences live in this throwaway profile's storage; reload to apply them like a user would.
      material = nextMaterial;
      await window.webContents.executeJavaScript(`localStorage.setItem('extalia.ui.v1', JSON.stringify({ theme: 'system', material: '${material}', language: 'en', sidebar: 'expanded' })); location.reload();`);
      await waitFor(window, `Boolean(${SHELL} || ${SETUP})`);
    }
    nativeTheme.themeSource = theme;
    window.setContentSize(width, height);
    if (setup) await settle(window);
    else if (!await open(window, page)) continue;
    const image = await window.webContents.capturePage();
    const file = path.join(directory, `${setup ? 'setup' : page}-${theme}-${material}-${width}.png`);
    await writeFile(file, image.toPNG());
    files.push(file);
  }
  return files;
}

export async function runSmokeTest(window: BrowserWindow, screenshotDir = process.env.EXTALIA_SMOKE_SCREENSHOTS): Promise<number> {
  const modelErrors: string[] = [];
  const rendererErrors: string[] = [];
  window.webContents.on('console-message', (event: unknown) => {
    const message = typeof event === 'object' && event && 'message' in event ? String(event.message) : '';
    const level = typeof event === 'object' && event && 'level' in event ? String(event.level) : '';
    if ((level === 'error' || level === '3') && rendererErrors.length < 20) rendererErrors.push(message.slice(0, 1000));
    if (/GLTFLoader.*(Couldn.t|Error)|WebAssembly.*(violates|failed)/i.test(message)) modelErrors.push(message.slice(0, 500));
  });
  const rendered = await waitFor(window, `Boolean(${SHELL} || ${SETUP})`);
  const report = rendered ? await window.webContents.executeJavaScript(`(async () => {
    const desktop = window.extaliaDesktop;
    const label = document.querySelector('.topbar-meta')?.textContent;
    // The first-run setup has no top bar; fall back to what the bridge reports.
    const info = label ? undefined : await desktop?.info().catch(() => undefined);
    return {
      desktopBridge: typeof desktop === 'object',
      nodeExposed: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
      title: document.title,
      setup: document.querySelector('[data-onboarding-step]')?.getAttribute('data-onboarding-step') ?? null,
      host: label ?? (info?.kind === 'desktop' ? 'Desktop · v' + info.appVersion : ''),
      hostSource: label ? 'ui' : 'bridge',
      protocol: document.location.protocol,
      agents: await desktop?.agents.call('getState', []).then(() => 'available', error => error.message),
      updater: await desktop?.updater.status().then(status => status.state, error => error.message),
      // The Splash loop must load through the app scheme (CSP media-src, MIME type, byte ranges).
      splashVideo: await new Promise(resolve => {
        const video = document.createElement('video');
        video.muted = true;
        const done = value => { clearTimeout(timer); video.removeAttribute('src'); video.load(); resolve(value); };
        const timer = setTimeout(() => done('timeout'), 8000);
        video.oncanplay = () => done('canplay ' + video.videoWidth + 'x' + video.videoHeight);
        video.onerror = () => done('error ' + (video.error?.code ?? '') + ' ' + (video.error?.message ?? ''));
        video.src = './splash/office-loop.webm';
      }),
      splashRange: await fetch('./splash/office-loop.mp4', { headers: { range: 'bytes=0-15' } })
        .then(response => response.status + ' ' + response.headers.get('content-type') + ' ' + response.headers.get('content-range'), error => error.message),
    };
  })()`) as Record<string, unknown> : {};

  const setup = rendered && report.setup !== null;
  const diagnostics = rendered && !setup && await open(window, 'diagnostics')
    ? await window.webContents.executeJavaScript(`[...document.querySelectorAll('.facts div')].map(row => row.innerText.replace(/\\s+/g, ' ').trim())`) as string[]
    : [];

  const screenshots = rendered && screenshotDir ? await captureScreenshots(window, screenshotDir, setup) : [];

  // The throwaway profile seeds a local character to exercise bundled models.
  // No prompt/model request or access to a real user project is made.
  if (rendered && setup) {
    await window.webContents.executeJavaScript(`(async () => {
      const api = window.extaliaDesktop.agents;
      const current = await api.call('getState', []);
      const next = await api.call('saveConnection', [{ name: 'Smoke model', preset: 'custom', api: 'openai-chat', baseUrl: 'http://127.0.0.1:4319/v1', model: 'mock-agent', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } }]);
      const registered = await api.call('saveWorkspace', [{ name: 'Smoke workspace', projectLocation: current.storage.dataDirectory, connectionId: next.connections[0].id, permissions: { fileWrite: 'ask', commands: 'ask' } }]);
      const session = await api.call('createSession', [registered.workspaces[0].id]);
      await api.call('renameSession', [session.id, 'Smoke character']);
      await api.call('completeSetup', []);
      location.reload();
    })()`);
    await waitFor(window, `Boolean(${SHELL})`);
  }
  const officeOpened = rendered && await open(window, 'office');
  const officeRendered = officeOpened && await waitFor(window, `Boolean(document.querySelector('.office-stage canvas') || document.querySelector('.office-stage [role="alert"]'))`);
  const officeReady = `Boolean(document.querySelector('.office-stage canvas')) && !document.querySelector('.office-loading:not(.done)') && !document.querySelector('.office-stage [role="alert"]')`;
  // Software WebGL and hosted macOS runners need minutes for the first shaders and models.
  const sceneReady = officeRendered && await waitFor(window, officeReady, 120_000);
  const office = officeOpened ? await window.webContents.executeJavaScript(`({
    route: document.querySelector('.nav-item[data-page="office"]')?.getAttribute('aria-current'),
    canvas: Boolean(document.querySelector('.office-stage canvas')),
    separateFrame: Boolean(document.querySelector('.office-stage iframe')),
    protocol: location.protocol,
    alert: document.querySelector('.office-stage [role="alert"]')?.textContent ?? null,
    loading: document.querySelector('.office-loading:not(.done) [role="progressbar"]')?.getAttribute('aria-valuenow') ?? null,
  })`) as Record<string, unknown> : {};
  const floorViews: boolean[] = [];
  if (screenshotDir && officeOpened) {
    await waitFor(window, officeReady, 30_000);
    const file = path.join(screenshotDir, 'office-desktop.png');
    await writeFile(file, (await window.webContents.capturePage()).toPNG());
    screenshots.push(file);
  }
  if (officeOpened) {
    await open(window, 'office');
    await waitFor(window, officeReady, 30_000);
    for (const floor of [1, 2, 3]) {
      const chosen = await window.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('.topbar-office button[data-view="${floor}"]');
        button?.click(); return Boolean(button);
      })()`) as boolean;
      await settle(window);
      floorViews.push(chosen && await waitFor(window, `document.querySelector('.topbar-office button[data-view="${floor}"]')?.getAttribute('aria-pressed') === 'true'`));
      if (screenshotDir && chosen) {
        const file = path.join(screenshotDir, `office-f${floor}-desktop.png`);
        await writeFile(file, (await window.webContents.capturePage()).toPNG());
        screenshots.push(file);
      }
    }
  }

  // Check Settings after the scene captures so navigation cannot remount the
  // Office and replace the verified scene with a fresh loading overlay.
  const settingsOpened = rendered && await open(window, 'settings');

  const ok = rendered && report.desktopBridge === true && report.nodeExposed === false && String(report.host).startsWith('Desktop')
    && String(report.splashVideo).startsWith('canplay') && String(report.splashRange).startsWith('206 video/mp4')
    && officeRendered && sceneReady && modelErrors.length === 0 && office.route === 'page' && office.separateFrame === false && settingsOpened && floorViews.length === 3 && floorViews.every(Boolean);
  console.log(JSON.stringify({ ok, rendered, ...report, office, sceneReady, modelErrors, rendererErrors, floorViews, settingsOpened, diagnostics, screenshots }, null, 2));
  return ok ? 0 : 1;
}
