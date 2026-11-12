export function verifyInstallerArtwork(directory?: string): Promise<void>;
export function prepareInstallerFiles(projectDirectory?: string, mode?: 'preview' | 'notarized'): Promise<string>;
export interface DmgLayout {
  window?: { width?: number; height?: number };
  contents: Array<{ path?: string; name?: string; type?: string; x: number; y: number }>;
}
export function configureDmgSupportLayout(dmg: DmgLayout): void;
export default function beforePack(context: { electronPlatformName?: string; packager: { projectDir: string; config: { dmg?: DmgLayout; extraMetadata?: { extaliaMacReleaseMode?: 'preview' | 'notarized' } } } }): Promise<void>;
