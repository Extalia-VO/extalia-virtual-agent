import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Messages } from '../i18n';
import { dagLevels, type TaskTone } from './missionModel';

export interface DagNode {
  /** Stable key (React and connector lookup). */
  key: string;
  id: string;
  title: string;
  dependsOn: readonly string[];
  meta?: ReactNode;
  tone?: TaskTone;
  status?: ReactNode;
  invalid?: boolean;
}

/**
 * Tasks in dependency columns (one column per step) with drawn connectors. On narrow screens the
 * columns stack and connectors run top to bottom. Connectors are decorative: every card also states
 * what it waits for in text, so nothing depends on seeing the lines.
 */
export function MissionDag({ t, nodes, selectedKey, onSelect, label }: {
  t: Messages;
  nodes: readonly DagNode[];
  selectedKey?: string | undefined;
  onSelect?: ((key: string) => void) | undefined;
  label: string;
}) {
  const p = t.missions.plan;
  const inner = useRef<HTMLDivElement>(null);
  const arrow = `mission-dag-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [lines, setLines] = useState<{ paths: { d: string; key: string }[]; width: number; height: number }>({ paths: [], width: 0, height: 0 });
  const columns = dagLevels(nodes);
  const signature = nodes.map(node => `${node.key}:${node.id}:${node.dependsOn.join(',')}`).join('|');

  useLayoutEffect(() => {
    const element = inner.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      const rects = new Map<string, DOMRect>();
      for (const card of element.querySelectorAll<HTMLElement>('[data-dag-id]')) if (!rects.has(card.dataset.dagId!)) rects.set(card.dataset.dagId!, card.getBoundingClientRect());
      const paths: { d: string; key: string }[] = [];
      const sources = [...new Set(nodes.flatMap(node => node.dependsOn))];
      for (const node of nodes) {
        const to = rects.get(node.id);
        if (!to) continue;
        for (const dependency of node.dependsOn) {
          const from = rects.get(dependency);
          if (!from || dependency === node.id) continue;
          const sideways = to.left >= from.right - 2;
          let d: string;
          if (sideways) {
            const x1 = from.right - box.left, y1 = from.top + from.height / 2 - box.top;
            const x2 = to.left - box.left, y2 = to.top + to.height / 2 - box.top;
            const bend = Math.max(16, (x2 - x1) / 2);
            d = `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
          } else {
            // Stacked steps: run down the left gutter so lines never cross the cards in between.
            const lane = 6 + (sources.indexOf(dependency) % 3) * 4;
            const x = Math.min(from.left, to.left) - box.left - lane;
            const y1 = from.top + Math.min(18, from.height / 2) - box.top, y2 = to.top + Math.min(18, to.height / 2) - box.top;
            d = `M${from.left - box.left} ${y1} H${x} V${y2} H${to.left - box.left}`;
          }
          paths.push({ d, key: `${dependency}>${node.key}` });
        }
      }
      // scrollWidth includes the previous absolute SVG, so using it prevents
      // the overlay from shrinking when desktop columns stack on a phone.
      setLines({ paths, width: Math.ceil(box.width), height: Math.ceil(box.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const card of element.querySelectorAll('[data-dag-id]')) observer.observe(card);
    return () => observer.disconnect();
    // The signature captures what changes the geometry; `nodes` is a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const titleOf = new Map(nodes.map(node => [node.id, node.title || node.id]));
  return (
    <div className="mission-dag" role="group" aria-label={label}>
      <div className="mission-dag-inner" ref={inner}>
        <svg className="mission-dag-lines" width={lines.width} height={lines.height} aria-hidden="true" focusable="false">
          <defs>
            <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L8 4 L0 8 z" />
            </marker>
          </defs>
          {lines.paths.map(path => <path key={path.key} d={path.d} markerEnd={`url(#${arrow})`} />)}
        </svg>
        {columns.map((column, index) => (
          <section key={index} className="mission-dag-column" aria-label={p.level(index + 1)}>
            <h4 className="mission-dag-step">{p.level(index + 1)}</h4>
            <ul>
              {column.map(node => {
                const after = node.dependsOn.length ? p.after(node.dependsOn.map(id => titleOf.get(id) ?? id).join(', ')) : p.startsNow;
                const body = <>
                  <span className="mission-dag-card-head">
                    <span className="mission-dag-title">{node.title || p.untitledTask}</span>
                    {node.status}
                  </span>
                  {node.meta && <span className="mission-dag-meta">{node.meta}</span>}
                  <span className="mission-dag-after">{after}</span>
                </>;
                return (
                  <li key={node.key}>
                    {onSelect
                      ? <button type="button" className="mission-dag-card" data-dag-id={node.id} data-tone={node.tone} data-invalid={node.invalid || undefined}
                        aria-pressed={selectedKey === node.key} onClick={() => onSelect(node.key)}>{body}</button>
                      : <div className="mission-dag-card" data-dag-id={node.id} data-tone={node.tone}>{body}</div>}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
