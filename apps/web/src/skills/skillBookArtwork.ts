import type { SkillBook } from './skillLibraryModel';

const WIDTH = 512, HEIGHT = 768;

/** Small, deterministic local artwork: each title gets its own binding, never a remote image. */
export function bookSeed(title: string): number {
  let value = 2166136261;
  for (const character of title) value = Math.imul(value ^ character.codePointAt(0)!, 16777619);
  return value >>> 0;
}

export function createBookCover(book: SkillBook, index: number, color: string): HTMLCanvasElement {
  const art = document.createElement('canvas'); art.width = WIDTH; art.height = HEIGHT;
  const ctx = art.getContext('2d'); if (!ctx) return art;
  const seed = bookSeed(book.id);
  ctx.fillStyle = color; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  // Woven cloth stays subtle enough that lettering and the motif remain crisp.
  for (let line = 0; line < HEIGHT; line += 2) {
    ctx.fillStyle = line % 6 ? '#ffffff08' : '#00000016'; ctx.fillRect(0, line, WIDTH, 1);
  }
  for (let column = 0; column < WIDTH; column += 3) {
    ctx.fillStyle = column % 9 ? '#ffffff06' : '#00000010'; ctx.fillRect(column, 0, 1, HEIGHT);
  }
  const binding = ctx.createLinearGradient(0, 0, 54, 0);
  binding.addColorStop(0, '#00000055'); binding.addColorStop(.35, '#ffffff16'); binding.addColorStop(.62, '#00000022'); binding.addColorStop(1, '#00000000');
  ctx.fillStyle = binding; ctx.fillRect(0, 0, 54, HEIGHT);
  ctx.strokeStyle = '#f5e8c338'; ctx.lineWidth = 1; ctx.strokeRect(33, 23, 455, 720);
  ctx.fillStyle = '#efdfb9'; ctx.font = '11px sans-serif'; ctx.fillText('E X T A L I A', 62, 58);
  ctx.textAlign = 'right'; ctx.fillText(String(index + 1).padStart(2, '0'), 462, 58); ctx.textAlign = 'start';
  ctx.save(); ctx.translate(270, 333); ctx.strokeStyle = '#f3e8c9'; ctx.fillStyle = '#f3e8c9'; ctx.lineWidth = 1.6;
  const motif = seed % 4;
  if (motif === 0) {
    // A celestial mechanism: planes, orbit and a small foil sun.
    for (const offset of [-93, 4, 101]) {
      ctx.beginPath(); ctx.moveTo(-134, offset + 18); ctx.lineTo(65, offset - 32); ctx.lineTo(128, offset + 8); ctx.lineTo(-70, offset + 58); ctx.closePath();
      ctx.globalAlpha = .18; ctx.fill(); ctx.globalAlpha = .9; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, offset + 13, 51, 19, -.18, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.stroke(); ctx.fillStyle = '#f3e8c9';
    }
    ctx.beginPath(); ctx.ellipse(0, 13, 159, 49, -.43, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 12, 23, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = .35; ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.moveTo(0, -195); ctx.lineTo(0, 200); ctx.stroke();
  } else if (motif === 1) {
    // Contour lines suggest an atlas without inventing skill data.
    for (let ring = 0; ring < 13; ring++) {
      ctx.beginPath();
      for (let segment = 0; segment <= 128; segment++) {
        const angle = segment / 128 * Math.PI * 2;
        const radius = 20 + ring * 11 + Math.sin(angle * 3 + seed % 7) * (5 + ring * .8) + Math.sin(angle * 5) * 4;
        const x = Math.cos(angle) * radius * .8, y = Math.sin(angle) * radius * 1.15;
        if (segment === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.globalAlpha = .38 + ring / 22; ctx.stroke();
    }
  } else if (motif === 2) {
    // Receding architectural frames and a solid inner doorway.
    for (let frame = 0; frame < 9; frame++) {
      const inset = frame * 11;
      ctx.globalAlpha = .25 + frame * .07; ctx.strokeRect(-132 + inset, -163 + inset, 264 - inset * 1.6, 326 - inset * 1.6);
    }
    ctx.globalAlpha = .82; ctx.fillRect(-42, -66, 83, 174);
    ctx.globalAlpha = .2; ctx.fillStyle = '#000000'; ctx.beginPath(); ctx.moveTo(-42, -66); ctx.lineTo(41, -66); ctx.lineTo(41, 108); ctx.closePath(); ctx.fill();
  } else {
    // A drafting compass with restrained foil geometry.
    for (let ring = 0; ring < 6; ring++) { ctx.globalAlpha = .3 + ring * .1; ctx.beginPath(); ctx.arc(0, 0, 24 + ring * 24, 0, Math.PI * 2); ctx.stroke(); }
    ctx.globalAlpha = .62;
    for (let axis = 0; axis < 8; axis++) { const angle = axis * Math.PI / 4; ctx.beginPath(); ctx.moveTo(Math.cos(angle) * 20, Math.sin(angle) * 20); ctx.lineTo(Math.cos(angle) * 169, Math.sin(angle) * 169); ctx.stroke(); }
    ctx.globalAlpha = .9; ctx.beginPath(); ctx.moveTo(-117, 94); ctx.lineTo(21, -156); ctx.lineTo(116, 94); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(21, -156, 6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = '#f6e7bd'; ctx.font = '40px Georgia, serif';
  const words = book.title.replace(/[-_/]/g, ' ').split(/\s+/u);
  const lines: string[] = []; let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > 383 && line) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, 3);
  shown.forEach((text, row) => ctx.fillText(text, 62, 633 - (shown.length - 1 - row) * 46, 388));
  ctx.strokeStyle = '#efdfb978'; ctx.beginPath(); ctx.moveTo(62, 670); ctx.lineTo(449, 670); ctx.stroke();
  ctx.fillStyle = '#efdfb9a0'; ctx.font = '12px sans-serif';
  ctx.fillText(String(index + 1).padStart(2, '0'), 62, 701);
  return art;
}

export function createPaperEdges(): HTMLCanvasElement {
  const art = document.createElement('canvas'); art.width = 512; art.height = 128;
  const ctx = art.getContext('2d'); if (!ctx) return art;
  ctx.fillStyle = '#e6e0d2'; ctx.fillRect(0, 0, 512, 128);
  for (let sheet = 0; sheet < 132; sheet++) {
    const x = sheet * 3.9;
    ctx.fillStyle = sheet % 7 === 0 ? '#9c95804a' : '#aaa28d28'; ctx.fillRect(x, 0, 1, 128);
    ctx.fillStyle = '#ffffff55'; ctx.fillRect(x + 1, 0, 1, 128);
  }
  const edge = ctx.createLinearGradient(0, 0, 512, 0);
  edge.addColorStop(0, '#83785f35'); edge.addColorStop(.12, '#ffffff00'); edge.addColorStop(.85, '#ffffff00'); edge.addColorStop(1, '#83785f35');
  ctx.fillStyle = edge; ctx.fillRect(0, 0, 512, 128);
  return art;
}

export function createClothWeave(): HTMLCanvasElement {
  const art = document.createElement('canvas'); art.width = art.height = 128;
  const ctx = art.getContext('2d'); if (!ctx) return art;
  ctx.fillStyle = '#999'; ctx.fillRect(0, 0, 128, 128);
  for (let line = 0; line < 128; line += 4) {
    ctx.fillStyle = '#777'; ctx.fillRect(line, 0, 1, 128); ctx.fillRect(0, line, 128, 1);
    ctx.fillStyle = '#bbb'; ctx.fillRect(line + 1, 0, 1, 128); ctx.fillRect(0, line + 1, 128, 1);
  }
  return art;
}
