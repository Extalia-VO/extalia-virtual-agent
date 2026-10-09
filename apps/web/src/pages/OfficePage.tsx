import { useState } from 'react';
import type { OfficePresenceState } from '@extalia/office';
import { Icon } from '../ui/Icon';

const SAMPLE_AGENTS: readonly OfficePresenceState[] = [
  {
    agentId: 'primary',
    agentName: 'Lead Orchestrator',
    role: 'Lead Orchestrator',
    status: 'working',
    currentFloor: 1,
    position: [0, 0, 0],
    lastActiveTimestamp: new Date().toISOString()
  },
  {
    agentId: 'architect',
    agentName: 'Systems Architect',
    role: 'Systems Architect',
    status: 'working',
    currentFloor: 1,
    position: [2.5, 0, -1.2],
    lastActiveTimestamp: new Date().toISOString()
  },
  {
    agentId: 'frontend',
    agentName: 'Frontend Specialist',
    role: 'Frontend Lead',
    status: 'seated',
    currentFloor: 1,
    position: [-2.5, 0, 1.2],
    lastActiveTimestamp: new Date().toISOString()
  },
  {
    agentId: 'backend',
    agentName: 'Backend Specialist',
    role: 'Backend Lead',
    status: 'idle',
    currentFloor: 1,
    position: [4.0, 0, 0.5],
    lastActiveTimestamp: new Date().toISOString()
  }
];

export function OfficePage() {
  const [floor, setFloor] = useState<number>(1);
  const [selectedAgent, setSelectedAgent] = useState<OfficePresenceState | null>(null);

  return (
    <div className="office-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '1rem', padding: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>Extalia 3D Virtual Office</h2>
          <p style={{ margin: '0.25rem 0 0', opacity: 0.7, fontSize: '0.875rem' }}>
            Spatial agent observability & real-time presence visualization
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {[1, 2, 3].map(f => (
            <button
              key={f}
              type="button"
              className={floor === f ? 'primary' : ''}
              onClick={() => setFloor(f)}
              style={{ padding: '0.4rem 0.8rem', borderRadius: '4px', cursor: 'pointer' }}
            >
              Floor {f}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: '380px',
          background: 'radial-gradient(circle at 50% 50%, #1e2638 0%, #0d111a 100%)',
          borderRadius: '8px',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center'
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: '480px', padding: '2rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🏢</div>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.1rem' }}>Spatial Viewport: Floor {floor}</h3>
          <p style={{ margin: 0, fontSize: '0.85rem', opacity: 0.8, lineHeight: 1.5 }}>
            Active Workforce: <strong>{SAMPLE_AGENTS.length} agents allocated</strong> across workstations.
            Events from Extalia Protocol dynamically drive animations, desk allocation, and meeting rooms.
          </p>
        </div>

        <div
          style={{
            position: 'absolute',
            bottom: '1rem',
            left: '1rem',
            right: '1rem',
            display: 'flex',
            gap: '0.75rem',
            overflowX: 'auto',
            paddingBottom: '0.5rem'
          }}
        >
          {SAMPLE_AGENTS.map(agent => (
            <div
              key={agent.agentId}
              onClick={() => setSelectedAgent(agent)}
              style={{
                background: selectedAgent?.agentId === agent.agentId ? 'rgba(70, 130, 240, 0.3)' : 'rgba(20, 25, 38, 0.75)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '6px',
                padding: '0.6rem 0.8rem',
                minWidth: '160px',
                cursor: 'pointer',
                backdropFilter: 'blur(8px)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 500, fontSize: '0.85rem' }}>
                <span style={{
                  display: 'inline-block',
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: agent.status === 'working' ? '#10b981' : agent.status === 'seated' ? '#3b82f6' : '#9ca3af'
                }} />
                {agent.agentName}
              </div>
              <div style={{ fontSize: '0.75rem', opacity: 0.7, marginTop: '0.2rem' }}>{agent.role}</div>
            </div>
          ))}
        </div>
      </div>

      {selectedAgent && (
        <div style={{
          padding: '0.75rem 1rem',
          background: 'rgba(255, 255, 255, 0.05)',
          borderRadius: '6px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div>
            <strong>{selectedAgent.agentName}</strong> — Status: <code style={{ textTransform: 'uppercase' }}>{selectedAgent.status}</code> | Position: [{selectedAgent.position.join(', ')}]
          </div>
          <button type="button" onClick={() => setSelectedAgent(null)} style={{ cursor: 'pointer', padding: '0.2rem 0.5rem' }}>
            <Icon name="close" />
          </button>
        </div>
      )}
    </div>
  );
}
