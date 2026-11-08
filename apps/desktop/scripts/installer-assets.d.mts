export function verifyInstallerArtwork(directory?: string): Promise<void>;
export function prepareInstallerFiles(projectDirectory?: string, mode?: 'preview' | 'notarized'): Promise<string>;
export default function beforePack(context: { packager: { projectDir: string; config: { extraMetadata?: { extaliaMacReleaseMode?: 'preview' | 'notarized' } } } }): Promise<void>;
