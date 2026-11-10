export interface ScannerTarget { platform: string; arch: string }
export interface ScannerBinding { schema: 'extalia.scanner-distribution.v1'; platform: string; arch: string; daemonSha256: string; manifestSha256: string }
export const SCANNER_BINDING: string;
export function scannerTarget(target: ScannerTarget): string;
export function verifyScannerBundle(root: string, target: ScannerTarget, expectedSha256?: string): Promise<{ manifestSha256: string }>;
export function verifyScannerSignatures(root: string, target: ScannerTarget, requireDeveloperId?: boolean, run?: (command: string, args: string[], options: Record<string, unknown>) => { status: number | null; stdout?: unknown; stderr?: unknown }): Promise<void>;
export function createScannerBinding(binary: string, bundle: string, target: ScannerTarget): Promise<ScannerBinding>;
export function writeScannerBinding(file: string, binding: ScannerBinding): Promise<void>;
export function verifyScannerBinding(options: { binary: string; bundle: string; bindingFile: string; target: ScannerTarget; verifyDaemon?: boolean }): Promise<ScannerBinding>;
export function copyScannerBundle(source: string, destination: string, target: ScannerTarget, expectedSha256?: string): Promise<void>;
