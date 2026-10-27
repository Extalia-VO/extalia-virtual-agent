/**
 * Pre-rendered 3D-office loop behind the Splash (rendered by tooling/capture-splash.mjs, see
 * docs/design/splash.md). The Splash never mounts the WebGL Office: it plays a short muted video,
 * or shows its poster frame when motion should be avoided.
 */
export interface SplashMedia {
  /** VP9 WebM first, H.264 MP4 as the fallback; both loop seamlessly. */
  sources: readonly { src: string; type: string }[];
  /** First frame of the loop, also the still image for reduced motion and Save-Data. */
  poster: string;
}

/** Night loop (lit windows) for the dark theme, daylight loop for the light theme. */
export function splashMedia(theme: 'dark' | 'light', base = './'): SplashMedia {
  const root = `${base.endsWith('/') ? base : `${base}/`}splash/`;
  const suffix = theme === 'light' ? '-day' : '';
  return {
    sources: [
      { src: `${root}office-loop${suffix}.webm`, type: 'video/webm' },
      { src: `${root}office-loop${suffix}.mp4`, type: 'video/mp4' },
    ],
    poster: `${root}office-poster${suffix}.webp`,
  };
}

export interface SplashMotionInput {
  reducedMotion: boolean;
  /** `navigator.connection.saveData`: the user asked sites to use less data. */
  saveData?: boolean | undefined;
}

/** The video is decoration: reduced motion and Save-Data get the still poster only. */
export function splashUsesVideo(input: SplashMotionInput): boolean {
  return !input.reducedMotion && input.saveData !== true;
}

/** Reads the motion and data preferences of this device (false when an API is missing). */
export function readSplashMotion(): SplashMotionInput {
  if (typeof window === 'undefined') return { reducedMotion: true };
  const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return { reducedMotion, saveData: connection?.saveData === true };
}
