export interface InstallerArtSpec { name: string; width: number; height: number; format: string }
export const INSTALLER_ART: InstallerArtSpec[];
export function installerArtwork(spec: InstallerArtSpec, copy: Readonly<Record<string, string>>, brand: { symbol: string; gradient: readonly (readonly [number, string])[]; wordmark: string }, photos?: { name: string; data: string }[]): string;
