/** A retired scene cannot complete a later attempt's loading overlay. */
export function createSceneReadiness(schedule: (ready: () => void) => number, cancel: (frame: number) => void) {
  let generation = 0, frames = 0;
  let active = false, notified = false;
  let pending: number | null = null;
  return {
    mount() { generation++; frames = 0; notified = false; active = true; },
    frame(loading: boolean, ready: () => void) {
      if (!active || notified) return;
      if (loading) { frames = 0; return; }
      if (++frames < 2) return;
      notified = true;
      const attempt = generation;
      const ticket = schedule(() => {
        if (pending === ticket) pending = null;
        if (active && generation === attempt) ready();
      });
      pending = ticket;
    },
    unmount() {
      active = false; generation++;
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}
