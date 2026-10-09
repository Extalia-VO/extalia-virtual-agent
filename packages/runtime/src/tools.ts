import type { ActivityKind, EventBody, FileChangeKind, RiskLevel } from '@extalia/protocol';

/** JSON Schema subset used for tool parameters. Kept small so every provider accepts it. */
export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: readonly string[];
  items?: JsonSchemaProperty;
  minimum?: number;
  maximum?: number;
}

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: false;
}

/**
 * What a tool touches. The permission policy decides per access level:
 * `read` (inside the workspace) and `memory`/`meta` (Extalia's own data) are
 * allowed; `write` and `execute` follow the workspace permissions.
 */
export type ToolAccess = 'read' | 'write' | 'execute' | 'memory' | 'meta';

export interface ToolDescription {
  /** Short, single-line, already redacted. Shown in timelines and the office. */
  label: string;
  target?: string;
  /** Extra context for approval prompts (for example the full command). */
  detail?: string;
  risk?: RiskLevel;
}

export interface ToolOutcome {
  ok: boolean;
  /** Text returned to the model. Tools bound their own output. */
  output: string;
  /** Files the tool changed, reported as `file.written` events. */
  files?: { path: string; change: FileChangeKind }[];
}

export interface ToolRunContext {
  signal: AbortSignal;
  toolCallId: string;
  /** Emit additional protocol events (for example `command.output`). */
  emit(body: EventBody): void;
}

export interface ToolDefinition<Input = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  access: ToolAccess;
  kind: ActivityKind;
  /** Consecutive calls of parallel tools in one model response run concurrently (they never need approval). */
  parallel?: boolean;
  describe(input: Input): ToolDescription;
  run(input: Input, context: ToolRunContext): Promise<ToolOutcome>;
}

/** A tool with its input type erased, for registries. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any>;

/** Validate model-supplied arguments against a tool schema. Returns problems, empty when valid. */
export function validateArguments(schema: JsonSchemaObject, input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['Arguments must be a JSON object.'];
  const record = input as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of schema.required ?? []) if (record[key] === undefined) problems.push(`Missing "${key}".`);
  for (const [key, value] of Object.entries(record)) {
    const property = schema.properties[key];
    if (!property) {
      if (schema.additionalProperties === false) problems.push(`Unknown argument "${key}".`);
      continue;
    }
    const problem = checkValue(property, value);
    if (problem) problems.push(`"${key}" ${problem}`);
  }
  return problems;
}

function checkValue(property: JsonSchemaProperty, value: unknown): string | undefined {
  switch (property.type) {
    case 'string':
      if (typeof value !== 'string') return 'must be a string.';
      if (property.enum && !property.enum.includes(value)) return `must be one of ${property.enum.join(', ')}.`;
      return undefined;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number.';
      if (property.type === 'integer' && !Number.isInteger(value)) return 'must be an integer.';
      if (property.minimum !== undefined && value < property.minimum) return `must be at least ${property.minimum}.`;
      if (property.maximum !== undefined && value > property.maximum) return `must be at most ${property.maximum}.`;
      return undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be true or false.';
    case 'array':
      if (!Array.isArray(value)) return 'must be an array.';
      if (property.items) for (const item of value) { const problem = checkValue(property.items, item); if (problem) return `items ${problem}`; }
      return undefined;
    case 'object':
      return value && typeof value === 'object' && !Array.isArray(value) ? undefined : 'must be an object.';
  }
}
