export interface SkillSpectorFile { path: string; bytes: number; sha256: string; executable: boolean }
export interface SkillSpectorManifest {
  schema_version: 1;
  target: { os: 'macos' | 'linux' | 'windows'; arch: 'aarch64' | 'x86_64' };
  runtime_version: string; scanner_version: string; source_commit: string; normalizer_version: string;
  interpreter: string; entry_script: string; files: SkillSpectorFile[];
}
export function verifySkillSpectorBundle(root: string, options?: { expectedSha256?: string; target?: string }): Promise<{ manifestSha256: string; manifest: SkillSpectorManifest; fileCount: number; totalBytes: number }>;
export function buildSkillSpectorBundle(options: { target: string; out: string; uv: string; download?: boolean; runtimeBundle?: string; sourceDirectory?: string; signIdentity?: string; keychain?: string; cacheDirectory?: string; buildPython?: string }): Promise<{ manifestSha256: string; fileCount: number; totalBytes: number; signedFiles: number }>;
