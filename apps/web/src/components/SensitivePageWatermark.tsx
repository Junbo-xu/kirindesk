import { ReactNode, useMemo } from 'react';
import { useAuth } from '../auth/AuthContext';

export function SensitivePageWatermark({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const renderedAt = useMemo(() => new Date().toISOString(), []);
  const text = user
    ? `${user.email} · tenant ${user.tenantId.slice(0, 8)} · ${renderedAt}`
    : renderedAt;

  return (
    <div style={{ position: 'relative', minHeight: '100%' }}>
      <div
        aria-hidden="true"
        data-testid="sensitive-watermark"
        style={{
          position: 'fixed',
          right: 18,
          bottom: 12,
          zIndex: 1000,
          maxWidth: '65vw',
          color: '#334155',
          background: 'rgba(248,250,252,0.86)',
          border: '1px solid rgba(148,163,184,0.6)',
          borderRadius: 6,
          padding: '4px 8px',
          fontSize: 11,
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        {text}
      </div>
      {children}
    </div>
  );
}
