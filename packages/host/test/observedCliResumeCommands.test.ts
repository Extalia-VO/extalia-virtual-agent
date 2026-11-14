import { describe, expect, it } from 'vitest';
import { resumeArguments, resumeEnvironment } from '../src/observedCliResumeCommands.js';

const archive = { command: '/runtime/node', args: ['/runtime/reader.mjs', 'bound-reader'], env: { READER_MODE: 'readonly' } };
const target = { nativeSessionId: 'existing-native-id', profilePath: '/temporary/.profile', model: 'saved-model' };
describe('official CLI invocation boundaries', () => {
  it.each(['codex', 'claude', 'gemini'] as const)('preserves native identity and model defaults without permission bypass for %s', family => {
    const args = resumeArguments({ ...target, family }, archive);
    if (family === 'claude') expect(args).not.toContain('--model');
    else expect(args).toContain('saved-model');
    if (family !== 'gemini') expect(args).toContain('existing-native-id');
    expect(args.join(' ')).not.toMatch(/--last|--fork|--new-session|bypass|dangerous|skip-trust|--yolo|--permission-mode/);
  });
  it.each(['codex', 'gemini'] as const)('rejects malformed or flag-shaped reported model metadata for %s', family => {
    for (const model of ['', ' ', '--yolo', ' \t--flag', 'bad\0model', 'bad\rmodel', 'bad\nmodel', 'x'.repeat(201)]) expect(() => resumeArguments({ ...target, family, model })).toThrow('Invalid reviewed native model');
    const args = resumeArguments({ ...target, family, model: 'example-router/selected-model' });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'example-router/selected-model']);
  });
  it('does not replace a Claude provider route with its canonical transcript model', () => {
    const args = resumeArguments({ ...target, family: 'claude', model: 'claude-sonnet-4-6' });
    expect(args).toContain('existing-native-id'); expect(args).not.toContain('--model'); expect(args).not.toContain('claude-sonnet-4-6');
    const env = resumeEnvironment({ ...target, family: 'claude', model: 'claude-sonnet-4-6' }, { ANTHROPIC_MODEL: 'example-router/claude-sonnet-4-6' }, '/temporary/profile-root');
    expect(env.ANTHROPIC_MODEL).toBe('example-router/claude-sonnet-4-6'); expect(env.CLAUDE_CONFIG_DIR).toBe(target.profilePath);
    expect(resumeEnvironment({ ...target, family: 'claude' }, {}, '/temporary/profile-root').ANTHROPIC_MODEL).toBeUndefined();
  });
  it('uses only a trusted explicit Claude request model without guessing from reported model', () => {
    const args = resumeArguments({ ...target, family: 'claude', model: 'claude-sonnet-4-6', resumeModel: 'example-router/claude-sonnet-4-6' });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'example-router/claude-sonnet-4-6']);
    expect(args).not.toContain('claude-sonnet-4-6'); expect(args).toContain('existing-native-id');
    for (const resumeModel of ['', ' ', '--yolo', ' -bad', 'bad\nmodel']) expect(() => resumeArguments({ ...target, family: 'claude', resumeModel })).toThrow('Invalid reviewed native model');
    expect(resumeArguments({ ...target, family: 'gemini', resumeModel: 'unrelated-selection' })).not.toContain('unrelated-selection');
  });
  it('preserves explicit native Claude alias mappings without constructing a provider route', () => {
    const aliases = { ANTHROPIC_DEFAULT_MODEL: 'example/default', ANTHROPIC_DEFAULT_SONNET_MODEL: 'example/sonnet', ANTHROPIC_DEFAULT_OPUS_MODEL: 'example/opus', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'example/haiku', ANTHROPIC_DEFAULT_FABLE_MODEL: 'example/fable' };
    const env = resumeEnvironment({ ...target, family: 'claude', resumeModel: 'sonnet' }, aliases, '/temporary/profile-root');
    for (const [key, value] of Object.entries(aliases)) expect(env[key]).toBe(value);
    const args = resumeArguments({ ...target, family: 'claude', resumeModel: 'sonnet' });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'sonnet']);
    expect(args).not.toContain('example/sonnet');
    expect(resumeEnvironment({ ...target, family: 'codex' }, aliases, '/temporary/profile-root').ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
  });
  it('injects exactly the two scoped readonly tools and explicit Codex per-tool approval', () => {
    const args = resumeArguments({ ...target, family: 'codex' }, archive).join(' ');
    expect(args).toContain('mcp_servers.extalia_handover.enabled_tools=["extalia_continuity_status","extalia_continuity_read"]');
    expect(args).toContain('extalia_continuity_status.approval_mode="approve"');
    expect(args).toContain('extalia_continuity_read.approval_mode="approve"');
    const claude = resumeArguments({ ...target, family: 'claude' }, archive);
    expect(claude.slice(claude.indexOf('--allowedTools') + 1)).toEqual(['mcp__extalia_handover__extalia_continuity_status', 'mcp__extalia_handover__extalia_continuity_read']);
    expect(claude).not.toContain('--strict-mcp-config');
  });
  it.each(['codex', 'claude', 'gemini'] as const)('does not forward another runtime credential to %s', family => {
    const source = { PATH: '/runtime/bin', CODEX_API_KEY: 'codex', OPENAI_API_KEY: 'openai', ANTHROPIC_AUTH_TOKEN: 'claude', GEMINI_API_KEY: 'gemini', EXTALIA_SECRET: 'private', PROVIDER_SECRET: 'private' };
    const env = resumeEnvironment({ ...target, family }, source, '/temporary/home');
    expect(env.HOME).toBe('/temporary/home'); expect(env.EXTALIA_SECRET).toBeUndefined(); expect(env.PROVIDER_SECRET).toBeUndefined();
    if (family !== 'codex') { expect(env.CODEX_API_KEY).toBeUndefined(); expect(env.OPENAI_API_KEY).toBeUndefined(); }
    if (family !== 'claude') expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    if (family !== 'gemini') expect(env.GEMINI_API_KEY).toBeUndefined();
  });
  it('uses Gemini home parent and leaves an unknown model to the source runtime', () => {
    expect(resumeEnvironment({ ...target, family: 'gemini', profilePath: '/temporary/profile-root/.gemini' }, {}, '/temporary/profile-root').GEMINI_CLI_HOME).toBe('/temporary/profile-root');
    expect(resumeArguments({ family: 'codex', nativeSessionId: target.nativeSessionId, profilePath: target.profilePath })).not.toContain('--model');
  });
  it('preserves Claude Bedrock and Vertex provider selection and scoped credential sources', () => {
    const source = { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'example', AWS_REGION: 'us-east-1', AWS_SESSION_TOKEN: 'temporary',
      AWS_CONFIG_FILE: '/temporary/aws-config', ANTHROPIC_BEDROCK_BASE_URL: 'https://example.com/bedrock', CLAUDE_CODE_USE_VERTEX: '0',
      ANTHROPIC_VERTEX_PROJECT_ID: 'example-project', CLOUD_ML_REGION: 'global', GOOGLE_APPLICATION_CREDENTIALS: '/temporary/adc.json',
      CLOUDSDK_CONFIG: '/temporary/gcloud', GEMINI_API_KEY: 'unrelated' };
    const env = resumeEnvironment({ ...target, family: 'claude' }, source, '/temporary/home');
    for (const [key, value] of Object.entries(source)) if (key !== 'GEMINI_API_KEY') expect(env[key]).toBe(value);
    expect(env.GEMINI_API_KEY).toBeUndefined();
    const codex = resumeEnvironment({ ...target, family: 'codex' }, source, '/temporary/home');
    expect(codex.AWS_SESSION_TOKEN).toBeUndefined(); expect(codex.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });
  it('preserves Gemini Vertex/GCA selection, project and ADC without adding a provider selection', () => {
    const source = { GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_GENAI_USE_GCA: 'false', GOOGLE_CLOUD_PROJECT: 'example-project',
      GOOGLE_CLOUD_LOCATION: 'global', GOOGLE_APPLICATION_CREDENTIALS: '/temporary/adc.json', CLOUDSDK_CONFIG: '/temporary/gcloud',
      GOOGLE_CLOUD_ACCESS_TOKEN: 'temporary', AWS_SECRET_ACCESS_KEY: 'unrelated', ANTHROPIC_AUTH_TOKEN: 'unrelated' };
    const env = resumeEnvironment({ ...target, family: 'gemini' }, source, '/temporary/home');
    for (const key of ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG', 'GOOGLE_CLOUD_ACCESS_TOKEN']) expect(env[key]).toBe(source[key as keyof typeof source]);
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined(); expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(resumeEnvironment({ ...target, family: 'gemini' }, {}, '/temporary/home').GOOGLE_GENAI_USE_VERTEXAI).toBeUndefined();
    expect(resumeEnvironment({ ...target, family: 'claude' }, {}, '/temporary/home').CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });
  it('forwards only exact credential keys bound to the reviewed Codex provider', () => {
    const source = { EXAMPLE_ROUTER_KEY: 'selected', OTHER_ROUTER_KEY: 'unselected', EXTALIA_SECRET: 'private' };
    expect(resumeEnvironment({ ...target, family: 'codex', credentialEnvironmentKeys: ['EXAMPLE_ROUTER_KEY'] }, source, '/temporary/home').EXAMPLE_ROUTER_KEY).toBe('selected');
    const env = resumeEnvironment({ ...target, family: 'codex', credentialEnvironmentKeys: ['EXAMPLE_ROUTER_KEY'] }, source, '/temporary/home');
    expect(env.OTHER_ROUTER_KEY).toBeUndefined(); expect(env.EXTALIA_SECRET).toBeUndefined();
    expect(resumeEnvironment({ ...target, family: 'claude', credentialEnvironmentKeys: ['EXAMPLE_ROUTER_KEY'] }, source, '/temporary/home').EXAMPLE_ROUTER_KEY).toBeUndefined();
    expect(() => resumeEnvironment({ ...target, family: 'codex', credentialEnvironmentKeys: ['bad\nkey'] }, source, '/temporary/home')).toThrow('Invalid reviewed provider');
    expect(() => resumeEnvironment({ ...target, family: 'codex', credentialEnvironmentKeys: Array.from({ length: 9 }, (_, i) => `KEY_${i}`) }, source, '/temporary/home')).toThrow('Invalid reviewed provider');
  });

});
