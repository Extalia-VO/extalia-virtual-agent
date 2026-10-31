/**
 * Visual-QA and benchmark hooks on `window` (`__EXTALIA_SOLAR_PREVIEW__`, `__EXTALIA_SET_RENDER_BUDGET__`,
 * `__EXTALIA_TRAFFIC_PIN__`, `__EXTALIA_BENCH__`, `?carSeed=`). They exist in the dev server and in
 * `vite build --mode development` (production React and minified code, used by `tooling/bench/office-fps.mjs`),
 * never in the shipped `vite build`. Both values are compile-time constants, so release bundles drop the hooks.
 */
export const QA_HOOKS: boolean = import.meta.env.DEV || import.meta.env.MODE === 'development';
