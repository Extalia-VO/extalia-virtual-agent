/* global window */
/** QA-only launch policy. Do not silently override the browser's GPU blocklist. */
export function officeBrowserArgs(platform, gpuPolicy = 'native') {
  if (!['native', 'ignore-blocklist'].includes(gpuPolicy)) throw new Error('Invalid --gpu-policy: use native or ignore-blocklist.');
  return ['--use-gl=angle', ...(platform === 'darwin' ? ['--use-angle=metal'] : []),
    '--headless=new', ...(gpuPolicy === 'ignore-blocklist' ? ['--ignore-gpu-blocklist'] : []),
    '--enable-webgl-draft-extensions', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
}

/** Passed directly to page.evaluate; no module closures or private paths. */
export function officeRendererInfo() {
  const renderer = window.__EXTALIA_BENCH__?.renderer;
  const gl = renderer?.getContext();
  if (!gl) return null;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const unmaskedRenderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
  const unmaskedVendor = debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null;
  const softwareRendererHint = typeof unmaskedRenderer === 'string'
    ? /swiftshader|llvmpipe|softpipe|software rasterizer/i.test(unmaskedRenderer) : null;
  const canvas = renderer.domElement;
  return {
    version: gl.getParameter(gl.VERSION), vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
    unmaskedVendor, unmaskedRenderer, softwareRendererHint,
    drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
    pixelRatio: renderer.getPixelRatio(), nativeDpr: window.devicePixelRatio,
    engine: canvas.getAttribute('data-engine'),
    contextAttributes: gl.getContextAttributes(),
  };
}
