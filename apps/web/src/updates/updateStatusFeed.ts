import type { UpdateCapability, UpdateStatus } from '@extalia/platform';

/** Subscribe before reading so an early launch result cannot be missed or overwritten. */
export function subscribeUpdateStatus(updater: UpdateCapability, receive: (status: UpdateStatus) => void): () => void {
  let live = true, pushed = false;
  const stop = updater.onStatus(status => {
    pushed = true;
    if (live) receive(status);
  });
  void updater.status().then(status => {
    if (live && !pushed) receive(status);
  }, () => { /* A later host status or manual check can recover. */ });
  return () => { live = false; stop(); };
}
