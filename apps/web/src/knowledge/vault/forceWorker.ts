import { createSimCore } from './simCore';
import { decodeCommand } from './simProtocol';

/** The vault graph's force simulation, off the main thread. */
interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}
const scope = self as unknown as WorkerScope;
const core = createSimCore({
  post: ({ message, transfer }) => scope.postMessage(message, transfer),
  schedule: run => { setTimeout(run, 0); },
  now: () => performance.now(),
});
scope.onmessage = event => {
  const command = decodeCommand(event.data);
  if (command) core.handle(command);
};
