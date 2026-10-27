import type { ActivityKind } from '@extalia/protocol';
import {
  EXTALIA_CODING_SVG_PATH, EXTALIA_WORDMARK_SVG_PATH, EXTALIA_WORDMARK_WIDTH,
} from '../../../branding/extaliaIdentity';
import { DESIGN_WIDTH, type ScreenStyle, type SurfaceSpec } from './screenContent';

/**
 * Canvas painters for every screen content kind, authored in a 1024-unit-wide design space whose
 * height follows the panel's aspect ratio. Painters never read the clock themselves: `frame` is the
 * paint counter of the shared surface (advances once per repaint, at most 2 Hz) and `now` is the
 * wall clock for clocks. Text is generic placeholder art unless the presence reported it.
 */

export interface PaintContext {
  ctx: CanvasRenderingContext2D;
  /** Design width (always 1024) and height. */
  W: number;
  H: number;
  spec: SurfaceSpec;
  frame: number;
  /** Epoch milliseconds, for clocks only. */
  now: number;
  tr: (text: string) => string;
}

interface Rect { x: number; y: number; w: number; h: number }

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const TEAL = '#59d7ba';
const BLUE = '#82aaff';
const AMBER = '#f0c875';

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

function noise(index: number, seed = 0): number {
  const x = Math.sin(index * 127.1 + seed * 311.7 + 17.3) * 43758.5453;
  return x - Math.floor(x);
}

function setFont(ctx: CanvasRenderingContext2D, weight: number | string, size: number, family = SANS) {
  ctx.font = `${weight} ${Math.max(5, Math.round(size * 10) / 10)}px ${family}`;
}

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | number[], fill?: string | CanvasGradient, stroke?: string, lineWidth = 1) {
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : '';
}

function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, color: string,
  weight: number | string = 500, family = SANS, align: CanvasTextAlign = 'left', maxWidth?: number) {
  setFont(ctx, weight, size, family);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(maxWidth === undefined ? value : fit(ctx, value, maxWidth), x, y);
  ctx.textAlign = 'left';
}

function wrap(ctx: CanvasRenderingContext2D, value: string, maxWidth: number, maxLines: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) line = next;
    else { lines.push(line); line = word; }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = fit(ctx, `${lines[maxLines - 1]}…`, maxWidth);
  return lines.map(entry => fit(ctx, entry, maxWidth));
}

function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, '');
  return clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1) || clean;
}

