import { describe, expect, it } from 'vitest';
import { applyTeamSpec, parseTeamSpec, type AgentTeam } from '../src/index.js';

const OTP_SPEC = `Eksekusi fitur OTP Login Endpoint:
Subagent A:
- Name: Elena Mark
- Gender: female
- Role: Backend Engineer
- Model: ag/claude-sonnet-4-6
- Soul: "Pragmatic, clean architect. Prefers small, well-named modules and standard response shapes."
- Tugas: Buat route POST /api/auth/otp, controller, validasi request format, dan respon JSON standar.
Subagent B:
- Name: Kaelen Vael
- Gender: male
- Role: Backend Engineer
- Model: ag/claude-opus-4-6-thinking, ag/gemini-4-argon-high
- Soul: "Paranoid security & concurrency engineer. Assumes every input is hostile and every request races."
- Tugas: Audit skema Elena. Tambahkan rate limiter per nomor telepon, hash token OTP sebelum disimpan, transactional lock saat verifikasi.
- Batasan: "migrations/, .env, package.json"`;

const TEMPLATE_SPEC = `Kamu adalah Lead Orchestrator. Pecah pekerjaan ke subagent di bawah ini, tunggu hasilnya, lalu gabungkan.

### TARGET PROYEK
Endpoint login OTP untuk aplikasi mobile: kirim kode, verifikasi kode, terbitkan sesi.

### MATRIKS SUBAGENT

#### Subagent 1: Elena Mark
- **Gender:** female
- **Role:** Backend Engineer
- **Model:** ag/claude-sonnet-4-6
- **Soul / Persona:** "Pragmatic, clean architect."
- **Tugas:** Buat route POST /api/auth/otp dan controller-nya.
  Gunakan format respon JSON standar proyek.
- **Batasan:** \`src/legacy/\`, \`src/db/migrations/**\`

#### Subagent 2: Kaelen Vael
- **Gender:** male
- **Peran:** Security Reviewer
- **Models:** ag/claude-opus-4-6-thinking -> ag/gemini-4-argon-high
- **Persona:** 'Paranoid security & concurrency engineer.'
- **Task:** Audit the OTP flow for replay and race conditions; report findings only.
- **Akses:** read-only

#### Subagent 3: [Name]
- **Gender:** perempuan
- **Role:** QA Engineer
- **Model:** ag/gemini-4-argon-high
- **Tugas:** Tulis test untuk endpoint OTP.
- **Lingkup:** tests/auth/, src/auth/otp.test.ts

### ATURAN EKSEKUSI
1. Jalankan typecheck, test dan build sebelum melapor.
2. Jangan commit atau push.
3. Laporkan progres ke Discord setiap selesai satu tugas.`;

