import { createHash } from 'node:crypto';
import type { ModelMessage } from '@extalia/runtime';

interface HandoverMessage {
  role: 'user'; text: string;
  /** Host-only metadata. Providers serialize known ModelMessage fields, never this marker. */
  extaliaHandover: { operationId: string; digest: string };
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Replace only previously host-marked capsules; genuine conversation and immutable event history stay intact. */
export function replaceHandoverHistory(history: readonly ModelMessage[], packet: string, operationId: string): ModelMessage[] {
  const retained = history.filter(message => {
    const marker = (message as Partial<HandoverMessage>).extaliaHandover;
    return message.role !== 'user' || !marker || typeof marker.operationId !== 'string' || marker.digest !== digest(message.text);
  });
  const context: HandoverMessage = { role: 'user', text: packet, extaliaHandover: { operationId, digest: digest(packet) } };
  return [...retained, context];
}
