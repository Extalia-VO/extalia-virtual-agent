/** Durable configuration has one home; Observe and Import link back to these sections. */
export const SETTINGS_SECTIONS = ['general', 'connections', 'profiles', 'workspaces', 'agent-apps', 'storage', 'system'] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number];

export function availableSettingsSections({ agents, system, profiles = true }: { agents: boolean; system: boolean; profiles?: boolean }): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(section => section === 'general' || (section === 'system' ? system : agents && (section !== 'profiles' || profiles)));
}

export function resolveSettingsSection(requested: SettingsSection | undefined, available: readonly SettingsSection[], editGateFor?: string): SettingsSection {
  if (editGateFor && available.includes('workspaces')) return 'workspaces';
  return requested && available.includes(requested) ? requested : 'general';
}

/** Automatic activation, with a single tab stop and wraparound arrow navigation. */
export function nextSettingsSection(current: SettingsSection, key: string, available: readonly SettingsSection[]): SettingsSection | undefined {
  const index = available.indexOf(current);
  if (key === 'Home') return available[0];
  if (key === 'End') return available[available.length - 1];
  if (key === 'ArrowRight' || key === 'ArrowDown') return available[(index + 1) % available.length];
  if (key === 'ArrowLeft' || key === 'ArrowUp') return available[(index + available.length - 1) % available.length];
  return undefined;
}
