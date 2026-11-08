import { INSTALLER_COPY as copy } from '../../../web/src/i18n.ts';

const { window, document } = globalThis;
document.title = copy.macWizardTitle;
for (const element of document.querySelectorAll('[data-copy]')) element.textContent = copy[element.dataset.copy];
const preview = new URL(window.location.href).searchParams.get('preview') === '1';
const photos = [...document.querySelectorAll('.photo')];
const dots = [...document.querySelectorAll('.dot')];
const pause = document.querySelector('.pause');
const caption = document.querySelector('.photo-caption');
const install = document.querySelector('#install');
const continueButton = document.querySelector('#continue');
const status = document.querySelector('#status');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const captions = [copy.carouselBuilding, copy.carouselWorkspace, copy.carouselCollaboration];
let selected = 0;
let paused = false;
let timer;

function showSlide(index) {
  selected = (index + photos.length) % photos.length;
  photos.forEach((photo, i) => photo.classList.toggle('active', i === selected));
  dots.forEach((dot, i) => {
    dot.classList.toggle('selected', i === selected);
    dot.setAttribute('aria-pressed', String(i === selected));
  });
  caption.textContent = captions[selected];
  document.querySelector('.hero').dataset.slide = String(selected);
}
function schedule() {
  window.clearInterval(timer);
  timer = undefined;
  if (!paused && !document.hidden && !reducedMotion.matches) timer = window.setInterval(() => showSlide(selected + 1), 5000);
  pause.textContent = paused ? '▶' : 'Ⅱ';
  pause.setAttribute('aria-label', paused ? copy.carouselPlay : copy.carouselPause);
  pause.setAttribute('aria-pressed', String(paused));
}
function onVisibility() { schedule(); }
function onMotion() { schedule(); }
function onKey(event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  showSlide(selected + (event.key === 'ArrowLeft' ? -1 : 1));
  schedule();
}
dots.forEach((dot, index) => {
  dot.setAttribute('aria-label', copy.carouselShowSlide.replace('{number}', String(index + 1)));
  dot.addEventListener('click', () => { showSlide(index); schedule(); });
});
pause.addEventListener('click', () => { paused = !paused; schedule(); });
document.addEventListener('visibilitychange', onVisibility);
reducedMotion.addEventListener('change', onMotion);
document.addEventListener('keydown', onKey);
window.addEventListener('pagehide', () => {
  window.clearInterval(timer);
  document.removeEventListener('visibilitychange', onVisibility);
  reducedMotion.removeEventListener('change', onMotion);
  document.removeEventListener('keydown', onKey);
}, { once: true });
const messages = {
  installing: copy.macWizardInstalling, installed: copy.macWizardInstalled, cancelled: copy.macWizardCancelled,
  blocked: copy.macWizardRunning, error: copy.macWizardFailed, preview: copy.macWizardPreview,
};
function setState(state) {
  status.dataset.state = state;
  status.textContent = messages[state] ?? copy.macWizardFailed;
  install.disabled = state === 'installing' || state === 'installed';
  continueButton.disabled = state === 'installing' || state === 'installed';
  install.setAttribute('aria-busy', String(state === 'installing'));
}
install.addEventListener('click', async () => {
  setState('installing');
  try {
    const result = await window.extaliaInstaller.install();
    setState(result?.state ?? 'error');
  } catch { setState('error'); }
});
continueButton.addEventListener('click', async () => {
  continueButton.disabled = true;
  try { if (!await window.extaliaInstaller.continue()) setState('blocked'); }
  catch { setState('error'); }
});
if (preview) { install.textContent = copy.macWizardPreviewInstall; setState('preview'); }
showSlide(0);
schedule();
