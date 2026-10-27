/* global document, localStorage, window */
// Paints the first frame in the stored theme before the app bundle loads (no theme flash).
// A classic same-origin script so it runs under the Desktop CSP (script-src 'self').
// The app re-applies the exact values (including the Solar theme) as soon as it starts.
(function () {
  try {
    var root = document.documentElement;
    var stored = JSON.parse(localStorage.getItem('extalia.ui.v1') || '{}').state || {};
    var theme = stored.theme;
    var dark = theme === 'dark' ? true
      : theme === 'light' ? false
      : theme === 'solar' && localStorage.getItem('extalia.ui.resolved-theme') ? localStorage.getItem('extalia.ui.resolved-theme') === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'dark' : 'light';
    if (typeof stored.material === 'string') root.dataset.material = stored.material;
    if (typeof stored.font === 'string') root.dataset.font = stored.font;
  } catch {
    /* Storage blocked or damaged: the app applies its defaults when it starts. */
  }
})();
