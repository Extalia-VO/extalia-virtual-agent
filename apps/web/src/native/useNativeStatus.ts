import { isKnowledgeIndexEvent, type AgentHostApi } from '@extalia/platform';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createNativeStatusMonitor, type NativeStatusView } from './nativeStatusModel';

const REFRESH_ON = new Set(['session.started', 'session.updated', 'session.ended', 'prompt.submitted', 'turn.completed', 'turn.failed', 'approval.requested', 'approval.resolved', 'user.intervention', 'task.created', 'task.completed', 'subagent.spawned', 'subagent.state', 'task.assigned', 'agent.state']);

/** Mounted only while the panel is open. Token/model streaming never schedules reads. */
export function useNativeStatus(agents: AgentHostApi) {
  const [view, setView] = useState<NativeStatusView>({ phase: 'loading' });
  const monitor = useRef<ReturnType<typeof createNativeStatusMonitor> | undefined>(undefined);
  useEffect(() => {
    const current = createNativeStatusMonitor({ ...(typeof agents.nativeStatus === 'function' ? { read: () => agents.nativeStatus!() } : {}), onChange: setView });
    monitor.current = current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = agents.subscribe(event => {
      if (event.source.runtime !== 'extalia-native' || !REFRESH_ON.has(event.body.type) || isKnowledgeIndexEvent(event)) return;
      current.invalidate();
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; current.refresh(); }, 800);
    });
    return () => { clearTimeout(timer); stop(); current.dispose(); monitor.current = undefined; };
  }, [agents]);
  const refresh = useCallback(() => monitor.current?.refresh(), []);
  const recheck = useCallback(() => {
    if (monitor.current?.current().phase !== 'ready' || typeof agents.refreshNativeStatus !== 'function') return false;
    return monitor.current.refresh(() => agents.refreshNativeStatus!());
  }, [agents]);
  const currentView = useCallback((): NativeStatusView => monitor.current?.current() ?? { phase: 'loading' }, []);
  return { view, refresh, recheck, currentView };
}
