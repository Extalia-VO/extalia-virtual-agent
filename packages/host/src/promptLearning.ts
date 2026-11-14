export function hasLearningSourceLink(prompt: string): boolean {
  return /https?:\/\/[^\s<>"'`]+/iu.test(prompt);
}

/** A current-message refusal also suppresses the profile curator's skill output. */
export function excludesSkillLearning(prompt: string): boolean {
  const first = prompt.trim().split(/[\r\n]/u, 1)[0]!.slice(0, 1_000);
  return /(?:do\s+not|don't|never|jangan|tanpa)\s+(?:save|store|create|add|learn|simpan|menyimpan|buat|membuat|tambahkan|pelajari)[^.!?\n]{0,60}\bskills?\b/iu.test(first);
}

/** Current user-message admission metadata, never a scan of history or source files. */
export function learningSourceUrls(prompt: string): string[] {
  const urls = new Set<string>();
  for (const match of prompt.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
    const value = match[0].replace(/[),.;!?\]}]+$/u, '');
    if (value.length > 2_048) continue;
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search) continue;
      url.hash = '';
      urls.add(url.href);
      if (urls.size === 8) break;
    } catch { /* Malformed source text is not a network destination. */ }
  }
  return [...urls];
}

/** A direct learning request, rather than instructions quoted by a document or model. */
export function requestsSkillLearning(prompt: string): boolean {
  const first = prompt.trim().split(/[\r\n]/u, 1)[0]!.slice(0, 1_000);
  const prefix = '(?:(?:please|tolong|mohon|silakan|silahkan)\\s+|(?:can|could|would)\\s+you\\s+|bisa(?:kah)?(?:\\s+(?:kamu|anda))?\\s+)?';
  const directLearning = new RegExp(`^${prefix}(?:learn|study|pelajari|belajarlah)\\b`, 'iu').test(first);
  const directSave = new RegExp(`^${prefix}(?:create|save|add|update|buat(?:kan)?|simpan|tambahkan|perbarui)\\s+(?:(?:a|an|new|user|my|sebuah|satu)\\s+){0,3}skills?\\b`, 'iu').test(first);
  if (!directSave && !directLearning) return false;
  // Respect an explicit instruction to keep the current material out of the library.
  if (excludesSkillLearning(prompt)) return false;
  return directSave || /\bskills?\b/iu.test(first) || hasLearningSourceLink(prompt);
}
