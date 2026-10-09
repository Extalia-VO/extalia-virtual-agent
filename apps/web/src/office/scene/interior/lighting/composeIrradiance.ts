import { DataUtils } from "three";

export interface IrradianceField { radiance: Float32Array; direction: Uint8Array }

/** Combine lamp-controlled architecture and independently powered devices without extra GPU samplers. */
export function composeIrradiance(architecture: IrradianceField | undefined, devices: IrradianceField | undefined,
  power: number, radiance: Uint16Array, direction: Uint8Array) {
  const ar = architecture?.radiance, ad = architecture?.direction;
  const dr = devices?.radiance, dd = devices?.direction;
  const lampPower = Math.max(0, power), one = DataUtils.toHalfFloat(1);
  for (let i = 0; i < radiance.length; i += 4) {
    const aR = (ar?.[i] ?? 0) * lampPower, aG = (ar?.[i + 1] ?? 0) * lampPower, aB = (ar?.[i + 2] ?? 0) * lampPower;
    const dR = dr?.[i] ?? 0, dG = dr?.[i + 1] ?? 0, dB = dr?.[i + 2] ?? 0;
    const r = aR + dR, g = aG + dG, b = aB + dB;
    radiance[i + 3] = one; direction[i + 3] = 255;
    if (r + g + b <= 0) {
      radiance[i] = radiance[i + 1] = radiance[i + 2] = 0;
      direction[i] = direction[i + 1] = direction[i + 2] = 128;
      continue;
    }
    radiance[i] = DataUtils.toHalfFloat(Math.min(65000, r));
    radiance[i + 1] = DataUtils.toHalfFloat(Math.min(65000, g));
    radiance[i + 2] = DataUtils.toHalfFloat(Math.min(65000, b));
    const aw = aR * 0.2126 + aG * 0.7152 + aB * 0.0722;
    const dw = dR * 0.2126 + dG * 0.7152 + dB * 0.0722;
    const x = ((ad?.[i] ?? 128) / 127.5 - 1) * aw + ((dd?.[i] ?? 128) / 127.5 - 1) * dw;
    const y = ((ad?.[i + 1] ?? 128) / 127.5 - 1) * aw + ((dd?.[i + 1] ?? 128) / 127.5 - 1) * dw;
    const z = ((ad?.[i + 2] ?? 128) / 127.5 - 1) * aw + ((dd?.[i + 2] ?? 128) / 127.5 - 1) * dw;
    const length = Math.hypot(x, y, z), scale = length > 0 ? 127.5 / length : 0;
    direction[i] = Math.round(127.5 + x * scale);
    direction[i + 1] = Math.round(127.5 + y * scale);
    direction[i + 2] = Math.round(127.5 + z * scale);
  }
}
