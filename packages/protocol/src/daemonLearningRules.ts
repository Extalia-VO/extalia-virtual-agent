import { array, boolean, count, enumeration, fail, isPlainObject, literal, number, object, optional, rule, type Rule } from './rules.js';
import type { JsonSchema } from './jsonSchema.js';
const string = (max: number, min = 0) => rule((value, path, errors) => {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(path, 'expected bounded text', errors);
}, { type: 'string', minLength: min, maxLength: max });
const union = (...rules: Rule[]) => rule((value, path, errors) => {
  if (!rules.some(r => { const found: string[] = []; r.check(value, path, found); return !found.length; })) fail(path, 'invalid learning variant', errors);
}, { oneOf: rules.map(r => r.schema) });
// Opaque provider-native content and JSON tool arguments are data, never dispatch authority.
const json = rule((value, path, errors) => {
  const visit = (v: unknown, depth: number): boolean => depth <= 16 && (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) || typeof v === 'string' && v.length <= 131072 || Array.isArray(v) && v.length <= 256 && v.every(x => visit(x, depth + 1)) || isPlainObject(v) && Object.keys(v).length <= 128 && Object.entries(v).every(([k,x]) => k.length <= 200 && visit(x, depth + 1)));
  if (!visit(value, 0) || JSON.stringify(value).length > 131072) fail(path, 'expected bounded JSON data', errors);
}, { description: 'JSON data bounded to depth 16, 128 object properties, 256 array items, and 131072 serialized UTF-16 units.' });
const jsonObject = rule((v,p,e) => { if (!isPlainObject(v)) fail(p, 'expected object', e); else json.check(v,p,e); }, { ...json.schema, type: 'object' });
const id = string(200, 1), hash = string(64, 64);
const proposal = object({ name: string(64, 1), description: string(500, 1), instructions: string(65536, 1), sourceUrls: optional(array(string(2048, 1), false, 0, 8)) });
const provenance = object({ sessionId: id, workspaceId: id, promptSha256: hash, profileId: optional(id), runId: optional(id) });
const evidence = object({ id, name: string(200), content: string(2000) });
const rawEvidence = object({ toolCallId: string(200), name: string(200), content: string(65536), isError: boolean });
const tool = object({ name: id, description: string(4000), parameters: jsonObject });
const call = object({ id, name: id, input: jsonObject, inputError: optional(string(2000)) });
const usage = object({ inputTokens: optional(count), outputTokens: optional(count), cachedInputTokens: optional(count) });
const native = object({ api: enumeration(['openai-chat','openai-responses','anthropic-messages']), content: json });
const model = object({ text: string(16000), toolCalls: array(call, false, 0, 16), stop: enumeration(['end','tool_use','max_tokens','refusal','other']), model: optional(string(200)), usage: optional(usage), promptTokens: optional(count), native: optional(native), refusal: optional(string(2000)) });
const message = union(object({ role: literal('user'), text: string(24000) }), object({ role: literal('assistant'), text: string(16000), toolCalls: array(call, false, 0, 16), native: optional(native) }), object({ role: literal('tool'), results: array(object({ toolCallId: id, name: id, content: string(2000), isError: boolean }), false, 0, 16) }));
const effect = union(object({ kind: literal('model'), effectId: id, system: string(4000), messages: array(message, false, 1, 32), tools: array(tool, false, 1, 17) }), object({ kind: literal('read'), effectId: id, callId: id, name: id, input: jsonObject }));
const submission = object({ title: string(200, 1), lesson: string(8000, 1), evidenceIds: array(id, true, 1, 10), skill: optional(proposal) });
const receipt = object({ packageId: id, revisionId: id, state: string(100,1), stateReason: optional(string(200)), created: boolean, inspection: enumeration(['recorded','unavailable']), inspectionOutcome: optional(string(200)), activationPerformed: literal(false), cancellationObserved: boolean });
const note = object({ workspaceId: id, sessionId: id, profileId: id, revision: string(512,1), runId: id, promptSha256: hash, title: string(200,1), lesson: string(8000,1), evidence: array(evidence,false,1,12), skill: optional(receipt) });
const meeting = object({ meetingId: id, topic: string(2000,1), roomId: optional(id), startedAt: string(64,1), completedAt: string(64,1), outcome: enumeration(['completed','failed','cancelled']), participants: array(object({agentId:id,name:string(200,1),role:string(200,1)}),false,2,14), contributions: array(object({agentId:id,round:number(1,true,2),text:string(16000)}),false,0,26) });
const job = object({ jobId: id, status: enumeration(['running','ready','skipped','failed','cancelled','completed']), effect: optional(effect), pendingEffectId: optional(id), submission: optional(submission), evidence: array(evidence,false,0,10), provenance, contentSha256: optional(hash), skillSha256: optional(hash), reason: optional(string(500)), usage: optional(usage) });
const actions: Record<string, [Rule,Rule]> = {
  'evidence.begin': [object({}),object({intakeId:id})],
  'evidence.append': [object({intakeId:id,toolCallId:string(65536),name:string(65536),isError:boolean,chunk:string(65536),final:boolean}),object({complete:boolean})],
  'evidence.release': [object({intakeId:id}),object({released:literal(true)})],
  'vault.ensure': [object({profileId:id}),object({root:string(4096,1)})],
  'note.pin': [object({root:string(4096,1),profileId:id,revision:string(512,1),workspaceId:id,sessionId:id,purpose:enumeration(['learning','meeting'])}),object({pinId:id})],
  'note.prepare': [object({pinId:id,record:union(note,meeting)}),object({draftId:id,path:string(1024,1)})],
  'note.commit': [object({draftId:id}),object({path:string(1024,1)})],
  'note.discard': [object({draftId:id}),object({released:literal(true)})],
  'note.release': [object({pinId:id}),object({released:literal(true)})],
  'skill.normalize': [object({proposal,provenance:optional(provenance)}),object({proposal,provenance:optional(provenance)})],
  'skill.stage': [object({proposal,provenance}),object({stageId:id,path:string(1024,1)})],
  'skill.stageFolder': [object({root:string(4096,1)}),object({stageId:id,path:string(1024,1)})],
  'skill.cleanup': [object({stageId:id}),object({released:literal(true)})],
  'receipt.claim': [object({profileId:id,contentSha256:hash,runId:id}),object({claimed:boolean})],
  'job.begin': [union(object({profileId:id,revision:string(512,1),workspaceId:id,sessionId:id,runId:id,promptSha256:hash,policy:object({enabled:boolean,skills:boolean,notes:boolean}),tools:array(tool,false,0,16),timeoutMs:optional(number(1,true,45000)),evidence:array(rawEvidence,false,0,128)}),object({profileId:id,revision:string(512,1),workspaceId:id,sessionId:id,runId:id,promptSha256:hash,policy:object({enabled:boolean,skills:boolean,notes:boolean}),tools:array(tool,false,0,16),timeoutMs:optional(number(1,true,45000)),intakeId:id})),object({job})],
  'job.advance': [object({jobId:id,effectId:id,completion:union(object({kind:literal('model'),result:model}),object({kind:literal('read'),ok:boolean,output:string(65536)}),object({kind:literal('failed')}))}),object({job})],
  'job.cancel': [object({jobId:id}),object({job})],
  'job.settle': [object({jobId:id,effectId:id}),object({job})],
  'job.finish': [object({jobId:id}),object({job})],
  'job.release': [object({jobId:id}),object({released:literal(true)})],
};
export const learningParams = union(...Object.entries(actions).map(([action,[input]]) => object({action:literal(action),input})));
export const learningResult = union(...Object.entries(actions).map(([action,[,result]]) => {
  const fields = result.schema.properties as Record<string,JsonSchema>;
  return rule((value,path,errors) => { if (!isPlainObject(value) || value.action !== action) { fail(path,'wrong action',errors); return; } const {action: _action,...rest} = value; void _action; result.check(rest,path,errors); }, { ...result.schema, properties: {action:{const:action},...fields}, required:['action',...result.schema.required as string[]] });
}));
export const LEARNING_PARAMS = {'learning.process':learningParams};
export const LEARNING_RESULTS = {'learning.process':learningResult};
export const learningJsonSchemaDefs = () => ({ LearningParams: learningParams.schema, LearningResult: learningResult.schema });
