export interface ArchivePin { bytes: number; sha256: string }
export interface MaterializedFile { path: string; bytes: number; sha256: string; executable: boolean }
export interface ArchiveEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'hardlink';
  bytes: number;
  executable: boolean;
  link: string;
  sha256: string;
}
export interface ArchiveInventory {
  archiveBytes: number;
  archiveSha256: string;
  materialized: MaterializedFile[];
}
export interface ArchiveIndex extends ArchiveInventory {
  entries: ArchiveEntry[];
  directories: string[];
  materialized: (MaterializedFile & { source: string })[];
}
export function inspectPythonArchive(archivePath: string, pin: ArchivePin): Promise<ArchiveIndex>;
export function materializePythonArchive(archivePath: string, pin: ArchivePin, destination: string): Promise<ArchiveInventory>;
