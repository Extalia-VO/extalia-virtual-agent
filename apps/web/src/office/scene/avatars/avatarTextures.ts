import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from "three";

/**
 * Small procedural textures shared by every avatar instance. Each texture is
 * generated once per key and cached, so dozens of avatars add no extra uploads.
 * Returns undefined outside the browser (SSR tooling) so materials fall back to flat color.
 */
const cache = new Map<string, Texture>();

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] | undefined {
  if (typeof document === "undefined") return undefined;
  const element = document.createElement("canvas");
  element.width = size;
  element.height = size;
  const context = element.getContext("2d");
  return context ? [element, context] : undefined;
}

function seeded(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507) ^ Math.imul(state ^ (state >>> 13), 3266489909);
    return ((state ^= state >>> 16) >>> 0) / 4294967296;
  };
}

/** Radial iris: limbal ring, fibrous streaks, warm collarette and a dark pupil. */
export function irisTexture(color: string): Texture | undefined {
  const key = `iris:${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const made = canvas(128);
  if (!made) return undefined;
  const [element, ctx] = made;
  const random = seeded(color.split("").reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7));
  const c = 64;
  const base = ctx.createRadialGradient(c, c, 8, c, c, 64);
  base.addColorStop(0, "#1c1712");
  base.addColorStop(0.24, color);
  base.addColorStop(0.78, color);
  base.addColorStop(0.92, "#1d1a17");
  base.addColorStop(1, "#141210");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 128, 128);
  // Fibrous radial streaks give the iris depth when the cornea catches light.
  for (let i = 0; i < 140; i++) {
    const angle = random() * Math.PI * 2;
    const inner = 15 + random() * 8;
    const outer = 40 + random() * 18;
    ctx.strokeStyle = random() > 0.5 ? "rgba(255,240,215,0.22)" : "rgba(0,0,0,0.28)";
    ctx.lineWidth = 0.6 + random() * 1.2;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(angle) * inner, c + Math.sin(angle) * inner);
    ctx.lineTo(c + Math.cos(angle) * outer, c + Math.sin(angle) * outer);
    ctx.stroke();
  }
  // Collarette ring around the pupil.
  ctx.strokeStyle = "rgba(214,170,98,0.45)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(c, c, 21, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#07080a";
  ctx.beginPath();
  ctx.arc(c, c, 14, 0, Math.PI * 2);
  ctx.fill();
  const texture = new CanvasTexture(element);
  texture.colorSpace = SRGBColorSpace;
  cache.set(key, texture);
  return texture;
}

/**
 * Grayscale strand map: multiplied with the hair color for strand variation and
 * reused as a bump map so sheen breaks along locks instead of across a smooth ball.
 */
export function hairStrandTexture(direction: "vertical" | "curly" = "vertical"): Texture | undefined {
  const key = `hair:${direction}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const made = canvas(128);
  if (!made) return undefined;
  const [element, ctx] = made;
  const random = seeded(direction === "curly" ? 91 : 37);
  ctx.fillStyle = "#c8c8c8";
  ctx.fillRect(0, 0, 128, 128);
  if (direction === "curly") {
    for (let i = 0; i < 220; i++) {
      const shade = 150 + Math.floor(random() * 105);
      ctx.strokeStyle = `rgb(${shade},${shade},${shade})`;
      ctx.lineWidth = 1 + random() * 1.6;
      ctx.beginPath();
      ctx.arc(random() * 128, random() * 128, 2 + random() * 5, random() * 6, random() * 6 + 4);
      ctx.stroke();
    }
  } else {
    for (let x = 0; x < 128; x += 1) {
      const shade = 140 + Math.floor(random() * 115);
      ctx.strokeStyle = `rgb(${shade},${shade},${shade})`;
      ctx.lineWidth = 0.6 + random() * 1.1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + random() * 4 - 2, 42, x + random() * 4 - 2, 86, x + random() * 3 - 1.5, 128);
      ctx.stroke();
    }
  }
  const texture = new CanvasTexture(element);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  cache.set(key, texture);
  return texture;
}

/** Watch dial: hour indices, minute track and hands; smart dials show a lit complication. */
export function watchDialTexture(style: "classic" | "luxury" | "smart"): Texture | undefined {
  const key = `dial:${style}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const made = canvas(128);
  if (!made) return undefined;
  const [element, ctx] = made;
  const c = 64;
  ctx.fillStyle = style === "smart" ? "#05080b" : style === "luxury" ? "#16304a" : "#ece6d6";
  ctx.fillRect(0, 0, 128, 128);
  const ink = style === "classic" ? "#1a1a1a" : "#e8e3d4";
  if (style === "smart") {
    ctx.strokeStyle = "#39d48a";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(c, c, 46, -Math.PI / 2, Math.PI * 0.9);
    ctx.stroke();
    ctx.fillStyle = "#e9f3ff";
    ctx.font = "bold 30px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("9:41", c, c + 10);
  } else {
    for (let i = 0; i < 60; i++) {
      const angle = (i / 60) * Math.PI * 2;
      const major = i % 5 === 0;
      ctx.strokeStyle = ink;
      ctx.lineWidth = major ? 4 : 1;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(angle) * (major ? 44 : 52), c + Math.sin(angle) * (major ? 44 : 52));
      ctx.lineTo(c + Math.cos(angle) * 57, c + Math.sin(angle) * 57);
      ctx.stroke();
    }
    ctx.strokeStyle = ink;
    ctx.lineCap = "round";
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + 22, c - 18); ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c - 8, c - 40); ctx.stroke();
    ctx.strokeStyle = "#c0392b";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(c, c + 10); ctx.lineTo(c + 30, c + 34); ctx.stroke();
  }
  const texture = new CanvasTexture(element);
  texture.colorSpace = SRGBColorSpace;
  cache.set(key, texture);
  return texture;
}

/** Phone lock screen: gradient wallpaper, clock and notification cards. */
export function phoneScreenTexture(): Texture | undefined {
  const hit = cache.get("phone");
  if (hit) return hit;
  if (typeof document === "undefined") return undefined;
  const element = document.createElement("canvas");
  element.width = 64;
  element.height = 128;
  const ctx = element.getContext("2d");
  if (!ctx) return undefined;
  const gradient = ctx.createLinearGradient(0, 0, 64, 128);
  gradient.addColorStop(0, "#2d5f8f");
  gradient.addColorStop(1, "#5b3d82");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 128);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("9:41", 32, 30);
  ctx.fillStyle = "rgba(255,255,255,0.28)";
  for (const y of [48, 68, 88]) ctx.fillRect(6, y, 52, 14);
  const texture = new CanvasTexture(element);
  texture.colorSpace = SRGBColorSpace;
  cache.set("phone", texture);
  return texture;
}
