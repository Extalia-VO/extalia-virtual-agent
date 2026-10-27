import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { ConnectAgentAppsCard, connectCommand, connectPrompt, formatLastEvent } from '../src/pages/ConnectAgentAppsCard';

describe('connect agent apps helpers', () => {
  it('builds the terminal command and agent prompt for each app', () => {
    expect(connectCommand('codex')).toBe('npx -y extalia-vo@latest connect codex');
    expect(connectCommand('claude')).toBe('npx -y extalia-vo@latest connect claude');
    expect(connectCommand('gemini')).toBe('npx -y extalia-vo@latest connect gemini');
    expect(connectCommand('antigravity')).toBe('npx -y extalia-vo@latest connect antigravity');
    expect(connectCommand('hermes')).toBe('npx -y extalia-vo@latest connect hermes');
    expect(connectPrompt('codex')).toBe(
      'Run `npx -y extalia-vo@latest connect codex --dry-run` and show me its output verbatim. Do not change anything yet. If I reply "apply", run it again with `--yes` and tell me the backup path and the undo command.',
    );
    expect(connectPrompt('claude')).toContain('npx -y extalia-vo@latest connect claude --dry-run');
  });
});

describe('mockHost agent-app connection lifecycle', () => {
  it('plans, applies, tests, disconnects Codex/Claude/Gemini/Antigravity/Hermes hooks and updates privacy settings in memory', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge', hermes: true });
    const agents = platform.capabilities.agents!;

    const initial = await agents.agentAppConnections();
    expect(initial.map(item => [item.app, item.supported, item.installed, item.state])).toEqual([
      ['codex', true, true, 'not-connected'],
      ['claude', true, true, 'not-connected'],
      ['gemini', true, true, 'not-connected'],
      ['antigravity', true, true, 'not-connected'],
      ['hermes', true, true, 'not-connected'],
    ]);

    const plan = await agents.planAgentAppConnect('codex');
    expect(plan.supported).toBe(true);
    expect(plan.changes).toBe(true);
    expect(plan.diff).toContain('extalia:managed');
    expect(plan.needsTrust).toBe(true);

    const applied = await agents.applyAgentAppConnect('codex', { trust: true });
    expect(applied.changed).toBe(true);
    expect(applied.backupPath).toBeTruthy();
    expect(applied.undoCommand).toContain('disconnect codex');
    expect(applied.trust.status).toBe('trusted');
    expect(applied.test.ok).toBe(true);

    const afterConnect = await agents.agentAppConnections();
    const codex = afterConnect.find(item => item.app === 'codex')!;
    expect(codex.connected).toBe(true);
    expect(codex.state).toBe('connected');
    expect(codex.trust.status).toBe('trusted');
    expect(codex.lastEventAt).toBeTruthy();

    const noOpPlan = await agents.planAgentAppConnect('codex');
    expect(noOpPlan.changes).toBe(false);
    expect(noOpPlan.diff).toBe('');

    const tested = await agents.testAgentAppConnection('codex');
    expect(tested).toMatchObject({ ok: true, status: 'delivered' });

    const ingest = await agents.hookIngest();
    expect(ingest.port).toBe(4317);
    expect(ingest.lastEvents.codex).toBeTruthy();
    expect(ingest.labelsOnly).toBe(false);

    const updatedIngest = await agents.setHookPrivacy({
      labelsOnly: true,
      hermesDashboardUrl: 'http://127.0.0.1:9119',
    });
    expect(updatedIngest.labelsOnly).toBe(true);
    expect(updatedIngest.hermesDashboardUrl).toBe('http://127.0.0.1:9119');

    const disconnected = await agents.disconnectAgentApp('codex');
    expect(disconnected.changed).toBe(true);
    expect(disconnected.restoredExactly).toBe(true);
    expect(disconnected.removed).toBeGreaterThan(0);

    const afterDisconnect = await agents.agentAppConnections();
    expect(afterDisconnect.find(item => item.app === 'codex')?.connected).toBe(false);
  });
});

describe('ConnectAgentAppsCard rendering', () => {
  it('renders rows, status badges, preview diff, privacy controls and bilingual copy in English and Indonesian', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const agents = platform.capabilities.agents!;
    const connections = await agents.agentAppConnections();
    const plan = await agents.planAgentAppConnect('codex');
    const ingest = await agents.hookIngest();

    const enHtml = renderToStaticMarkup(
      createElement(ConnectAgentAppsCard, {
        t: MESSAGES.en,
        agents,
        initialConnections: connections,
        initialIngest: ingest,
        initialPlan: plan,
      }),
    );
    expect(enHtml).toContain('Connect agent apps');
    expect(enHtml).toContain('Codex 0.161.0');
    expect(enHtml).toContain('Claude Code 2.1.295');
    expect(enHtml).toContain('Gemini CLI 0.5.0');
    expect(enHtml).toContain('Antigravity 2.0.0');
    expect(enHtml).toContain('/brand/providers/png/antigravity-dark.png');
    expect(enHtml).toContain('/brand/providers/png/antigravity-light.png');
    expect(enHtml).toContain('Hermes Agent');
    expect(enHtml).toContain('Not connected');
    expect(enHtml).toContain('Not installed');
    expect(enHtml).toContain('Copy command');
    expect(enHtml).toContain('Copy prompt');
    expect(enHtml).toContain('Preview Codex hook changes');
    expect(enHtml).toContain('Apply');
    expect(enHtml).toContain('Labels only (hide prompt, reply and tool output text from outside apps)');
    expect(enHtml).toContain('Hermes dashboard URL (optional, read-only)');
    expect(enHtml).toContain('Restart the app after connecting. In Codex, open /hooks and approve the Extalia hooks.');

    await agents.applyAgentAppConnect('claude');
    const connectedList = await agents.agentAppConnections();
    const idHtml = renderToStaticMarkup(
      createElement(ConnectAgentAppsCard, {
        t: MESSAGES.id,
        agents,
        initialConnections: connectedList,
        initialIngest: { ...ingest, labelsOnly: true, hermesDashboardUrl: 'http://127.0.0.1:9119' },
      }),
    );
    expect(idHtml).toContain('Hubungkan aplikasi agent');
    expect(idHtml).toContain('Terhubung');
    expect(idHtml).toContain('Belum terhubung');
    expect(idHtml).toContain('Salin perintah');
    expect(idHtml).toContain('Salin prompt');
    expect(idHtml).toContain('Uji');
    expect(idHtml).toContain('Putuskan');
    expect(idHtml).toContain('Hanya label (sembunyikan teks prompt, balasan, dan output tool dari aplikasi luar)');
    expect(idHtml).toContain('URL dashboard Hermes (opsional, baca-saja)');
    expect(idHtml).toContain('Mulai ulang aplikasi setelah menghubungkan. Di Codex, buka /hooks dan setujui hook Extalia.');

    const claudeConn = connectedList.find(item => item.app === 'claude')!;
    const waiting = formatLastEvent(MESSAGES.en, { ...claudeConn, lastEventAt: undefined }, null);
    expect(waiting).toBe('Waiting for the first event');
    const recent = formatLastEvent(MESSAGES.en, { ...claudeConn, lastEventAt: '2026-10-13T12:00:00.000Z' }, null, Date.parse('2026-10-13T12:00:05.000Z'));
    expect(recent).toBe('Last event 5s ago');
  });
});
