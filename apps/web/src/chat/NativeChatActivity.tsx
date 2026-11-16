import type { AgentTeam } from '@extalia/core';
import type { ExtaliaEvent } from '@extalia/protocol';
import { ResourceUsagePanel } from './ResourceUsagePanel';
import { useMemo, useState } from 'react';
import type { Messages } from '../i18n';
import { ObservedSubagentList, ObservedSubagentPreview, observedSubagentRows } from '../observe/ObservedSubagents';
import { Icon } from '../ui/Icon';
import type { AttachmentPreviewLoader } from './attachments';
import { SkillLoadCard } from './SkillLoadCard';
import type { SkillLoadItem, TranscriptItem, WorkerItem } from './transcript';
import './nativeChatActivity.css';

/** Move host preparation receipts out of messages without changing stored history. */
export function nativeMessageItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  const output: TranscriptItem[] = [];
  const copies = new Map<WorkerItem, WorkerItem>();
  const pending = [{ source: items, target: output }];
  while (pending.length) {
    const { source, target } = pending.pop()!;
    for (const item of source) {
      if (item.kind === 'skills') continue;
      if (item.kind !== 'worker') { target.push(item); continue; }
      let copy = copies.get(item);
      if (!copy) {
        copy = { ...item, ...(item.preview ? { preview: [] } : {}) };
        copies.set(item, copy);
        if (item.preview) pending.push({ source: item.preview, target: copy.preview! });
      }
      target.push(copy);
    }
  }
  return output;
}

function skillReceipts(items: readonly TranscriptItem[]): SkillLoadItem[] {
  const receipts: SkillLoadItem[] = [];
  const seen = new Set<TranscriptItem>();
  const receiptIds = new Set<string>();
  const scopes = [items];
  // Parent scopes carry the host's attributed receipt; the worker preview can
  // contain a separate projection of that same event. Prefer the parent copy.
  for (let index = 0; index < scopes.length; index++) {
    for (const item of scopes[index]!) {
      if (seen.has(item)) continue;
      seen.add(item);
      if (item.kind === 'skills' && !receiptIds.has(item.id)) {
        receiptIds.add(item.id);
        receipts.push(item);
      }
      if (item.kind === 'worker' && item.preview) scopes.push(item.preview);
    }
  }
  return receipts;
}

const RECEIPT_PAGE_SIZE = 8;

/** Read-only Native activity, using the same actual worker records as Observe. */
export function NativeChatActivity({ t, language, items, selectedWorkerId, onOpenWorker, previewAttachment, team, events, sessionId, scopeKey, live, primaryName }: {
  t: Messages; language: string; items: readonly TranscriptItem[]; selectedWorkerId?: string;
  onOpenWorker: (worker: WorkerItem) => void; previewAttachment?: AttachmentPreviewLoader; team?: AgentTeam | null;
  events?: readonly ExtaliaEvent[]; sessionId?: string; scopeKey?: string; live?: boolean; primaryName?: string;
}) {
  const [receiptLimit, setReceiptLimit] = useState(RECEIPT_PAGE_SIZE);
  const rows = useMemo(() => observedSubagentRows(nativeMessageItems(items)), [items]);
  const receipts = useMemo(() => skillReceipts(items), [items]);
  const selected = rows.find(({ worker }) => worker.id === selectedWorkerId)?.worker;
  if (!rows.length && !receipts.length && !team?.members.length && !sessionId) return null;
  return <div className="native-chat-activity">
    <ObservedSubagentList t={t} rows={rows} selectedWorkerId={selectedWorkerId} onOpenWorker={onOpenWorker} />
    {selected && <ObservedSubagentPreview key={selected.id} t={t} language={language} worker={selected} onOpenWorker={onOpenWorker} previewAttachment={previewAttachment} />}
    {events && sessionId && <ResourceUsagePanel events={events} sessionId={sessionId} scopeKey={scopeKey ?? sessionId} team={team} t={t} language={language} live={live} primaryName={primaryName} />}
    {!!receipts.length && <details className="native-chat-skills">
      <summary><Icon name="chevron" /><span>{t.chat.skillLoading.title}</span><span className="badge">{receipts.length}</span></summary>
      <div className="native-chat-skill-history">
        {receipts.length > receiptLimit && <button type="button" className="button small" onClick={() => setReceiptLimit(limit => limit + RECEIPT_PAGE_SIZE)}>{t.chat.showMore}</button>}
        {receipts.slice(-receiptLimit).map((item, index) => <SkillLoadCard key={`${item.id}:${Math.max(0, receipts.length - receiptLimit) + index}`} t={t} item={item} language={language} />)}
      </div>
    </details>}
    {!!team?.members.length && <details className="native-chat-roster">
      <summary><Icon name="chevron" /><span>{t.team.title}</span><span className="badge">{team.members.length}</span><span className="native-chat-roster-setting">{team.enabled ? t.chat.team.active : t.chat.team.inactive}</span></summary>
      {team.goal && <p className="native-chat-team-goal">{team.goal}</p>}
      <ul>{team.members.map(member => <li key={member.id}>
        <strong>{member.name}</strong>
        {member.role && <span className="native-chat-member-role">{member.role}</span>}
        {member.task && <p>{member.task}</p>}
        {!!member.models.length && <p className="native-chat-member-models"><span>{t.team.models}: </span>{member.models.join(' · ')}</p>}
      </li>)}</ul>
    </details>}
  </div>;
}
