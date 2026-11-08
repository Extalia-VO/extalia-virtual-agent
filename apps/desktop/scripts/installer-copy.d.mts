export function installerCopy(): Promise<Readonly<Record<string, string>>>;
export function installerBrand(): Promise<{ symbol: string; gradient: readonly (readonly [number, string])[]; wordmark: string; width: number }>;
export function installerPhotos(): Promise<{ name: string; data: string }[]>;
