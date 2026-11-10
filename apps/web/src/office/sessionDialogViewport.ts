export interface DialogViewport { left: number; top: number; width: number; height: number }
export interface OfficeHorizontalBounds { left: number; width: number }

/** Horizontal placement belongs to the Office; vertical space belongs to the visible screen. */
export function sessionDialogViewport(screen: DialogViewport, office?: OfficeHorizontalBounds | null) {
  const screenLeft = screen.left, screenRight = screen.left + screen.width;
  const start = office ? Math.max(screenLeft, office.left) : screenLeft;
  const end = office ? Math.min(screenRight, office.left + office.width) : screenRight;
  const left = end > start ? start : screenLeft;
  const width = end > start ? end - start : screen.width;
  return { centerX: left + width / 2, centerY: screen.top + screen.height / 2, width, height: screen.height };
}
