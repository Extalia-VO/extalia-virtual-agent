/**
 * System prompt for the Extalia Native agent. Stable content comes first so
 * providers that cache prompt prefixes can reuse it across turns.
 */
export interface PromptContext {
  workspace: { name: string; root: string };
  platform: { os: string; shell: string };
  /** Project instruction files found in the workspace root (AGENTS.md, CLAUDE.md, …). */
  projectInstructions?: { file: string; text: string }[];
  /** Present when Extalia memory is enabled for the connection. */
  memory?: { name: string; summary: string }[];
  /** Present when Extalia skills are enabled for the connection. */
  skills?: { name: string; description: string }[];
  /** Present when the agent can delegate to worker agents. */
  orchestration?: { maxDelegations: number };
}

const INSTRUCTION_LIMIT = 12_000;

export function buildSystemPrompt(context: PromptContext): string {
  const sections = [
    `You are the Extalia agent, a software engineer working in the user's project "${context.workspace.name}". ` +
      `The project root is ${context.workspace.root}. Paths you pass to tools are relative to it, and you cannot read or change anything outside it. ` +
      `Commands run there with ${context.platform.shell} on ${context.platform.os}, with a time limit and without the user's credentials.`,
    [
      'How to work:',
      '- Look before you change: read the relevant files and search the code instead of guessing.',
      '- Make focused changes that fit the existing style, then verify them (run the project\'s tests or checks when they exist).',
      '- The user may need to approve edits and commands. If an action is declined, continue without it or explain what you need.',
      '- Never print or store secrets. Credential files are not available to you.',
      '- Finish with a short summary of what you changed, how you verified it, and anything left to do.',
    ].join('\n'),
  ];

  if (context.orchestration) {
    sections.push(
      'You can delegate with delegate_task: hand self-contained, read-only work (broad research, reviews, independent questions) to worker agents, ' +
        'several at once when the questions are independent. Pick the tier by difficulty (quick, standard, complex). Workers cannot edit or run commands; ' +
        `you apply changes and remain responsible for the result. Delegate only when it saves effort, at most ${context.orchestration.maxDelegations} times per turn.`,
    );
  }

  if (context.projectInstructions?.length) {
    const blocks = context.projectInstructions.map(item => {
      const text = item.text.length > INSTRUCTION_LIMIT ? `${item.text.slice(0, INSTRUCTION_LIMIT)}\n[truncated]` : item.text;
      return `<project-instructions file="${item.file}">\n${text}\n</project-instructions>`;
    });
    sections.push(`The project defines its own conventions. Follow them unless they conflict with the rules above.\n${blocks.join('\n')}`);
  }

  if (context.memory) {
    const notes = context.memory.length
      ? context.memory.map(note => `- ${note.name}: ${note.summary}`).join('\n')
      : '(no notes yet)';
    sections.push(
      'Extalia keeps workspace memory across sessions. Read a note with memory_read when it is relevant; save durable facts (decisions, conventions, ' +
        `where things live) with memory_write. Keep notes short and never store secrets.\nNotes:\n${notes}`,
    );
  }

  if (context.skills?.length) {
    sections.push(
      'Skills are step-by-step procedures. When a request matches one, load it with skill_read before starting and follow it.\n' +
        context.skills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n'),
    );
  }

  return sections.join('\n\n');
}
