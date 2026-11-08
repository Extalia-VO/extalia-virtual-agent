import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** The anchor remains a normal link; its deferred target is revealed after React mounts it. */
export function revealSkillManagement(targetId: string): void {
  const panel = document.getElementById('skill-management') as HTMLDetailsElement | null;
  if (!panel) return;
  panel.open = true;
  if (document.getElementById(targetId)) delete panel.dataset.revealTarget;
  else panel.dataset.revealTarget = targetId;
}

/** Mount security/project forms on the first explicit open, then retain their local state. */
export function SkillManagementDisclosure({ summary, defaultOpen = false, children }: {
  summary: string; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [mounted, setMounted] = useState(defaultOpen);
  const panel = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const target = panel.current?.dataset.revealTarget;
    if (!target) return;
    delete panel.current!.dataset.revealTarget;
    document.getElementById(target)?.scrollIntoView({ block: 'start' });
  }, [open, mounted]);
  return <details ref={panel} id="skill-management" className="skill-management" open={open}
    onToggle={event => {
      const expanded = event.currentTarget.open;
      setOpen(expanded);
      if (expanded) setMounted(true);
    }}>
    <summary>{summary}</summary>
    {mounted && children}
  </details>;
}
