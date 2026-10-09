#!/usr/bin/env node
/**
 * Public-repository safety scan (PRD §4, §36 "Portability" and "Privacy").
 *
 * Fails on files that would publish personal or secret data:
 * - absolute home-directory paths with a real-looking user name;
 * - e-mail addresses outside documentation/example domains;
 * - common credential formats;
 * - tracked .env files;
 * - maintainer-defined private terms, read from the untracked file
 *   `.extalia-private-terms` (one term per line) or EXTALIA_PRIVATE_TERMS
 *   (comma-separated). Those terms never need to be committed themselves.
 *
 * Intentional fake credentials in tests go on a line containing
 * `extalia-allow-secret`.
 */
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './workspace.mjs';

const PLACEHOLDER_USERS = new Set(['someone', 'user', 'username', 'runner', 'me', 'you', 'example', 'name', 'shared', 'public', 'default', 'admin', 'jane', 'john', 'alice', 'bob']);
const ALLOWED_EMAIL_DOMAINS = [/(^|\.)example\.(com|org|net)$/i, /(^|\.)users\.noreply\.github\.com$/i, /^noreply\.github\.com$/i, /^github\.com$/i];
const THIRD_PARTY_TEXTS = new Set(['apps/web/public/fonts/Righteous-OFL.txt']);
const SKIP = [/^pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|webp|ico|glb|gltf|woff2?|ttf|otf|zip)$/i];

const HOME_PATHS = [
  /\/Users\/([A-Za-z0-9._-]+)/g,
  /\/home\/([A-Za-z0-9._-]+)/g,
  /[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)([A-Za-z0-9._-]+)/g,
];
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk)-(?:proj-|live-|ant-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/,
];

async function listFiles() {
  try {
    const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' });
    return output.split('\0').filter(Boolean);
  } catch {
    console.error('Public safety check needs git to list repository files.');
    process.exit(2);
  }
}

async function privateTerms() {
  const terms = (process.env.EXTALIA_PRIVATE_TERMS ?? '').split(',');
  try { terms.push(...(await readFile(path.join(ROOT, '.extalia-private-terms'), 'utf8')).split(/\r?\n/)); } catch { /* optional */ }
  return [...new Set(terms.map(term => term.trim()).filter(term => term && !term.startsWith('#')))];
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findings = [];
const terms = (await privateTerms()).map(term => ({ term, pattern: new RegExp(`(^|[^A-Za-z0-9])${escape(term)}($|[^A-Za-z0-9])`, 'i') }));
const files = await listFiles();

for (const file of files) {
  if (/(^|\/)\.env($|\.)/.test(file) && !file.endsWith('.env.example')) findings.push(`${file}: environment files must not be committed.`);
  if (SKIP.some(pattern => pattern.test(file))) continue;
  const full = path.join(ROOT, file);
  let info;
  try { info = await stat(full); } catch { continue; }
  if (!info.isFile() || info.size > 2_000_000) continue;
  const text = await readFile(full, 'utf8');
  if (text.includes('\0')) continue;
  const thirdParty = THIRD_PARTY_TEXTS.has(file);
  text.split(/\r?\n/).forEach((line, index) => {
    const at = `${file}:${index + 1}`;
    for (const pattern of HOME_PATHS) {
      for (const match of line.matchAll(pattern)) {
        if (!PLACEHOLDER_USERS.has(match[1].toLowerCase())) findings.push(`${at}: personal home path "${match[0]}". Use a placeholder such as /Users/<name>.`);
      }
    }
    if (!thirdParty) {
      for (const match of line.matchAll(EMAIL)) {
        if (!ALLOWED_EMAIL_DOMAINS.some(domain => domain.test(match[1]))) findings.push(`${at}: e-mail address "${match[0]}".`);
      }
    }
    if (!line.includes('extalia-allow-secret') && SECRETS.some(pattern => pattern.test(line))) findings.push(`${at}: looks like a credential.`);
    for (const { term, pattern } of terms) if (pattern.test(line)) findings.push(`${at}: private term "${term}".`);
  });
}

if (findings.length) {
  console.error(`Public safety check failed (${findings.length}):\n- ${findings.join('\n- ')}`);
  process.exit(1);
}
console.log(`Public safety check passed for ${files.length} files${terms.length ? ` (${terms.length} private terms)` : ''}.`);
