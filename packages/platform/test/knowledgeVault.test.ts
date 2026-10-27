import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_METHODS, KNOWLEDGE_EVENT_SESSION_ID, KNOWLEDGE_VAULT_HOST_METHODS, KNOWLEDGE_VAULT_PATH_MAX, isAgentHostMethod, isKnowledgeIndexEvent, normalizeKnowledgeVaultRoot,
} from '../src/index.js';

describe('Knowledge vault setting contract (W5)', () => {
  it('forwards the vault setting methods through Desktop IPC and the Bridge', () => {
    expect(KNOWLEDGE_VAULT_HOST_METHODS).toEqual(['knowledgeSettings', 'setKnowledgeVaultRoot']);
    for (const method of KNOWLEDGE_VAULT_HOST_METHODS) expect(isAgentHostMethod(method)).toBe(true);
    expect(AGENT_HOST_METHODS).toEqual(expect.arrayContaining([...KNOWLEDGE_VAULT_HOST_METHODS]));
  });

  it('accepts null for the default vault and absolute folder paths only', () => {
    expect(normalizeKnowledgeVaultRoot(null)).toBeNull();
    expect(normalizeKnowledgeVaultRoot(undefined)).toBeNull();
    expect(normalizeKnowledgeVaultRoot('/Users/me/Obsidian Vault')).toBe('/Users/me/Obsidian Vault');
    expect(normalizeKnowledgeVaultRoot('  /Users/me/notes  ')).toBe('/Users/me/notes');
    expect(normalizeKnowledgeVaultRoot('C:\\Users\\me\\Vault')).toBe('C:\\Users\\me\\Vault');
    expect(normalizeKnowledgeVaultRoot('\\\\server\\share\\vault')).toBe('\\\\server\\share\\vault');
    expect(() => normalizeKnowledgeVaultRoot('notes')).toThrow(/full path/);
    expect(() => normalizeKnowledgeVaultRoot('./notes')).toThrow(/full path/);
    expect(() => normalizeKnowledgeVaultRoot('')).toThrow(/Choose a folder/);
    expect(() => normalizeKnowledgeVaultRoot(42)).toThrow(/Choose a folder/);
    expect(() => normalizeKnowledgeVaultRoot('/tmp/a\nb')).toThrow(/Invalid folder path/);
    expect(() => normalizeKnowledgeVaultRoot(`/${'a'.repeat(KNOWLEDGE_VAULT_PATH_MAX)}`)).toThrow(/Invalid folder path/);
  });

  it('recognizes the knowledge index hint and nothing else', () => {
    expect(isKnowledgeIndexEvent({ sessionId: KNOWLEDGE_EVENT_SESSION_ID, body: { type: 'session.updated', revision: 'knowledge-3', messageCount: 2 } })).toBe(true);
    expect(isKnowledgeIndexEvent({ sessionId: 's_123', body: { type: 'session.updated', revision: 'r1', messageCount: 2 } })).toBe(false);
    expect(isKnowledgeIndexEvent({ sessionId: KNOWLEDGE_EVENT_SESSION_ID, body: { type: 'session.ended' } })).toBe(false);
  });
});