describe('parseTeamSpec', () => {
  it('reads the short "Subagent A:" format with Indonesian labels, quoted souls and model chains', () => {
    const spec = parseTeamSpec(OTP_SPEC)!;
    expect(spec.goal).toBe('Eksekusi fitur OTP Login Endpoint');
    expect(spec.rules).toBeUndefined();
    expect(spec.members).toEqual([
      {
        name: 'Elena Mark', gender: 'female', role: 'Backend Engineer', models: ['ag/claude-sonnet-4-6'], access: 'write',
        soul: 'Pragmatic, clean architect. Prefers small, well-named modules and standard response shapes.',
        task: 'Buat route POST /api/auth/otp, controller, validasi request format, dan respon JSON standar.',
      },
      {
        name: 'Kaelen Vael', gender: 'male', role: 'Backend Engineer', models: ['ag/claude-opus-4-6-thinking', 'ag/gemini-4-argon-high'], access: 'write',
        soul: 'Paranoid security & concurrency engineer. Assumes every input is hostile and every request races.',
        task: 'Audit skema Elena. Tambahkan rate limiter per nomor telepon, hash token OTP sebelum disimpan, transactional lock saat verifikasi.',
        forbidden: ['migrations', '.env', 'package.json'],
      },
    ]);
  });

  it('reads the Lead Orchestrator template: sections, #### headings, bold labels, placeholders and rules', () => {
    const spec = parseTeamSpec(TEMPLATE_SPEC)!;
    expect(spec.goal).toBe('Endpoint login OTP untuk aplikasi mobile: kirim kode, verifikasi kode, terbitkan sesi.');
    expect(spec.rules).toEqual([
      'Jalankan typecheck, test dan build sebelum melapor.',
      'Jangan commit atau push.',
      'Laporkan progres ke Discord setiap selesai satu tugas.',
    ]);
    expect(spec.members).toHaveLength(3);
    expect(spec.members[0]).toEqual({
      name: 'Elena Mark', gender: 'female', role: 'Backend Engineer', models: ['ag/claude-sonnet-4-6'], soul: 'Pragmatic, clean architect.', access: 'write',
      task: 'Buat route POST /api/auth/otp dan controller-nya.\nGunakan format respon JSON standar proyek.',
      forbidden: ['src/legacy', 'src/db/migrations/**'],
    });
    expect(spec.members[1]).toEqual({
      name: 'Kaelen Vael', gender: 'male', role: 'Security Reviewer', models: ['ag/claude-opus-4-6-thinking', 'ag/gemini-4-argon-high'], access: 'read',
      soul: 'Paranoid security & concurrency engineer.', task: 'Audit the OTP flow for replay and race conditions; report findings only.',
    });
    // "[Name]" is a placeholder: the name is generated when the spec is applied.
    expect(spec.members[2]).toEqual({
      name: '', gender: 'female', role: 'QA Engineer', models: ['ag/gemini-4-argon-high'], access: 'write', task: 'Tulis test untuk endpoint OTP.',
      scope: ['tests/auth', 'src/auth/otp.test.ts'],
    });
  });

  it('accepts English labels, heading names with a role, and keeps prose constraints with the task', () => {
    const spec = parseTeamSpec([
      'Please build the billing page.',
      '',
      '**Sub-agent 1 - Mira Ostrevan (Frontend Engineer)**',
      '* Gender: F',
      '* Models: gpt-5 (fallback: gpt-5-mini)',
      '* Task: Implement the page.',
      '* Constraints: do not touch the API layer in `src/api/` or any lockfile',
      '* Scope: src/pages/billing/**',
      '',
      'Thanks!',
    ].join('\n'))!;
    expect(spec.goal).toBe('Please build the billing page.');
    expect(spec.members).toEqual([{
      name: 'Mira Ostrevan', gender: 'female', role: 'Frontend Engineer', models: ['gpt-5', 'gpt-5-mini'], access: 'write',
      task: 'Implement the page.\nConstraints: do not touch the API layer in `src/api/` or any lockfile', forbidden: ['src/api'], scope: ['src/pages/billing/**'],
    }]);
  });

  it('drops unsafe paths and invalid model ids instead of failing', () => {
    const spec = parseTeamSpec('Subagent X:\n- Nama: Ivo Tarrow\n- Model: --yolo, good-model\n- Lingkup: /etc/passwd, ../outside, src/ok\n- Akses: tulis')!;
    expect(spec.members[0]).toMatchObject({ name: 'Ivo Tarrow', models: ['good-model'], access: 'write', scope: ['src/ok'] });
  });

  it('returns undefined without subagent blocks', () => {
    expect(parseTeamSpec('Fix the flaky login test.')).toBeUndefined();
    expect(parseTeamSpec('Subagent teams are great. Create one for me.')).toBeUndefined();
    expect(parseTeamSpec('')).toBeUndefined();
  });
});

describe('applyTeamSpec', () => {
  let n = 0;
  const newId = () => `m-${++n}`;

  it('creates an enabled team, generates missing names avoiding taken ones and adds the models to the allowed list', () => {
    const spec = parseTeamSpec(TEMPLATE_SPEC)!;
    const team = applyTeamSpec(undefined, spec, { newId, taken: ['Elena Mark'], seed: 's_1' });
    expect(team.enabled).toBe(true);
    expect(team.allowedModels).toEqual(['ag/claude-sonnet-4-6', 'ag/claude-opus-4-6-thinking', 'ag/gemini-4-argon-high']);
    expect(team.goal).toContain('Endpoint login OTP');
    expect(team.rules).toHaveLength(3);
    // Explicit names are the user's choice and kept; the generated one is unique and female as asked.
    expect(team.members.map(member => member.name).slice(0, 2)).toEqual(['Elena Mark', 'Kaelen Vael']);
    expect(team.members[2]!.name).toMatch(/^\S+ \S+$/);
    expect(team.members[2]!.gender).toBe('female');
    expect(applyTeamSpec(undefined, spec, { newId, taken: ['Elena Mark'], seed: 's_1' }).members[2]!.name).toBe(team.members[2]!.name);
  });

  it('merges members by name into an existing team, keeping ids', () => {
    const current: AgentTeam = { enabled: false, allowedModels: ['old'], members: [{ id: 'm-keep', name: 'elena mark', role: 'Old', models: ['old'] }] };
    const team = applyTeamSpec(current, parseTeamSpec(OTP_SPEC)!, { newId });
    expect(team.members.map(member => [member.id, member.name, member.role])).toEqual([['m-keep', 'elena mark', 'Backend Engineer'], [expect.stringMatching(/^m-/), 'Kaelen Vael', 'Backend Engineer']]);
    expect(team.members[0]!.models).toEqual(['ag/claude-sonnet-4-6']);
    expect(team.allowedModels[0]).toBe('old');
  });

  it('refuses a spec that breaks the team limits with a readable message', () => {
    const blocks = Array.from({ length: 21 }, (_, index) => `Subagent ${index + 1}:\n- Role: R${index}`).join('\n');
    expect(() => applyTeamSpec(undefined, parseTeamSpec(blocks)!, { newId })).toThrow(/The team in this prompt cannot be used: members: at most 20/);
  });
});
