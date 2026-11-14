import path from 'node:path';
import type { ObservedCliFamily } from '@extalia/platform';

export interface ResumeArchiveCommand { command: string; args: string[]; env?: Record<string, string> }
export interface ResumeCommandTarget { family: ObservedCliFamily; nativeSessionId: string; profilePath: string; model?: string; resumeModel?: string; credentialEnvironmentKeys?: string[] }
const tools = ['extalia_continuity_status', 'extalia_continuity_read'];
function modelArguments(model: string | undefined): string[] {
  if (model === undefined) return [];
  if (typeof model !== 'string' || !model.trim() || model.length > 200 || /^\s*-/.test(model) || /[\0\r\n]/.test(model)) throw new Error('Invalid reviewed native model selection.');
  return ['--model', model];
}

/** Invocation-local readers; no native profile or permissions are rewritten. */
export function resumeArguments(target: ResumeCommandTarget, archive?: ResumeArchiveCommand): string[] {
  const model = target.family === 'claude' ? [] : modelArguments(target.model);
  if (target.family === 'gemini') return ['--acp', ...model];
  if (target.family === 'claude') {
    // Canonical transcript models cannot identify a provider route. Only an exact
    // selection read from reviewed native configuration may override resume state.
    const args = ['-p', '--resume', target.nativeSessionId, '--output-format', 'stream-json', '--verbose', ...modelArguments(target.resumeModel)];
    if (archive) args.push('--mcp-config', JSON.stringify({ mcpServers: { extalia_handover: { type: 'stdio', ...archive } } }),
      '--allowedTools', ...tools.map(tool => `mcp__extalia_handover__${tool}`));
    return args;
  }
  const args = ['exec', 'resume', '--json', ...model];
  if (archive) {
    const server = 'mcp_servers.extalia_handover';
    args.push('-c', `${server}.command=${JSON.stringify(archive.command)}`, '-c', `${server}.args=${JSON.stringify(archive.args)}`,
      '-c', `${server}.enabled_tools=${JSON.stringify(tools)}`);
    for (const tool of tools) args.push('-c', `${server}.tools.${tool}.approval_mode="approve"`);
    for (const [key, value] of Object.entries(archive.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid archive environment key.');
      args.push('-c', `${server}.env.${key}=${JSON.stringify(value)}`);
    }
  }
  return [...args, target.nativeSessionId, '-'];
}
/** Do not leak credentials belonging to unrelated providers into another CLI. */
export function resumeEnvironment(target: ResumeCommandTarget, source: Readonly<Record<string, string | undefined>>, homeDirectory: string): Record<string, string> {
  const common = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];
  // Native provider selectors and credentials remain scoped to the selected CLI.
  // Values are inherited only when present: Extalia never selects a new provider here.
  const google = ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GCLOUD_PROJECT', 'CLOUDSDK_CONFIG'];
  const auth = target.family === 'codex' ? ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']
    : target.family === 'claude' ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
      'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
      'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_SDK_LOAD_CONFIG',
      'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', ...google]
      : ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_KEY_AUTH_MECHANISM',
        'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA', 'GOOGLE_CLOUD_ACCESS_TOKEN', ...google];
  const selectedKeys = target.family === 'codex' ? target.credentialEnvironmentKeys ?? [] : [];
  if (selectedKeys.length > 8 || selectedKeys.some(key => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))) throw new Error('Invalid reviewed provider credential environment key.');
  const result: Record<string, string> = { HOME: homeDirectory, USERPROFILE: homeDirectory };
  for (const key of [...common, ...auth, ...selectedKeys]) if (source[key] !== undefined) result[key] = source[key]!;
  if (target.family === 'codex') result.CODEX_HOME = target.profilePath;
  if (target.family === 'claude') result.CLAUDE_CONFIG_DIR = target.profilePath;
  if (target.family === 'gemini') result.GEMINI_CLI_HOME = path.basename(target.profilePath) === '.gemini' ? path.dirname(target.profilePath) : target.profilePath;
  return result;
}
