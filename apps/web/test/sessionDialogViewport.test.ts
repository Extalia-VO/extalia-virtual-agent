import { expect, it } from 'vitest';
import { sessionDialogViewport } from '../src/office/sessionDialogViewport';

it('centers horizontally within the Office while using full screen height above and below its toolbar', () => {
  expect(sessionDialogViewport({ left: 0, top: 0, width: 1440, height: 1000 }, { left: 260, width: 1180 }))
    .toEqual({ centerX: 850, centerY: 500, width: 1180, height: 1000 });
});

it('uses visual viewport offsets and keyboard-reduced height without centering in a hidden screen region', () => {
  expect(sessionDialogViewport({ left: 12, top: 90, width: 390, height: 420 }, { left: 0, width: 414 }))
    .toEqual({ centerX: 207, centerY: 300, width: 390, height: 420 });
});

it('clips a partially visible Office and falls back to the screen when its bounds are unavailable', () => {
  const screen = { left: 0, top: 0, width: 1000, height: 800 };
  expect(sessionDialogViewport(screen, { left: 250, width: 1200 })).toEqual({ centerX: 625, centerY: 400, width: 750, height: 800 });
  for (const bounds of [undefined, { left: 1100, width: 200 }, { left: 0, width: 0 }])
    expect(sessionDialogViewport(screen, bounds)).toEqual({ centerX: 500, centerY: 400, width: 1000, height: 800 });
});
