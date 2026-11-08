/** Time-based shelf → pull → open → page-turn → close → return, independent of frame rate. */
export type BookPhase = 'shelf' | 'pulling' | 'opening' | 'reading' | 'turning' | 'closing' | 'returning';
const durations: Record<BookPhase, number> = { shelf: 0, pulling: 480, opening: 580, reading: 0, turning: 620, closing: 420, returning: 460 };
const ease = (value: number) => value * value * (3 - 2 * value);

export class SkillBookMotion {
  activeId: string | null = null;
  phase: BookPhase = 'shelf';
  lift = 0;
  open = 0;
  turn = 0;
  page = 0;
  fromPage = 0;
  toPage = 0;
  private requested: string | null = null;
  private requestedPage = 0;
  private elapsed = 0;
  private start = 0;

  get animating(): boolean { return this.phase !== 'shelf' && this.phase !== 'reading'; }

  request(id: string | null, page = 0): void {
    this.requested = id;
    this.requestedPage = Math.max(0, Math.floor(page));
    if (this.phase === 'shelf') this.adopt();
    else if (id !== this.activeId && !['closing', 'returning', 'turning'].includes(this.phase)) {
      this.begin(this.open > 0 ? 'closing' : 'returning');
    } else if (this.phase === 'reading') this.reconcile();
  }

  /** Hidden time is excluded by the caller. Reduced motion reaches the requested resting pose in one draw. */
  advance(milliseconds: number, reduced = false): void {
    let remaining = reduced ? 10_000 : Math.max(0, milliseconds);
    for (let transitions = 0; this.animating && transitions < 12; transitions++) {
      const duration = durations[this.phase];
      const consumed = Math.min(remaining, duration - this.elapsed);
      remaining -= consumed; this.elapsed += consumed;
      const progress = ease(Math.min(1, this.elapsed / duration));
      if (this.phase === 'pulling') this.lift = this.start + (1 - this.start) * progress;
      if (this.phase === 'opening') this.open = this.start + (1 - this.start) * progress;
      if (this.phase === 'closing') this.open = this.start * (1 - progress);
      if (this.phase === 'returning') this.lift = this.start * (1 - progress);
      if (this.phase === 'turning') this.turn = progress;
      if (this.elapsed < duration) break;
      switch (this.phase) {
        case 'pulling': this.begin(this.requested === this.activeId ? 'opening' : 'returning'); break;
        case 'opening': this.phase = 'reading'; this.reconcile(); break;
        case 'turning': this.page = this.toPage; this.turn = 0; this.phase = 'reading'; this.reconcile(); break;
        case 'closing': this.begin('returning'); break;
        case 'returning': this.activeId = null; this.phase = 'shelf'; this.adopt(); break;
      }
      if (remaining <= 0) break;
    }
  }

  private begin(phase: BookPhase): void {
    this.phase = phase; this.elapsed = 0;
    this.start = phase === 'pulling' || phase === 'returning' ? this.lift : this.open;
  }
  private adopt(): void {
    if (!this.requested) return;
    this.activeId = this.requested; this.page = this.requestedPage;
    this.fromPage = this.page; this.toPage = this.page; this.open = 0; this.lift = 0; this.turn = 0;
    this.begin('pulling');
  }
  private reconcile(): void {
    if (this.requested !== this.activeId) this.begin('closing');
    else if (this.requestedPage !== this.page) {
      this.fromPage = this.page; this.toPage = this.requestedPage; this.turn = 0; this.begin('turning');
    }
  }
}

export interface SkillBookPage { text: string; lines: string[] }
/** Literal Unicode text, bounded visual lines. Concatenating page text preserves the source exactly. */
export function paginateBookText(text: string, columns = 22, rows = 16): SkillBookPage[] {
  const pages: SkillBookPage[] = [];
  let raw = '', line = '', lines: string[] = [], width = 0;
  const finishLine = () => {
    lines.push(line); line = ''; width = 0;
    if (lines.length >= Math.max(1, rows)) { pages.push({ text: raw, lines }); raw = ''; lines = []; }
  };
  for (const token of text.match(/\n|[^\S\n]+|[^\s]+/gu) ?? []) {
    const characters = Array.from(token);
    // Prefer whole words while keeping long paths, hashes and code lossless.
    if (!/^\s/u.test(token) && width > 0 && width + characters.length > Math.max(1, columns)) finishLine();
    for (const character of characters) {
      const shown = character === '\t' ? '  ' : character;
      if (character !== '\n' && character !== '\r' && width + shown.length > Math.max(1, columns)) finishLine();
      raw += character;
      if (character === '\n') finishLine();
      else if (character !== '\r') {
        line += shown; width += shown.length;
        if (width >= Math.max(1, columns)) finishLine();
      }
    }
  }
  if (line) finishLine();
  if (raw || lines.length || !pages.length) pages.push({ text: raw, lines: lines.length ? lines : [''] });
  return pages;
}
