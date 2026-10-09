/**
 * Spill-light intensity for a powered panel of `area` m² showing content of average linear
 * `luminance`. A backlit panel is far brighter than a dark room, so a compressive response
 * keeps dark-theme UIs and lock screens as visible local sources while brighter content
 * still emits more. Desk surfaces in front of a monitor receive roughly a quarter of the
 * cached energy of an ordinary lit workspace; black content stays at zero.
 */
export function displayEmission(area: number, luminance: number) {
  return Math.min(48, Math.max(0, area) * Math.sqrt(Math.max(0, luminance) * 0.08) * 600);
}

/**
 * Average emitted RGB in linear space; black content contributes no spill light.
 * `backlight` scales panel output, e.g. a locked display dims below an active one.
 */
export function screenPhotometry(pixels: ArrayLike<number>, area: number, powered = true, backlight = 1) {
  let r = 0, g = 0, b = 0;
  const linear = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const count = Math.floor(pixels.length / 4);
  for (let i = 0; i < count * 4; i += 4) {
    const alpha = pixels[i + 3]! / 255;
    r += linear(pixels[i]!) * alpha;
    g += linear(pixels[i + 1]!) * alpha;
    b += linear(pixels[i + 2]!) * alpha;
  }
  if (!powered || !count) return { color: [0, 0, 0] as const, intensity: 0 };
  r /= count; g /= count; b /= count;
  const luminance = (r * 0.2126 + g * 0.7152 + b * 0.0722) * Math.max(0, backlight);
  const peak = Math.max(r, g, b, 0.0001);
  return {
    color: [r / peak, g / peak, b / peak] as const,
    intensity: displayEmission(area, luminance)
  };
}
