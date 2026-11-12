/** Verified against Codex 0.167.1 and upstream request_user_input_async (2c79ee6). */
export interface CodexAsyncInputRequest {
  callId: string;
  questions: { title: string; options: string[] }[];
  canAnswer: boolean;
  conflicted?: true;
  askedAt?: string;
}
export interface CodexUserInputEvidence {
  requests: CodexAsyncInputRequest[];
  replies: { questionItemId: string; question: string }[];
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const valid = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');
function questions(value: unknown): CodexAsyncInputRequest['questions'] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 10) return undefined;
  const result: CodexAsyncInputRequest['questions'] = [];
  for (const entry of value) {
    const item = record(entry);
    if (!valid(item.title, 2000) || Object.keys(item).some(key => !['title', 'options'].includes(key))) return undefined;
    if (item.options !== undefined && item.options !== null && (!Array.isArray(item.options) || !item.options.length || item.options.length > 20 || item.options.some(option => !valid(option, 1000)))) return undefined;
    result.push({ title: item.title, options: item.options as string[] ?? [] });
  }
  return result;
}
function json(value: unknown): unknown { if (typeof value !== 'string' || value.length > 64_000) return undefined; try { return JSON.parse(value); } catch { return undefined; } }

/** Read the already decoded rollout rows; ordinary work and turn completion never resolve a question. */
export function codexUserInputEvidence(rows: readonly Record<string, unknown>[]): CodexUserInputEvidence {
  const requests = new Map<string, CodexAsyncInputRequest>(), replies = new Map<string, { questionItemId: string; question: string }>();
  const mirrors: CodexAsyncInputRequest[] = [];
  const conflicts = new Set<string>();
  const put = (item: CodexAsyncInputRequest) => {
    const previous = requests.get(item.callId);
    if (previous && JSON.stringify(previous.questions) !== JSON.stringify(item.questions)) conflicts.add(item.callId);
    if (!previous && requests.size >= 128) requests.delete(requests.keys().next().value!);
    requests.set(item.callId, { ...item, canAnswer: !conflicts.has(item.callId) && (item.canAnswer || previous?.canAnswer === true), ...(conflicts.has(item.callId) ? { conflicted: true as const } : {}) });
  };
  for (const [index, row] of rows.entries()) {
    const payload = record(row.payload);
    const at = typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : undefined;
    if (row.type === 'response_item' && payload.type === 'function_call' && payload.name === 'request_user_input_async' && valid(payload.call_id, 200)) {
      const args = record(json(payload.arguments)), parsed = questions(args.questions);
      if (parsed && Object.keys(args).length === 1) put({ callId: payload.call_id, questions: parsed, canAnswer: false, ...(at ? { askedAt: at } : {}) });
    }
    if (row.type === 'response_item' && payload.type === 'function_call_output' && valid(payload.call_id, 200)) {
      const pending = requests.get(payload.call_id);
      if (pending && !conflicts.has(payload.call_id) && record(json(payload.output)).accepted === true) pending.canAnswer = true;
    }
    // The legacy agent_message mirror has no item id. Only the completed TurnItem proves call identity.
    const item = row.type === 'event_msg' && payload.type === 'item_completed' ? record(payload.item) : {};
    if (item.type === 'AgentMessage' && item.delivery === 'async' && valid(item.id, 200)) {
      const parsed = questions(item.questions);
      if (parsed) put({ callId: item.id, questions: parsed, canAnswer: true, ...(at ? { askedAt: at } : {}) });
    }
    if (row.type === 'event_msg' && payload.type === 'agent_message' && payload.delivery === 'async') {
      const parsed = questions(payload.questions);
      if (parsed) { if (mirrors.length >= 128) mirrors.shift(); mirrors.push({ callId: `unbound:${index}`, questions: parsed, canAnswer: false, ...(at ? { askedAt: at } : {}) }); }
    }
    const userText = row.type === 'event_msg' && payload.type === 'user_message' ? payload.message
      : row.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)
        ? payload.content.map(part => record(part).text ?? '').join('\n') : undefined;
    if (typeof userText !== 'string' || userText.length > 64_000) continue;
    const match = /^\s*<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>\s*$/.exec(userText);
    const answers = match ? json(match[1]) : undefined;
    if (!Array.isArray(answers) || answers.length > 10) continue;
    for (const answer of answers) {
      const item = record(answer);
      if (valid(item.questionItemId, 512) && valid(item.question, 2000) && valid(item.answer, 4000)) { const key = JSON.stringify([item.questionItemId, item.question]); if (!replies.has(key) && replies.size >= 1280) replies.delete(replies.keys().next().value!); replies.set(key, { questionItemId: item.questionItemId, question: item.question }); }
    }
  }
  const signatures = new Set([...requests.values()].map(item => JSON.stringify(item.questions)));
  for (const item of mirrors) if (!signatures.has(JSON.stringify(item.questions)) && requests.size < 128) requests.set(item.callId, item);
  return { requests: [...requests.values()], replies: [...replies.values()] };
}
