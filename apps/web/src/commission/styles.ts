import { CSSProperties } from 'react';

// Shared table cell styles, matching ReportsPage so the commission surfaces
// look consistent with the reports surface.
export const th: CSSProperties = {
  textAlign: 'left',
  borderBottom: '2px solid #ddd',
  padding: '6px 12px',
};
export const thNum: CSSProperties = { ...th, textAlign: 'right' };
export const td: CSSProperties = { borderBottom: '1px solid #eee', padding: '6px 12px' };
export const tdNum: CSSProperties = {
  ...td,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};
export const controlRow: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  alignItems: 'flex-end',
  margin: '12px 0',
};
export const tag: CSSProperties = {
  display: 'inline-block',
  marginLeft: 6,
  padding: '0 6px',
  borderRadius: 4,
  background: '#f3e9d2',
  color: '#a60',
  fontSize: 11,
};
