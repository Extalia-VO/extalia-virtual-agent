import { describe, expect, it } from 'vitest';
import { splashMedia, splashUsesVideo } from '../src/boot/splashMedia';

describe('Splash background media', () => {
  it('plays the night loop in the dark theme and the day loop in the light theme, WebM first', () => {
    expect(splashMedia('dark')).toEqual({
      sources: [{ src: './splash/office-loop.webm', type: 'video/webm' }, { src: './splash/office-loop.mp4', type: 'video/mp4' }],
      poster: './splash/office-poster.webp',
    });
    const day = splashMedia('light', '/');
    expect(day.sources.map(source => source.src)).toEqual(['/splash/office-loop-day.webm', '/splash/office-loop-day.mp4']);
    expect(day.poster).toBe('/splash/office-poster-day.webp');
    expect(splashMedia('dark', '/app').poster).toBe('/app/splash/office-poster.webp');
  });

  it('keeps the still poster for reduced motion and Save-Data', () => {
    expect(splashUsesVideo({ reducedMotion: false })).toBe(true);
    expect(splashUsesVideo({ reducedMotion: false, saveData: false })).toBe(true);
    expect(splashUsesVideo({ reducedMotion: true })).toBe(false);
    expect(splashUsesVideo({ reducedMotion: false, saveData: true })).toBe(false);
  });
});
