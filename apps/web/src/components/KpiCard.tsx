import type { ReactNode } from 'react';

interface KpiCardProps {
  title: string;
  value: string;
  detail?: ReactNode;
  accent?: string;
}

export function KpiCard({ title, value, detail, accent = '#0d8250' }: KpiCardProps) {
  return (
    <div className="metric-card">
      <div className="metric-label">{title}</div>
      <div className="metric-value" style={{ color: accent }}>
        {value}
      </div>
      <div className="metric-detail">{detail}</div>
      <div className="metric-line" style={{ background: accent }} />
    </div>
  );
}