function clockText(now: number): string {
  const date = new Date(now);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function dateText(now: number, language: string): string {
  try {
    return new Date(now).toLocaleDateString(language === 'id' ? 'id-ID' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

const brandPaths: { word?: Path2D; mark?: Path2D } = {};
const BRAND_MARK_WIDTH = 1.41;
const BRAND_GAP = 0.38;

/** Extalia lockup (coding mark + lowercase wordmark) centred on (cx, cy), `height` tall. */
function drawBrand(ctx: CanvasRenderingContext2D, cx: number, cy: number, height: number, wordColor = '#edf1f5', markOnly = false) {
  if (typeof Path2D === 'undefined') return;
  brandPaths.mark ??= new Path2D(EXTALIA_CODING_SVG_PATH);
  brandPaths.word ??= new Path2D(EXTALIA_WORDMARK_SVG_PATH);
  const width = (BRAND_MARK_WIDTH + (markOnly ? 0 : BRAND_GAP + EXTALIA_WORDMARK_WIDTH)) * height;
  ctx.save();
  ctx.translate(cx - width / 2, cy - height / 2);
  ctx.scale(height, height);
  const gradient = ctx.createLinearGradient(0, 1, 0, 0);
  gradient.addColorStop(0, '#10b9ac');
  gradient.addColorStop(0.55, '#83cb35');
  gradient.addColorStop(1, '#f8e719');
  ctx.fillStyle = gradient;
  ctx.fill(brandPaths.mark);
  if (!markOnly) {
    ctx.translate(BRAND_MARK_WIDTH + BRAND_GAP, 0);
    ctx.fillStyle = wordColor;
    ctx.fill(brandPaths.word);
  }
  ctx.restore();
}

function radial(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, w: number, h: number) {
  const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
  glow.addColorStop(0, color);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
}

// ---------------------------------------------------------------------------------------------
// OS shells
// ---------------------------------------------------------------------------------------------

/** Desktop wallpapers: four palettes, chosen per seat (phase) and shifted per device so a laptop beside a monitor differs. */
const WALLPAPERS: readonly { stops: readonly [string, string, string]; glowA: string; glowB: string }[] = [
  { stops: ['#14506a', '#1d3a74', '#33296b'], glowA: 'rgba(46,196,170,.30)', glowB: 'rgba(132,104,230,.26)' },
  { stops: ['#3a1d4f', '#6b2a5c', '#b5583a'], glowA: 'rgba(255,170,96,.30)', glowB: 'rgba(214,84,160,.26)' },
  { stops: ['#0e3c35', '#155648', '#2f6a3a'], glowA: 'rgba(168,214,114,.28)', glowB: 'rgba(46,196,170,.24)' },
  { stops: ['#0c2546', '#18508c', '#2a86b4'], glowA: 'rgba(127,209,240,.32)', glowB: 'rgba(80,110,230,.26)' },
];
const STYLE_SHIFT: Record<ScreenStyle, number> = { monitor: 0, wall: 0, desktop: 2, laptop: 1 };
export function wallpaperIndex(style: ScreenStyle, phase: number): number {
  return (Math.max(0, Math.floor(phase)) + STYLE_SHIFT[style]) % WALLPAPERS.length;
}

function wallpaper(ctx: CanvasRenderingContext2D, W: number, H: number, style: ScreenStyle, phase = 0) {
  const paper = WALLPAPERS[wallpaperIndex(style, phase)]!;
  const gradient = ctx.createLinearGradient(0, 0, W, H);
  gradient.addColorStop(0, paper.stops[0]); gradient.addColorStop(0.55, paper.stops[1]); gradient.addColorStop(1, paper.stops[2]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);
  radial(ctx, W * 0.8, H * 0.15, W * 0.42, paper.glowA, W, H);
  radial(ctx, W * 0.15, H * 0.9, W * 0.38, paper.glowB, W, H);
}

const APP_COLORS = ['#59d7ba', '#82aaff', '#f0c875', '#c792ea', '#ff8a7a', '#7fd1f0', '#a8d672'];

/** Draws the OS around the app and returns the rectangle the app owns. */
function drawShell(pc: PaintContext): Rect {
  const { ctx, W, H, spec } = pc;
  const style = spec.style;
  if (style === 'monitor' || style === 'wall') return { x: 0, y: 0, w: W, h: H };
  const u = H / 576;
  if (style === 'desktop') {
    const bar = 40 * u;
    wallpaper(ctx, W, H, style, spec.phase);
    ctx.fillStyle = '#0b141c';
    ctx.fillRect(0, H - bar, W, bar);
    // Start glyph, pinned apps, tray and clock: a desktop taskbar, not a laptop dock.
    const cy = H - bar / 2;
    for (let i = 0; i < 4; i++) { rrect(ctx, 16 * u + (i % 2) * 11 * u, cy - 11 * u + Math.floor(i / 2) * 11 * u, 9 * u, 9 * u, 1.5 * u, '#7fd1f0'); }
    for (let i = 0; i < 6; i++) {
      rrect(ctx, 56 * u + i * 38 * u, cy - 12 * u, 24 * u, 24 * u, 6 * u, APP_COLORS[i]!);
      if (i < 2) rrect(ctx, 62 * u + i * 38 * u, cy + 13 * u, 12 * u, 2.5 * u, 1 * u, '#dfeaee');
    }
    for (let i = 0; i < 3; i++) { ctx.fillStyle = '#7e9aa4'; ctx.beginPath(); ctx.arc(W - 150 * u + i * 20 * u, cy, 5 * u, 0, Math.PI * 2); ctx.fill(); }
    text(ctx, clockText(pc.now), W - 18 * u, cy + 6 * u, 17 * u, '#dfeaee', 600, SANS, 'right');
    return { x: 0, y: 0, w: W, h: H - bar };
  }
  // laptop: menu bar, floating window, dock
  const menu = 26 * u, dock = 70 * u;
  wallpaper(ctx, W, H, style, spec.phase);
  ctx.fillStyle = 'rgba(8,16,24,.55)';
  ctx.fillRect(0, 0, W, menu);
  ctx.fillStyle = '#e8f0f2';
  ctx.beginPath(); ctx.arc(24 * u, menu / 2, 6 * u, 0, Math.PI * 2); ctx.fill();
  [44, 36, 46, 40].reduce((x, width) => { rrect(ctx, x, menu / 2 - 3 * u, width * u, 6 * u, 3 * u, 'rgba(232,240,242,.7)'); return x + (width + 18) * u; }, 56 * u);
  text(ctx, clockText(pc.now), W - 20 * u, menu / 2 + 6 * u, 15 * u, '#e8f0f2', 600, SANS, 'right');
  rrect(ctx, W - 92 * u, menu / 2 - 5 * u, 22 * u, 10 * u, 2.5 * u, undefined, 'rgba(232,240,242,.8)', 1.5 * u);
  const wx = W * 0.035, wy = menu + 12 * u, ww = W - wx * 2, wh = H - wy - dock - 8 * u;
  rrect(ctx, wx - 2 * u, wy - 1 * u, ww + 4 * u, wh + 5 * u, 13 * u, 'rgba(0,0,0,.35)');
  rrect(ctx, wx, wy, ww, wh, 11 * u, '#1b2830');
  [['#ff5f57', 0], ['#febc2e', 1], ['#28c840', 2]].forEach(([color, i]) => {
    ctx.fillStyle = color as string; ctx.beginPath(); ctx.arc(wx + (16 + (i as number) * 18) * u, wy + 15 * u, 5.5 * u, 0, Math.PI * 2); ctx.fill();
  });
  rrect(ctx, wx + ww / 2 - 60 * u, wy + 11 * u, 120 * u, 8 * u, 4 * u, 'rgba(160,185,194,.35)');
  const dw = W * 0.58, dy = H - dock + 9 * u;
  rrect(ctx, (W - dw) / 2, dy, dw, 52 * u, 18 * u, 'rgba(255,255,255,.16)', 'rgba(255,255,255,.22)', 1 * u);
  for (let i = 0; i < 7; i++) {
    const x = (W - dw) / 2 + dw * (0.075 + i * 0.141);
    rrect(ctx, x - 19 * u, dy + 7 * u, 38 * u, 38 * u, 9 * u, APP_COLORS[i]!);
    if (i === 0 || i === 3) { ctx.fillStyle = '#eef6f6'; ctx.beginPath(); ctx.arc(x, dy + 49 * u, 2 * u, 0, Math.PI * 2); ctx.fill(); }
  }
  return { x: wx, y: wy + 30 * u, w: ww, h: wh - 30 * u };
}

/** Runs `draw` with the context moved and clipped to `rect` (bottom corners rounded in a window). */
function inRect(pc: PaintContext, rect: Rect, draw: (w: number, h: number) => void) {
  const { ctx, spec, H } = pc;
  ctx.save();
  ctx.translate(rect.x, rect.y);
  ctx.beginPath();
  const round = spec.style === 'laptop' ? 10 * (H / 576) : 0;
  ctx.roundRect(0, 0, rect.w, rect.h, [0, 0, round, round]);
  ctx.clip();
  draw(rect.w, rect.h);
  ctx.restore();
}

const fontScale = (style: ScreenStyle) => (style === 'laptop' ? 0.84 : style === 'wall' ? 1.1 : 1);

// ---------------------------------------------------------------------------------------------
// Workstation apps
// ---------------------------------------------------------------------------------------------

type Token = [string, string];
const C = { plain: '#d6e4e6', key: '#c792ea', fn: '#82aaff', str: '#c3e88d', num: '#f78c6c', com: '#5f7e86', type: '#ffcb6b' };
/** Generic placeholder source: it describes no real project. */
const CODE: Token[][] = [
  [['import', C.key], [' { createModule } ', C.plain], ['from', C.key], [' "./module";', C.str]],
  [['', C.plain]],
  [['export function', C.key], [' handleRequest', C.fn], ['(input) {', C.plain]],
  [['  const', C.key], [' state = ', C.plain], ['createModule', C.fn], ['(input);', C.plain]],
  [['  if', C.key], [' (!state.ready) {', C.plain]],
  [['    return', C.key], [' fallback(state);', C.plain]],
  [['  }', C.plain]],
  [['  // placeholder', C.com]],
  [['  for', C.key], [' (', C.plain], ['const', C.key], [' item ', C.plain], ['of', C.key], [' state.items) {', C.plain]],
  [['    process', C.fn], ['(item, ', C.plain], ['0', C.num], [');', C.plain]],
  [['  }', C.plain]],
  [['  return', C.key], [' summarize', C.fn], ['(state);', C.plain]],
  [['}', C.plain]],
  [['', C.plain]],
  [['export class', C.key], [' Service', C.type], [' {', C.plain]],
  [['  run', C.fn], ['(job) {', C.plain]],
  [['    const', C.key], [' result = ', C.plain], ['this', C.key], ['.queue.', C.plain], ['push', C.fn], ['(job);', C.plain]],
  [['    return', C.key], [' result;', C.plain]],
  [['  }', C.plain]],
  [['}', C.plain]],
];

function statusLabel(pc: PaintContext, detail: string): string {
  const { tr } = pc;
  switch (detail) {
    case 'edit': return tr('EDITING');
    case 'think': return tr('THINKING');
    case 'blocked': return tr('BLOCKED');
    default: return '';
  }
}

function drawEditor(pc: PaintContext, w: number, h: number) {
  const { ctx, spec, frame } = pc;
  const style = spec.style;
  const u = Math.min(w / 1024, h / 576) * fontScale(style);
  const hot = spec.hot;
  const detail = spec.detail;
  ctx.fillStyle = '#16252d';
  ctx.fillRect(0, 0, w, h);

  // Tab strip: the reported file when there is one, a neutral bar otherwise.
  const tabH = 34 * u;
  ctx.fillStyle = '#0f1b21';
  ctx.fillRect(0, 0, w, tabH);
  const sideW = style === 'monitor' ? 0 : 158 * u;
  const tabW = 210 * u;
  ctx.fillStyle = '#1f333c';
  ctx.fillRect(sideW + 8 * u, 5 * u, tabW, tabH - 5 * u);
  ctx.fillStyle = TEAL;
  ctx.fillRect(sideW + 8 * u, 5 * u, tabW, 2 * u);
  if (spec.target && (detail === 'edit' || detail === 'think' || detail === 'blocked')) {
    text(ctx, basename(spec.target), sideW + 20 * u, 26 * u, 15 * u, '#d9e8ea', 600, MONO, 'left', tabW - 40 * u);
  } else {
    rrect(ctx, sideW + 22 * u, 15 * u, 110 * u, 8 * u, 4 * u, '#5f7e86');
  }
  if (detail === 'edit') { ctx.fillStyle = AMBER; ctx.beginPath(); ctx.arc(sideW + tabW - 4 * u, 20 * u, 4 * u, 0, Math.PI * 2); ctx.fill(); }
  rrect(ctx, sideW + tabW + 24 * u, 15 * u, 90 * u, 8 * u, 4 * u, '#2c444e');

  // Explorer (laptop / desktop IDE layout) or minimap (full-screen monitor).
  if (sideW > 0) {
    ctx.fillStyle = '#101d24';
    ctx.fillRect(0, tabH, sideW, h - tabH);
    rrect(ctx, 14 * u, tabH + 14 * u, 70 * u, 7 * u, 3.5 * u, '#5f7e86');
    for (let i = 0; i < 11; i++) {
      const indent = i % 4 === 0 ? 0 : 14 * u;
      const y = tabH + 40 * u + i * 24 * u;
      if (y > h - 30 * u) break;
      if (i === 5) { ctx.fillStyle = '#1f333c'; ctx.fillRect(0, y - 8 * u, sideW, 22 * u); }
      rrect(ctx, 14 * u + indent, y - 2 * u, 11 * u, 11 * u, 3 * u, indent ? '#6f8f99' : AMBER);
      rrect(ctx, 32 * u + indent, y, (40 + noise(i, spec.phase) * 62) * u, 7 * u, 3.5 * u, i === 5 ? '#d9e8ea' : '#5f7e86');
    }
  }
  const minimapW = style === 'monitor' ? 84 * u : 0;
  const codeX = sideW;
  const gutterW = 52 * u;
  const fontSize = 17 * u;
  const lineH = fontSize * 1.62;
  const statusH = 26 * u;
  const bodyTop = tabH + 8 * u;
  const rows = Math.max(3, Math.floor((h - bodyTop - statusH - 6 * u) / lineH));
  const scroll = spec.phase * 3;

  // The changing line: moves one line per repaint while the agent edits or browses.
  const tick = frame;
  const cur = detail === 'edit' ? (tick + spec.phase * 5) % rows
    : detail === 'think' || detail === 'blocked' ? Math.min(rows - 1, Math.floor(rows * 0.42) + ((tick + spec.phase) % 3))
      : (tick + 3 + spec.phase * 2) % rows;
  const modified = new Set<number>();
  if (detail === 'edit') for (let k = 1; k <= 4; k++) modified.add((cur - k + rows) % rows);

  setFont(ctx, 500, fontSize, MONO);
  for (let row = 0; row < rows; row++) {
    const y = bodyTop + row * lineH + fontSize;
    if (row === cur) {
      ctx.fillStyle = detail === 'edit' ? 'rgba(89,215,186,.20)' : 'rgba(130,170,255,.12)';
      ctx.fillRect(codeX, y - fontSize * 1.1, w - codeX - minimapW, lineH);
      if (detail === 'edit') { ctx.fillStyle = TEAL; ctx.fillRect(codeX + gutterW - 4 * u, y - fontSize * 1.1, 3 * u, lineH); }
    } else if (modified.has(row)) {
      ctx.fillStyle = 'rgba(240,200,117,.7)';
      ctx.fillRect(codeX + gutterW - 4 * u, y - fontSize * 1.1, 3 * u, lineH);
    }
    text(ctx, String(row + 1 + scroll), codeX + gutterW - 12 * u, y, fontSize * 0.92, row === cur ? '#b8d0d4' : '#3f5a63', 500, MONO, 'right');
    const tokens = CODE[(row + scroll) % CODE.length]!;
    let x = codeX + gutterW + 8 * u;
    setFont(ctx, 500, fontSize, MONO);
    for (const [part, color] of tokens) {
      if (!part) continue;
      ctx.fillStyle = color;
      ctx.fillText(part, x, y);
      x += ctx.measureText(part).width;
    }
    // Caret: typing at the end of the changing line, or blinking where the agent is thinking/ambient.
    if (row === cur && (detail === 'edit' || frame % 2 === 0)) {
      ctx.fillStyle = '#e9f2f3';
      ctx.fillRect(x + 2 * u, y - fontSize * 0.95, 2.5 * u, fontSize * 1.2);
    }
  }
  if (minimapW > 0) {
    const mx = w - minimapW;
    ctx.fillStyle = '#12212a';
    ctx.fillRect(mx, tabH, minimapW, h - tabH - statusH);
    for (let row = 0; row < rows * 2; row++) {
      const tokens = CODE[(Math.floor(row / 2) + scroll) % CODE.length]!;
      const len = tokens.reduce((sum, [part]) => sum + part.length, 0);
      rrect(ctx, mx + 10 * u, tabH + 10 * u + row * 8 * u, Math.min(64 * u, len * 1.9 * u), 4 * u, 2 * u, tokens[0]![1] === C.plain ? 'rgba(214,228,230,.28)' : 'rgba(199,146,234,.4)');
    }
    ctx.fillStyle = 'rgba(130,170,255,.12)';
    ctx.fillRect(mx, tabH + 4 * u + (cur * 16 * u) % (h * 0.5), minimapW, 54 * u);
  }

  // Status bar: mode and target only when real; position follows the changing line.
  const bar = detail === 'edit' ? '#0f5f55' : detail === 'blocked' ? '#8a5a14' : hot ? '#27456f' : '#1f3944';
  ctx.fillStyle = bar;
  ctx.fillRect(0, h - statusH, w, statusH);
  const label = statusLabel(pc, detail);
  if (label) text(ctx, label, 14 * u, h - 8 * u, 14 * u, '#eaf6f4', 700, SANS);
  if (spec.target && label) text(ctx, spec.target, 14 * u + 110 * u, h - 8 * u, 13 * u, '#c5dcda', 500, MONO, 'left', w * 0.5);
  text(ctx, `Ln ${cur + 1 + scroll}, Col ${4 + ((frame * 3 + spec.phase * 7) % 28)}`, w - 14 * u, h - 8 * u, 13 * u, '#c5dcda', 500, MONO, 'right');
}

function drawTerminal(pc: PaintContext, w: number, h: number) {
  const { ctx, spec, frame } = pc;
  const u = Math.min(w / 1024, h / 576) * fontScale(spec.style);
  const hot = spec.hot;
  ctx.fillStyle = '#080d10';
  ctx.fillRect(0, 0, w, h);
  const titleH = 32 * u;
  ctx.fillStyle = '#121a1f';
  ctx.fillRect(0, 0, w, titleH);
  if (spec.style !== 'laptop') {
    ['#ff5f57', '#febc2e', '#28c840'].forEach((color, i) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc((18 + i * 18) * u, titleH / 2, 5 * u, 0, Math.PI * 2); ctx.fill(); });
  }
  rrect(ctx, w / 2 - 55 * u, titleH / 2 - 4 * u, 110 * u, 8 * u, 4 * u, '#2c444e');

  const fontSize = 18 * u;
  const lineH = fontSize * 1.55;
  const top = titleH + 12 * u;
  const rows = Math.max(3, Math.floor((h - top - lineH * 2.2) / lineH));
  // Output lines are neutral bars: they stream up one line per repaint.
  const base = frame;
  for (let row = 0; row < rows; row++) {
    const seed = row + base + spec.phase * 11;
    const indent = noise(seed, 1) > 0.7 ? 28 * u : 0;
    const width = (80 + noise(seed, 2) * (w * 0.62)) * (noise(seed, 3) > 0.9 ? 0.35 : 1);
    const y = top + row * lineH;
    rrect(ctx, 20 * u + indent, y + fontSize * 0.35, Math.min(width, w - 60 * u), fontSize * 0.42, fontSize * 0.2, row === rows - 1 ? '#4f8f84' : '#2b3d44');
  }
  // Prompt with the real command when the agent reported one.
  const py = top + rows * lineH + fontSize * 0.9;
  text(ctx, '$', 20 * u, py, fontSize, TEAL, 700, MONO);
  if (spec.target && spec.detail === 'command') {
    text(ctx, spec.target, 20 * u + 22 * u, py, fontSize, '#e4eeee', 500, MONO, 'left', w - 120 * u);
  } else {
    rrect(ctx, 20 * u + 24 * u, py - fontSize * 0.7, 90 * u, fontSize * 0.45, fontSize * 0.2, '#3a5058');
  }
  if (hot) {
    const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
    text(ctx, frames[frame % frames.length]!, w - 24 * u, py, fontSize, TEAL, 700, MONO, 'right');
  } else if (frame % 2 === 0) {
    ctx.fillStyle = '#b8d0d4';
    ctx.fillRect(w * 0.18, py - fontSize * 0.85, 10 * u, fontSize * 1.05);
  }
}

function drawTests(pc: PaintContext, w: number, h: number) {
  const { ctx, spec, frame, tr } = pc;
  const u = Math.min(w / 1024, h / 576) * fontScale(spec.style);
  ctx.fillStyle = '#0b1217';
  ctx.fillRect(0, 0, w, h);
  const headH = 58 * u;
  ctx.fillStyle = '#111c23';
  ctx.fillRect(0, 0, w, headH);
  // Beaker glyph, title, and the real command when reported.
  ctx.strokeStyle = TEAL; ctx.lineWidth = 3 * u;
  ctx.beginPath(); ctx.moveTo(26 * u, 14 * u); ctx.lineTo(26 * u, 28 * u); ctx.lineTo(16 * u, 46 * u); ctx.lineTo(44 * u, 46 * u); ctx.lineTo(34 * u, 28 * u); ctx.lineTo(34 * u, 14 * u); ctx.stroke();
  text(ctx, tr('TEST RUN'), 62 * u, 28 * u, 19 * u, '#e9f2f1', 700);
  if (spec.target) text(ctx, spec.target, 62 * u, 49 * u, 14 * u, '#7f9ca3', 500, MONO, 'left', w * 0.7);
  // Indeterminate progress: the run has no known total, so a segment sweeps.
  const barY = headH + 14 * u, barW = w - 56 * u;
  rrect(ctx, 28 * u, barY, barW, 8 * u, 4 * u, '#1b2b33');
  const sweep = (frame * 0.13 + spec.phase * 0.2) % 1;
  rrect(ctx, 28 * u + sweep * barW * 0.8, barY, barW * 0.2, 8 * u, 4 * u, TEAL);

  const rowH = 40 * u;
  const top = barY + 34 * u;
  const rows = Math.max(3, Math.floor((h - top - 16 * u) / rowH));
  const running = frame % rows;
  for (let row = 0; row < rows; row++) {
    const y = top + row * rowH;
    if (row === running) { ctx.fillStyle = 'rgba(89,215,186,.10)'; ctx.fillRect(14 * u, y - 4 * u, w - 28 * u, rowH - 4 * u); }
    const cx = 38 * u, cy = y + rowH / 2 - 6 * u;
    ctx.lineWidth = 2.6 * u;
    if (row === running) {
      ctx.strokeStyle = TEAL;
      ctx.beginPath(); ctx.arc(cx, cy, 8 * u, frame * 1.1, frame * 1.1 + Math.PI * 1.4); ctx.stroke();
    } else {
      ctx.strokeStyle = '#3d5660';
      ctx.beginPath(); ctx.arc(cx, cy, 8 * u, 0, Math.PI * 2); ctx.stroke();
    }
    rrect(ctx, 64 * u, cy - 4 * u, (160 + noise(row, spec.phase) * 300) * u, 8 * u, 4 * u, row === running ? '#c9dcdc' : '#34505a');
    rrect(ctx, w - 130 * u, cy - 4 * u, 80 * u, 8 * u, 4 * u, '#22343c');
  }
}

function drawDocs(pc: PaintContext, w: number, h: number) {
  const { ctx, spec, frame, tr } = pc;
  const wall = spec.style === 'wall';
  const u = Math.min(w / 1024, h / 576) * fontScale(spec.style);
  const detail = spec.detail;
  ctx.fillStyle = '#f5f8f9';
  ctx.fillRect(0, 0, w, h);
  let y: number;
  if (wall) {
    ctx.fillStyle = '#1d2a30'; ctx.fillRect(0, 0, w, 54 * u);
    text(ctx, (spec.title ?? tr('KNOWLEDGE')).toUpperCase(), 28 * u, 36 * u, 22 * u, '#f1f6f5', 700, SANS, 'left', w * 0.6);
    if (spec.subtitle) text(ctx, spec.subtitle, w - 28 * u, 35 * u, 16 * u, '#9fb4ba', 500, SANS, 'right', w * 0.3);
    ctx.fillStyle = '#c9a35f'; ctx.fillRect(0, 54 * u, w, 3 * u);
    y = 58 * u;
  } else {
    // Browser chrome: tab strip, address row.
    ctx.fillStyle = '#d9e0e3'; ctx.fillRect(0, 0, w, 30 * u);
    rrect(ctx, 10 * u, 5 * u, 190 * u, 26 * u, [8 * u, 8 * u, 0, 0], '#f5f8f9');
    rrect(ctx, 24 * u, 15 * u, 100 * u, 7 * u, 3.5 * u, '#8fa3ab');
    rrect(ctx, 212 * u, 9 * u, 150 * u, 16 * u, 8 * u, '#cdd7db');
    ctx.fillStyle = '#eef2f4'; ctx.fillRect(0, 30 * u, w, 40 * u);
    [0, 1, 2].forEach(i => { ctx.fillStyle = '#9db0b8'; ctx.beginPath(); ctx.arc((24 + i * 30) * u, 50 * u, 8 * u, 0, Math.PI * 2); ctx.fill(); });
    rrect(ctx, 110 * u, 36 * u, w - 140 * u, 28 * u, 14 * u, '#ffffff', '#cdd8dc', 1.2 * u);
    ctx.fillStyle = '#4f8f84'; ctx.beginPath(); ctx.arc(130 * u, 50 * u, 5 * u, 0, Math.PI * 2); ctx.fill();
    // The address is the reported target (URL, query or path); otherwise a neutral bar.
    if (spec.target && detail !== 'ambient') text(ctx, spec.target, 148 * u, 56 * u, 15 * u, '#33474f', 500, SANS, 'left', w - 200 * u);
    else rrect(ctx, 148 * u, 46 * u, 170 * u, 8 * u, 4 * u, '#b9c7cc');
    y = 70 * u;
    if (detail === 'web') {
      const progress = (frame * 0.17 + spec.phase * 0.2) % 1;
      ctx.fillStyle = '#e0e8eb'; ctx.fillRect(0, y, w, 3 * u);
      ctx.fillStyle = '#2f80ed'; ctx.fillRect(0, y, w * progress, 3 * u);
    }
  }
  const bodyY = y + 18 * u;
  const bodyH = h - bodyY;
  const margin = Math.max(26 * u, w * 0.05);

  if (detail === 'search') {
    rrect(ctx, margin, bodyY, Math.min(w - margin * 2, 620 * u), 40 * u, 20 * u, '#ffffff', '#c6d3d8', 1.4 * u);
    ctx.strokeStyle = '#4f8f84'; ctx.lineWidth = 3 * u;
    ctx.beginPath(); ctx.arc(margin + 24 * u, bodyY + 19 * u, 8 * u, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(margin + 30 * u, bodyY + 25 * u); ctx.lineTo(margin + 38 * u, bodyY + 33 * u); ctx.stroke();
    if (spec.target) text(ctx, spec.target, margin + 54 * u, bodyY + 27 * u, 17 * u, '#26363d', 500, SANS, 'left', 520 * u);
    else rrect(ctx, margin + 54 * u, bodyY + 16 * u, 150 * u, 8 * u, 4 * u, '#b9c7cc');
    const rowH = 86 * u;
    const list = Math.max(2, Math.floor((bodyH - 70 * u) / rowH));
    const active = frame % list;
    for (let i = 0; i < list; i++) {
      const ry = bodyY + 62 * u + i * rowH;
      if (i === active) { ctx.fillStyle = '#e3f0ff'; ctx.fillRect(margin - 12 * u, ry - 8 * u, w - margin * 2 + 24 * u, rowH - 4 * u); ctx.fillStyle = '#2f80ed'; ctx.fillRect(margin - 12 * u, ry - 8 * u, 4 * u, rowH - 4 * u); }
      rrect(ctx, margin, ry, (220 + noise(i, spec.phase) * 260) * u, 12 * u, 6 * u, '#1a5fb4');
      rrect(ctx, margin, ry + 22 * u, 160 * u, 7 * u, 3.5 * u, '#5e8f6e');
      rrect(ctx, margin, ry + 40 * u, (w - margin * 2) * 0.82, 7 * u, 3.5 * u, '#aebcc2');
      rrect(ctx, margin, ry + 54 * u, (w - margin * 2) * (0.5 + noise(i, 4) * 0.3), 7 * u, 3.5 * u, '#aebcc2');
    }
  } else if (detail === 'web') {
    const heroH = Math.min(bodyH * 0.38, 190 * u);
    const hero = ctx.createLinearGradient(margin, bodyY, w - margin, bodyY + heroH);
    hero.addColorStop(0, '#bfe3dc'); hero.addColorStop(1, '#c9d3f3');
    rrect(ctx, margin, bodyY, w - margin * 2, heroH, 14 * u, hero);
    rrect(ctx, margin + 28 * u, bodyY + 34 * u, (w - margin * 2) * 0.42, 18 * u, 9 * u, '#1d2a30');
    rrect(ctx, margin + 28 * u, bodyY + 66 * u, (w - margin * 2) * 0.3, 9 * u, 4.5 * u, '#5d7078');
    rrect(ctx, margin + 28 * u, bodyY + 96 * u, 110 * u, 30 * u, 15 * u, '#2f80ed');
    const cardW = (w - margin * 2 - 36 * u) / 3;
    for (let i = 0; i < 3; i++) {
      const cx = margin + i * (cardW + 18 * u), cy = bodyY + heroH + 22 * u;
      rrect(ctx, cx, cy, cardW, Math.max(30 * u, bodyH - heroH - 44 * u), 12 * u, '#ffffff', i === frame % 3 ? '#2f80ed' : '#dde5e8', i === frame % 3 ? 2 * u : 1.2 * u);
      rrect(ctx, cx + 14 * u, cy + 14 * u, cardW - 28 * u, Math.max(14 * u, (bodyH - heroH) * 0.28), 8 * u, ['#d7ece6', '#e2e6f6', '#f2e8d2'][i]!);
      rrect(ctx, cx + 14 * u, cy + 24 * u + (bodyH - heroH) * 0.28, cardW * 0.6, 8 * u, 4 * u, '#9db0b8');
    }
  } else {
    // Article: title, paragraphs, a code block and a side outline. A highlight walks the paragraphs.
    const columnW = (w - margin * 2) * 0.68;
    rrect(ctx, margin, bodyY, columnW * 0.7, 22 * u, 11 * u, '#1d2a30');
    rrect(ctx, margin, bodyY + 34 * u, columnW * 0.45, 9 * u, 4.5 * u, '#8fa3ab');
    const para = 3;
    const marked = (frame + spec.phase) % 4;
    for (let p = 0; p < 4; p++) {
      const py = bodyY + 66 * u + p * (para * 20 * u + 30 * u);
      if (py > h - 30 * u) break;
      if (p === marked) { ctx.fillStyle = 'rgba(255,224,102,.45)'; ctx.fillRect(margin - 10 * u, py - 8 * u, columnW + 20 * u, para * 20 * u + 6 * u); }
      for (let l = 0; l < para; l++) rrect(ctx, margin, py + l * 20 * u, columnW * (l === para - 1 ? 0.6 : 1), 8 * u, 4 * u, '#a5b5bb');
      if (p === 1) {
        const bh = 62 * u;
        rrect(ctx, margin, py + para * 20 * u + 4 * u, columnW, bh, 8 * u, '#1c2b33');
        ['#c792ea', '#82aaff', '#c3e88d'].forEach((color, i) => rrect(ctx, margin + 16 * u, py + para * 20 * u + 16 * u + i * 16 * u, (80 + i * 70) * u, 6 * u, 3 * u, color));
      }
    }
    const sx = margin + columnW + 36 * u;
    rrect(ctx, sx, bodyY, w - sx - margin, h - bodyY - 24 * u, 12 * u, '#eaf0f2');
    for (let i = 0; i < 7; i++) rrect(ctx, sx + 18 * u, bodyY + 22 * u + i * 26 * u, Math.min((60 + noise(i, 9) * 80) * u, w - sx - margin - 36 * u), 7 * u, 3.5 * u, i === (frame + spec.phase) % 7 ? '#2f80ed' : '#9db0b8');
  }
}

function drawDashboard(pc: PaintContext, w: number, h: number) {
  const { ctx, spec, frame, tr } = pc;
  const u = Math.min(w / 1024, h / 576) * fontScale(spec.style);
  ctx.fillStyle = '#0a141a';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#101d24';
  ctx.fillRect(0, 0, w, 44 * u);
  rrect(ctx, 24 * u, 17 * u, 130 * u, 10 * u, 5 * u, '#5f7e86');
  const pulse = frame;
  if (spec.detail === 'delegate') {
    text(ctx, tr('DELEGATING'), w - 24 * u, 30 * u, 16 * u, AMBER, 700, SANS, 'right');
    // Agent tree: a root fans out; packets travel to the workers.
    const root = { x: w * 0.5, y: 90 * u };
    const leaves = [0.2, 0.4, 0.6, 0.8].map(fx => ({ x: w * fx, y: h * 0.62 }));
    leaves.forEach((leaf, i) => {
      ctx.strokeStyle = '#2f4a54'; ctx.lineWidth = 3 * u;
      ctx.beginPath(); ctx.moveTo(root.x, root.y + 24 * u); ctx.lineTo(leaf.x, leaf.y - 22 * u); ctx.stroke();
      const t = ((pulse * 0.27) + i * 0.25) % 1;
      ctx.fillStyle = TEAL; ctx.beginPath(); ctx.arc(root.x + (leaf.x - root.x) * t, root.y + 24 * u + (leaf.y - 22 * u - root.y - 24 * u) * t, 6 * u, 0, Math.PI * 2); ctx.fill();
      rrect(ctx, leaf.x - 44 * u, leaf.y - 22 * u, 88 * u, 44 * u, 10 * u, '#16303a', '#3f6670', 1.5 * u);
      rrect(ctx, leaf.x - 26 * u, leaf.y - 4 * u, 52 * u, 8 * u, 4 * u, '#6f8f99');
    });
    rrect(ctx, root.x - 60 * u, root.y - 24 * u, 120 * u, 48 * u, 12 * u, '#1b4a44', TEAL, 2 * u);
    rrect(ctx, root.x - 30 * u, root.y - 4 * u, 60 * u, 8 * u, 4 * u, '#9fe3d3');
    return;
  }
  // Tiles with sparklines and bars; no figures, since none were reported.
  const tileW = (w - 24 * u * 2 - 16 * u * 2) / 3;
  for (let i = 0; i < 3; i++) {
    const x = 24 * u + i * (tileW + 16 * u);
    rrect(ctx, x, 62 * u, tileW, 92 * u, 12 * u, '#122229');
    rrect(ctx, x + 16 * u, 80 * u, 64 * u, 7 * u, 3.5 * u, '#5f7e86');
    rrect(ctx, x + 16 * u, 100 * u, tileW * 0.42, 22 * u, 8 * u, [TEAL, AMBER, BLUE][i]!);
    ctx.strokeStyle = [TEAL, AMBER, BLUE][i]!; ctx.lineWidth = 2.5 * u; ctx.beginPath();
    for (let p = 0; p <= 16; p++) {
      const px = x + tileW * 0.52 + (tileW * 0.4) * p / 16;
      const py = 130 * u - noise(p + pulse, i + spec.phase) * 34 * u;
      if (p === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  const chartTop = 174 * u, chartH = h - chartTop - 24 * u, chartW = w * 0.6;
  rrect(ctx, 24 * u, chartTop, chartW, chartH, 12 * u, '#101d24');
  ctx.beginPath();
  ctx.moveTo(24 * u, chartTop + chartH);
  for (let p = 0; p <= 40; p++) {
    const t = p * 0.2 + frame * 0.3 + spec.phase;
    ctx.lineTo(24 * u + chartW * p / 40, chartTop + chartH * (1 - (0.5 + Math.sin(t) * 0.18 + Math.sin(t * 0.37) * 0.14)));
  }
  ctx.lineTo(24 * u + chartW, chartTop + chartH);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, chartTop, 0, chartTop + chartH);
  fill.addColorStop(0, 'rgba(89,215,186,.5)'); fill.addColorStop(1, 'rgba(89,215,186,0)');
  ctx.fillStyle = fill; ctx.fill();
  const cx = 24 * u + chartW + (w - chartW - 48 * u) / 2, cy = chartTop + chartH / 2, r = Math.min(chartH, w - chartW - 48 * u) * 0.34;
  ctx.lineWidth = r * 0.28; ctx.strokeStyle = '#1c2f38';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = BLUE;
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (0.55 + Math.sin(frame * 0.4) * 0.08)); ctx.stroke();
}

function drawApproval(pc: PaintContext, w: number, h: number) {
  const { ctx, spec, frame, tr } = pc;
  const u = Math.min(w / 1024, h / 576) * fontScale(spec.style);
  // The work stays visible behind the dialog, dimmed.
  drawEditor({ ...pc, spec: { ...spec, hot: false, detail: 'ambient' } }, w, h);
  ctx.fillStyle = 'rgba(4,9,12,.62)';
  ctx.fillRect(0, 0, w, h);
  const dw = Math.min(w * 0.62, 560 * u), dh = Math.min(h * 0.62, 250 * u);
  const dx = (w - dw) / 2, dy = (h - dh) / 2;
  rrect(ctx, dx, dy, dw, dh, 14 * u, '#eef3f4', '#ffffff', 1.5 * u);
  ctx.fillStyle = '#f2b544';
  ctx.beginPath(); ctx.arc(dx + 38 * u, dy + 38 * u, 17 * u, 0, Math.PI * 2); ctx.fill();
  text(ctx, '!', dx + 38 * u, dy + 46 * u, 24 * u, '#4a3000', 800, SANS, 'center');
  text(ctx, tr('Approval requested'), dx + 68 * u, dy + 46 * u, 21 * u, '#1b2a30', 700, SANS, 'left', dw - 90 * u);
  setFont(ctx, 500, 16 * u, SANS);
  const detailText = spec.target;
  if (detailText) {
    wrap(ctx, detailText, dw - 56 * u, 3).forEach((line, i) => text(ctx, line, dx + 28 * u, dy + 88 * u + i * 24 * u, 16 * u, '#46606a', 500, SANS));
  } else {
    [0.9, 0.7].forEach((fraction, i) => rrect(ctx, dx + 28 * u, dy + 82 * u + i * 22 * u, (dw - 56 * u) * fraction, 8 * u, 4 * u, '#b7c6cb'));
  }
  const by = dy + dh - 56 * u;
  rrect(ctx, dx + dw - 270 * u, by, 112 * u, 38 * u, 10 * u, undefined, '#9db0b8', 1.6 * u);
  text(ctx, tr('Deny'), dx + dw - 214 * u, by + 25 * u, 16 * u, '#46606a', 600, SANS, 'center');
  const glow = frame % 2 === 0;
  if (glow) rrect(ctx, dx + dw - 150 * u, by - 3 * u, 126 * u, 44 * u, 13 * u, 'rgba(47,128,237,.35)');
  rrect(ctx, dx + dw - 146 * u, by, 118 * u, 38 * u, 10 * u, '#2f80ed');
  text(ctx, tr('Allow'), dx + dw - 87 * u, by + 25 * u, 16 * u, '#ffffff', 700, SANS, 'center');
}

// ---------------------------------------------------------------------------------------------
// Full-bleed screens
// ---------------------------------------------------------------------------------------------

function drawLock(pc: PaintContext) {
  if (pc.spec.detail === 'screensaver') { drawScreensaver(pc); return; }
  if (pc.spec.detail === 'clock') { drawClockSaver(pc); return; }
  const { ctx, W, H, spec, frame, now, tr } = pc;
  const u = Math.min(W / 1024, H / 576);
  const t = frame * 0.55 + spec.phase * 1.4;
  wallpaper(ctx, W, H, spec.style, spec.phase);
  radial(ctx, W * (0.5 + Math.sin(t * 0.7) * 0.22), H * (0.48 + Math.cos(t * 0.5) * 0.16), W * 0.44, 'rgba(89,215,186,.32)', W, H);
  ctx.lineWidth = 42 * u;
  for (const [index, offset] of [-120, 0, 120].entries()) {
    const wave = Math.sin(t + index * 1.2) * 58 * u;
    ctx.strokeStyle = index === 1 ? 'rgba(89,215,186,.22)' : 'rgba(255,255,255,.11)';
    ctx.beginPath();
    ctx.moveTo(-60, (460 + offset) * u + wave);
    ctx.bezierCurveTo(300 * u, (250 + offset) * u - wave, 640 * u, (520 + offset) * u + wave, W + 80, (190 + offset) * u - wave * 0.7);
    ctx.stroke();
  }
  if (spec.style === 'laptop') {
    ctx.fillStyle = 'rgba(8,16,24,.45)';
    ctx.fillRect(0, 0, W, 26 * u);
    rrect(ctx, W - 92 * u, 8 * u, 22 * u, 10 * u, 2.5 * u, undefined, 'rgba(232,240,242,.8)', 1.5 * u);
  }
  text(ctx, clockText(now), W / 2, H * 0.25, 92 * u, 'rgba(255,255,255,.96)', 300, SANS, 'center');
  text(ctx, dateText(now, spec.language), W / 2, H * 0.25 + 36 * u, 22 * u, 'rgba(225,238,240,.84)', 500, SANS, 'center');
  const brandY = H * 0.5;
  drawBrand(ctx, W / 2, brandY, 64 * u);
  // Name and status sit under the brand; the ambient equalizer keeps to the bottom edge so nothing overlaps.
  if (spec.name) text(ctx, spec.name, W / 2, brandY + 74 * u, 28 * u, '#ffffff', 700, SANS, 'center', W * 0.7);
  if (spec.label) {
    const label = tr(spec.label);
    setFont(ctx, 700, 16 * u, SANS);
    const pill = ctx.measureText(label).width + 52 * u;
    const py = brandY + (spec.name ? 90 : 56) * u;
    rrect(ctx, W / 2 - pill / 2, py, pill, 34 * u, 17 * u, 'rgba(6,18,30,.52)');
    ctx.fillStyle = frame % 2 === 0 ? TEAL : '#718993';
    ctx.beginPath(); ctx.arc(W / 2 - pill / 2 + 20 * u, py + 17 * u, 5 * u, 0, Math.PI * 2); ctx.fill();
    text(ctx, label, W / 2 + 8 * u, py + 23 * u, 16 * u, '#e9f4f3', 700, SANS, 'center');
  }
  // Live ambient equalizer strip so idle monitors look visibly animated from across the room.
  const bars = 12, barGap = 14 * u, totalBarW = bars * barGap;
  const barY = H - 46 * u;
  for (let i = 0; i < bars; i++) {
    const bh = (6 + Math.abs(Math.sin(t * 1.3 + i * 0.55)) * 18) * u;
    rrect(ctx, W / 2 - totalBarW / 2 + i * barGap, barY - bh / 2, 7 * u, bh, 3.5 * u, i % 3 === 0 ? TEAL : i % 3 === 1 ? BLUE : 'rgba(232,244,246,.72)');
  }
}

/**
 * Second display of an idle desk: a drifting node network with a bouncing mark and a corner clock. It
 * shares nothing with the lock prompt beside it, so a dual-screen desk never looks mirrored.
 */
function drawScreensaver(pc: PaintContext) {
  const { ctx, W, H, spec, frame, now } = pc;
  const u = Math.min(W / 1024, H / 576);
  const paper = WALLPAPERS[(wallpaperIndex(spec.style, spec.phase) + 2) % WALLPAPERS.length]!;
  const bg = ctx.createLinearGradient(0, H, W, 0);
  bg.addColorStop(0, '#060c14'); bg.addColorStop(1, paper.stops[0]);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const t = frame * 0.18 + spec.phase * 2.3;
  radial(ctx, W * (0.3 + Math.sin(t * 0.5) * 0.2), H * (0.4 + Math.cos(t * 0.4) * 0.2), W * 0.55, paper.glowA, W, H);
  const nodes: [number, number][] = [];
  for (let i = 0; i < 18; i++) {
    const x = (noise(i, spec.phase + 5) * 0.9 + 0.05 + Math.sin(t + i) * 0.04) * W;
    const y = (noise(i, spec.phase + 11) * 0.84 + 0.08 + Math.cos(t * 0.8 + i * 1.7) * 0.05) * H;
    nodes.push([x, y]);
  }
  ctx.lineWidth = 2 * u;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i]![0] - nodes[j]![0], dy = nodes[i]![1] - nodes[j]![1];
      const d = Math.hypot(dx, dy);
      if (d > 230 * u) continue;
      ctx.strokeStyle = `rgba(127,209,240,${(0.42 * (1 - d / (230 * u))).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(nodes[i]![0], nodes[i]![1]); ctx.lineTo(nodes[j]![0], nodes[j]![1]); ctx.stroke();
    }
  }
  nodes.forEach(([x, y], i) => {
    ctx.fillStyle = i % 4 === 0 ? TEAL : i % 4 === 1 ? AMBER : 'rgba(232,244,246,.85)';
    ctx.beginPath(); ctx.arc(x, y, (i % 4 === 0 ? 7 : 4.5) * u, 0, Math.PI * 2); ctx.fill();
  });
  // A mark that wanders across the panel (triangle-wave path, so it bounces off the edges).
  const bounce = (value: number) => { const m = value % 2; return m < 1 ? m : 2 - m; };
  const mark = 70 * u;
  const bx = 40 * u + bounce(frame * 0.022 + spec.phase * 0.3) * (W - 80 * u - mark * BRAND_MARK_WIDTH);
  const by = 40 * u + bounce(frame * 0.031 + spec.phase * 0.5) * (H - 120 * u - mark);
  drawBrand(ctx, bx + mark * BRAND_MARK_WIDTH / 2, by + mark / 2, mark, '#edf1f5', true);
  rrect(ctx, W - 176 * u, H - 64 * u, 150 * u, 42 * u, 21 * u, 'rgba(4,10,16,.55)');
  text(ctx, clockText(now), W - 101 * u, H - 34 * u, 24 * u, '#e9f4f3', 600, SANS, 'center');
}

/** Third display of an idle desk: an analog clock with the date, slowly sweeping. */
function drawClockSaver(pc: PaintContext) {
  const { ctx, W, H, spec, frame, now } = pc;
  const u = Math.min(W / 1024, H / 576);
  const paper = WALLPAPERS[(wallpaperIndex(spec.style, spec.phase) + 3) % WALLPAPERS.length]!;
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, paper.stops[2]); bg.addColorStop(1, '#070d14');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  radial(ctx, W * 0.3, H * 0.5, W * 0.4, paper.glowB, W, H);
  const date = new Date(now);
  const cx = W * 0.3, cy = H * 0.5, r = Math.min(H * 0.36, W * 0.22);
  ctx.fillStyle = 'rgba(4,10,16,.5)';
  ctx.beginPath(); ctx.arc(cx, cy, r * 1.06, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.strokeStyle = i % 3 === 0 ? '#e9f4f3' : 'rgba(233,244,243,.5)';
    ctx.lineWidth = (i % 3 === 0 ? 7 : 4) * u;
    ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * r * 0.8, cy - Math.cos(a) * r * 0.8); ctx.lineTo(cx + Math.sin(a) * r * 0.94, cy - Math.cos(a) * r * 0.94); ctx.stroke();
  }
  const hand = (angle: number, length: number, width: number, color: string) => {
    ctx.strokeStyle = color; ctx.lineWidth = width * u; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(angle) * length, cy - Math.cos(angle) * length); ctx.stroke();
    ctx.lineCap = 'butt';
  };
  const minutes = date.getMinutes() + date.getSeconds() / 60;
  hand(((date.getHours() % 12) + minutes / 60) / 12 * Math.PI * 2, r * 0.5, 12, '#e9f4f3');
  hand(minutes / 60 * Math.PI * 2, r * 0.74, 8, '#e9f4f3');
  // The sweep advances with the repaint counter, so it moves even while the minute stands still.
  hand(((frame + spec.phase * 7) % 60) / 60 * Math.PI * 2, r * 0.82, 3, AMBER);
  ctx.fillStyle = TEAL; ctx.beginPath(); ctx.arc(cx, cy, 9 * u, 0, Math.PI * 2); ctx.fill();
  text(ctx, clockText(now), W * 0.58, H * 0.48, 84 * u, '#ffffff', 300, SANS, 'left', W * 0.4);
  text(ctx, dateText(now, spec.language), W * 0.58, H * 0.48 + 42 * u, 22 * u, 'rgba(225,238,240,.84)', 500, SANS, 'left', W * 0.4);
  drawBrand(ctx, W * 0.58 + 90 * u, H * 0.48 + 104 * u, 34 * u);
}

function drawWelcome(pc: PaintContext) {
  const { ctx, W, H, spec, frame, now, tr } = pc;
  const u = Math.min(W / 1024, H / 576);
  const t = frame * 0.5;
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0f3a4a'); bg.addColorStop(0.6, '#173a6a'); bg.addColorStop(1, '#2a2a66');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  radial(ctx, W * (0.8 + Math.sin(t * 0.6) * 0.08), H * (0.14 + Math.cos(t * 0.5) * 0.06), W * 0.5, 'rgba(46,196,170,.38)', W, H);
  radial(ctx, W * (0.14 + Math.cos(t * 0.4) * 0.08), H * 0.92, W * 0.42, 'rgba(240,200,117,.22)', W, H);
  if (spec.detail === 'directory') {
    text(ctx, tr('Visitor guide'), 44 * u, 76 * u, 38 * u, '#ffffff', 700, SANS, 'left', W - 88 * u);
    const activeFloor = frame % 3;
    ['Floor 1', 'Floor 2', 'Floor 3'].forEach((floor, i) => {
      const y = 126 * u + i * 118 * u;
      rrect(ctx, 44 * u, y, W - 88 * u, 92 * u, 16 * u, i === activeFloor ? 'rgba(89,215,186,.18)' : 'rgba(6,18,30,.42)', i === activeFloor ? TEAL : undefined, 2 * u);
      rrect(ctx, 64 * u, y + 20 * u, 52 * u, 52 * u, 12 * u, [TEAL, BLUE, AMBER][i]!);
      text(ctx, String(i + 1), 90 * u, y + 56 * u, 28 * u, '#08141a', 800, SANS, 'center');
      text(ctx, tr(floor), 140 * u, y + 44 * u, 26 * u, '#f1f8f8', 700, SANS);
      rrect(ctx, 140 * u, y + 56 * u, (220 + i * 40) * u, 8 * u, 4 * u, 'rgba(225,238,240,.35)');
    });
    return;
  }
  drawBrand(ctx, W / 2, H * 0.32, 96 * u);
  text(ctx, tr('Welcome'), W / 2, H * 0.64, 62 * u, '#ffffff', 700, SANS, 'center');
  text(ctx, tr('Please check in at the front desk'), W / 2, H * 0.64 + 40 * u, 22 * u, 'rgba(225,238,240,.82)', 500, SANS, 'center', W * 0.8);
  text(ctx, `${clockText(now)}  ·  ${dateText(now, spec.language)}`, W / 2, H - 30 * u, 18 * u, 'rgba(225,238,240,.7)', 500, SANS, 'center');
}

function drawStandby(pc: PaintContext) {
  const { ctx, W, H, spec, frame, now, tr } = pc;
  const u = Math.min(W / 1024, H / 576);
  const t = frame * 0.5;
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#16222b'); bg.addColorStop(1, '#202a3d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  radial(ctx, W * (0.5 + Math.sin(t * 0.6) * 0.15), H * (0.45 + Math.cos(t * 0.4) * 0.1), W * 0.48, 'rgba(89,215,186,.22)', W, H);
  drawBrand(ctx, W / 2, H * 0.4, 78 * u);
  text(ctx, tr('Ready to present'), W / 2, H * 0.4 + 92 * u, 30 * u, '#e5f0f1', 600, SANS, 'center');
  text(ctx, clockText(now), W - 36 * u, H - 30 * u, 28 * u, 'rgba(225,238,240,.7)', 500, SANS, 'right');
  if (spec.title) text(ctx, spec.title, 36 * u, H - 30 * u, 20 * u, 'rgba(225,238,240,.55)', 500, SANS, 'left', W * 0.5);
}

function drawSignage(pc: PaintContext) {
  const { ctx, W, H, spec, frame, now } = pc;
  const u = Math.min(W / 1024, H / 576);
  const hue = 150 + ((spec.title?.length ?? 0) * 37) % 90;
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, `hsl(${hue}, 38%, 14%)`); bg.addColorStop(1, `hsl(${hue + 60}, 36%, 20%)`);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  radial(ctx, W * (0.72 + Math.sin(frame * 0.45) * 0.12), H * 0.34, W * 0.5, `hsla(${hue + 20}, 70%, 55%, .28)`, W, H);
  text(ctx, (spec.title ?? '').toUpperCase(), W / 2, H * 0.5, 54 * u, '#f3f8f6', 700, SANS, 'center', W * 0.86);
  if (spec.subtitle) text(ctx, spec.subtitle, W / 2, H * 0.5 + 46 * u, 24 * u, 'rgba(230,242,238,.78)', 500, SANS, 'center', W * 0.84);
  drawBrand(ctx, 100 * u, H - 40 * u, 26 * u, 'rgba(237,241,245,.8)');
  text(ctx, clockText(now), W - 36 * u, H - 34 * u, 28 * u, 'rgba(225,238,240,.7)', 500, SANS, 'right');
}

const STATUS_COLORS: Record<string, string> = {
  working: TEAL, thinking: BLUE, delegating: '#7fd1f0', waiting: '#c99ae5', blocked: AMBER,
  idle: '#6c8990', observing: '#8aa0a6', paused: '#8aa0a6', stopping: '#df9168', unavailable: '#cf7777',
};

function drawAgents(pc: PaintContext) {
  const { ctx, W, H, spec, frame, now, tr } = pc;
  const board = spec.board;
  const u = Math.min(W / 1024, H / 576) * 1.1;
  ctx.fillStyle = '#09131a'; ctx.fillRect(0, 0, W, H);
  const headH = Math.max(46 * u, H * 0.13);
  ctx.fillStyle = '#0f1d25'; ctx.fillRect(0, 0, W, headH);
  const markW = BRAND_MARK_WIDTH * headH * 0.4;
  drawBrand(ctx, 28 * u + markW / 2, headH / 2, headH * 0.4, '#edf1f5', true);
  text(ctx, (spec.title ?? tr('SESSION OVERVIEW')).toUpperCase(), 28 * u + markW + 16 * u, headH / 2 + 8 * u, 24 * u, '#f1f6f5', 700, SANS, 'left', W * 0.55);
  text(ctx, clockText(now), W - 28 * u, headH / 2 + 10 * u, 32 * u, '#e5f0f1', 600, SANS, 'right');
  if (spec.subtitle) text(ctx, spec.subtitle, W - 150 * u, headH / 2 + 7 * u, 17 * u, '#7f9ca3', 500, SANS, 'right', W * 0.25);

  const gap = 16 * u;
  const top = headH + gap;
  const cardH = H - top - gap - 34 * u;
  const colW = (W - gap * 4) / 3;
  const card = (index: number) => ({ x: gap + index * (colW + gap), y: top });
  const total = board?.total ?? 0;

  // Agents online: the real count and how the statuses split.
  const a = card(0);
  rrect(ctx, a.x, a.y, colW, cardH, 14 * u, '#11222b');
  text(ctx, tr('AGENTS ONLINE'), a.x + 22 * u, a.y + 34 * u, 15 * u, '#7f9ca3', 700, SANS, 'left', colW - 44 * u);
  text(ctx, String(total), a.x + 22 * u, a.y + 34 * u + Math.min(cardH * 0.46, 96 * u), Math.min(cardH * 0.5, 104 * u), total ? '#f1f8f8' : '#4e6a72', 700, SANS);
  const stackY = a.y + cardH - 52 * u;
  rrect(ctx, a.x + 22 * u, stackY, colW - 44 * u, 14 * u, 7 * u, '#1b2d36');
  let sx = a.x + 22 * u;
  for (const [status, count] of Object.entries(board?.statuses ?? {})) {
    const width = (colW - 44 * u) * (count as number) / Math.max(1, total);
    rrect(ctx, sx, stackY, Math.max(4 * u, width - 2 * u), 14 * u, 7 * u, STATUS_COLORS[status] ?? '#6c8990');
    sx += width;
  }
  if (!total) text(ctx, tr('No agents online'), a.x + 22 * u, stackY - 14 * u, 15 * u, '#6c8990', 500, SANS, 'left', colW - 44 * u);

  // Activity: counts per reported activity kind.
  const b = card(1);
  rrect(ctx, b.x, b.y, colW, cardH, 14 * u, '#11222b');
  text(ctx, tr('ACTIVITY'), b.x + 22 * u, b.y + 34 * u, 15 * u, '#7f9ca3', 700, SANS);
  const activities = Object.entries(board?.activities ?? {}).sort((x, y) => (y[1] as number) - (x[1] as number) || (x[0] < y[0] ? -1 : 1)).slice(0, 5);
  const maxCount = Math.max(1, ...activities.map(entry => entry[1] as number));
  const rowH = Math.min(46 * u, (cardH - 70 * u) / 5);
  activities.forEach(([kind, count], i) => {
    const y = b.y + 58 * u + i * rowH;
    text(ctx, tr((kind as ActivityKind).toUpperCase()), b.x + 22 * u, y + 14 * u, 14 * u, '#b4cbd0', 600, SANS, 'left', 110 * u);
    const barX = b.x + 136 * u, barW = colW - 136 * u - 56 * u;
    rrect(ctx, barX, y + 3 * u, barW, 13 * u, 6.5 * u, '#1b2d36');
    rrect(ctx, barX, y + 3 * u, Math.max(8 * u, barW * (count as number) / maxCount), 13 * u, 6.5 * u, TEAL);
    text(ctx, String(count), b.x + colW - 22 * u, y + 15 * u, 15 * u, '#e5f0f1', 700, SANS, 'right');
  });
  if (!activities.length) text(ctx, '—', b.x + 22 * u, b.y + 92 * u, 22 * u, '#4e6a72', 500, SANS);

  // Sessions: who is online and what they are doing.
  const c = card(2);
  rrect(ctx, c.x, c.y, colW, cardH, 14 * u, '#11222b');
  text(ctx, tr('SESSIONS'), c.x + 22 * u, c.y + 34 * u, 15 * u, '#7f9ca3', 700, SANS);
  const lineH = Math.min(40 * u, (cardH - 62 * u) / 6);
  (board?.top ?? []).slice(0, 6).forEach((agent, i) => {
    const y = c.y + 62 * u + i * lineH;
    ctx.fillStyle = STATUS_COLORS[agent.status] ?? '#6c8990';
    ctx.beginPath(); ctx.arc(c.x + 30 * u, y + 8 * u, 6 * u, 0, Math.PI * 2); ctx.fill();
    text(ctx, agent.name, c.x + 46 * u, y + 14 * u, 16 * u, '#e5f0f1', 600, SANS, 'left', colW - 140 * u);
    text(ctx, tr((agent.activity ?? agent.status).toString().toUpperCase()), c.x + colW - 20 * u, y + 14 * u, 12 * u, '#7f9ca3', 600, SANS, 'right');
  });

  // Footer pulse: decoration scaled by how many agents are busy, not a measurement.
  const busy = (board?.statuses.working ?? 0) + (board?.statuses.thinking ?? 0);
  const fy = H - 18 * u;
  ctx.strokeStyle = busy ? TEAL : '#35505a'; ctx.lineWidth = 2.4 * u; ctx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const x = gap + (W - gap * 2) * i / 60;
    const y = fy - (busy ? noise(i + frame, 5) * Math.min(14, 4 + busy * 3) * u : 2 * u);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawMedia(pc: PaintContext) {
  const { ctx, W, H, spec, frame, tr } = pc;
  const u = Math.min(W / 1024, H / 576);
  const t = (frame * 0.5 + spec.phase * 9);
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  const hue = 18 + Math.sin(t * 0.05) * 14;
  sky.addColorStop(0, `hsl(${hue + 210}, 45%, 18%)`);
  sky.addColorStop(0.55, `hsl(${hue}, 80%, 58%)`);
  sky.addColorStop(1, `hsl(${hue + 10}, 70%, 35%)`);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,226,170,.92)';
  ctx.beginPath(); ctx.arc(W * 0.68, H * 0.5 + Math.sin(t * 0.05) * 22 * u, 64 * u, 0, Math.PI * 2); ctx.fill();
  [{ color: 'rgba(40,30,60,.78)', amp: 50, base: 0.62, speed: 6, freq: 0.006 }, { color: 'rgba(20,18,36,.92)', amp: 34, base: 0.74, speed: 14, freq: 0.011 }].forEach(layer => {
    ctx.fillStyle = layer.color; ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, H * layer.base + Math.sin((x + t * layer.speed) * layer.freq) * layer.amp * u);
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  });
  rrect(ctx, 28 * u, 24 * u, 180 * u, 44 * u, 10 * u, 'rgba(0,0,0,.45)');
  drawBrand(ctx, 118 * u, 46 * u, 22 * u);
  ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(0, H - 64 * u, W, 64 * u);
  text(ctx, `${tr('Now playing')}  ·  ${tr('Ambient mix')}`, 28 * u, H - 26 * u, 20 * u, '#ffffff', 600, SANS, 'left', W * 0.6);
  for (let i = 0; i < 14; i++) {
    const bh = 8 + Math.abs(Math.sin(t * 0.9 + i * 0.7)) * 30;
    ctx.fillStyle = TEAL; ctx.fillRect(W - 220 * u + i * 14 * u, H - 18 * u - bh * u, 8 * u, bh * u);
  }
  ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.fillRect(28 * u, H - 12 * u, W * 0.55, 4 * u);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(28 * u, H - 12 * u, W * 0.55 * ((t / 180) % 1), 4 * u);
}

function drawMonitoring(pc: PaintContext) {
  const { ctx, W, H, spec, frame, tr } = pc;
  const u = Math.min(W / 1024, H / 576);
  ctx.fillStyle = '#060c10'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(89,215,186,.06)'; ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40 * u) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40 * u) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  text(ctx, (spec.title ?? tr('SESSION OVERVIEW')).toUpperCase(), 28 * u, 44 * u, 24 * u, '#59d7ba', 700, MONO, 'left', W * 0.7);
  const rows = 3, rowH = (H - 90 * u) / rows;
  for (let r = 0; r < rows; r++) {
    const y = 70 * u + r * rowH;
    rrect(ctx, 28 * u, y, W * 0.56, rowH - 14 * u, 10 * u, '#0d171d');
    ctx.strokeStyle = [TEAL, BLUE, AMBER][r]!; ctx.lineWidth = 2.5 * u; ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const x = 28 * u + (W * 0.56) * i / 48;
      const v = 0.5 + Math.sin(i * 0.4 + frame * 0.9 + r * 2) * 0.22 + (noise(i + frame, r) - 0.5) * 0.18;
      const yy = y + 10 * u + (rowH - 34 * u) * (1 - v);
      if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  const cols = 8, cellW = (W * 0.36) / cols;
  const rowsLed = Math.max(3, Math.floor((H - 100 * u) / cellW));
  for (let c = 0; c < cols; c++) for (let r = 0; r < rowsLed; r++) {
    const pulse = Math.sin(frame * 0.8 + c * 0.9 + r * 1.7 + spec.phase);
    ctx.fillStyle = pulse > 0.9 ? AMBER : pulse > -0.3 ? '#2f9e86' : '#1c4a42';
    ctx.fillRect(W * 0.62 + c * cellW, 70 * u + r * cellW, cellW - 5 * u, cellW - 5 * u);
  }
}

function drawDiagram(pc: PaintContext) {
  const { ctx, W, H, spec, frame, tr } = pc;
  const u = Math.min(W / 1024, H / 576);
  ctx.fillStyle = '#f2efe8'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1d2a30'; ctx.fillRect(0, 0, W, 60 * u);
  ctx.fillStyle = '#c9a35f'; ctx.fillRect(0, 60 * u, W, 4 * u);
  text(ctx, (spec.title ?? tr('ARCHITECTURE')).toUpperCase(), 32 * u, 40 * u, 26 * u, '#f4f1ea', 700, SANS, 'left', W * 0.6);
  if (spec.subtitle) text(ctx, spec.subtitle, W - 32 * u, 38 * u, 18 * u, '#b7c4c8', 500, SANS, 'right', W * 0.3);
  const nodes = [[0.14, 0.34], [0.42, 0.34], [0.7, 0.34], [0.28, 0.72], [0.56, 0.72]] as const;
  const edges = [[0, 1], [1, 2], [1, 3], [1, 4], [4, 2]] as const;
  const area = { x: 0, y: 76 * u, w: W, h: H - 76 * u };
  const pos = nodes.map(([fx, fy]) => ({ x: area.x + area.w * fx + 100 * u, y: area.y + area.h * fy }));
  ctx.lineWidth = 4 * u; ctx.strokeStyle = '#8aa0a6';
  edges.forEach(([from, to], i) => {
    const a = pos[from]!, b = pos[to]!;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    const t = (frame * 0.2 + i * 0.21 + spec.phase * 0.1) % 1;
    ctx.fillStyle = '#2f9e86'; ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 8 * u, 0, Math.PI * 2); ctx.fill();
  });
  pos.forEach((p, i) => {
    rrect(ctx, p.x - 100 * u, p.y - 36 * u, 200 * u, 72 * u, 14 * u, '#1d2a30');
    rrect(ctx, p.x - 56 * u, p.y - 5 * u, (80 + (i % 3) * 20) * u, 9 * u, 4.5 * u, '#f4f1ea');
  });
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/** Paints one frame of `spec` into `ctx`, whose transform maps the 1024-wide design space to pixels. */
export function paintScreen(ctx: CanvasRenderingContext2D, spec: SurfaceSpec, frame: number, now: number, tr: (text: string) => string): void {
  const W = DESIGN_WIDTH;
  const H = spec.designHeight;
  const pc: PaintContext = { ctx, W, H, spec, frame, now, tr };
  ctx.save();
  ctx.fillStyle = '#05090c';
  ctx.fillRect(0, 0, W, H);
  switch (spec.kind) {
    case 'lock': drawLock(pc); break;
    case 'welcome': drawWelcome(pc); break;
    case 'standby': drawStandby(pc); break;
    case 'signage': drawSignage(pc); break;
    case 'agents': drawAgents(pc); break;
    case 'media': drawMedia(pc); break;
    case 'monitoring': drawMonitoring(pc); break;
    case 'diagram': drawDiagram(pc); break;
    case 'off': break;
    default: {
      const rect = drawShell(pc);
      inRect(pc, rect, (w, h) => {
        if (spec.kind === 'editor') drawEditor(pc, w, h);
        else if (spec.kind === 'terminal') drawTerminal(pc, w, h);
        else if (spec.kind === 'tests') drawTests(pc, w, h);
        else if (spec.kind === 'docs') drawDocs(pc, w, h);
        else if (spec.kind === 'dashboard') drawDashboard(pc, w, h);
        else drawApproval(pc, w, h);
      });
    }
  }
  ctx.restore();
}
