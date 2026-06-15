import { CommissionRateSource } from '../lib/types';

// Renders a base-currency decimal string with thousands separators, prefixed
// with the currency code from the response envelope. Mirrors ReportsPage so the
// two surfaces format money identically. The frontend never does money math.
export function formatAmount(amount: string, currency: string): string {
  const [intPart, fracPart = '00'] = amount.split('.');
  const neg = intPart.startsWith('-');
  const digits = neg ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${neg ? '-' : ''}${grouped}.${fracPart}`;
}

// numeric(7,4) percent string -> compact display, e.g. "5.0000" -> "5%".
export function formatRate(rate: string): string {
  const n = Number(rate);
  if (!Number.isFinite(n)) return `${rate}%`;
  return `${Number(n.toFixed(4))}%`;
}

// Annotates a fallback/zero rate so a default or missing rate is never mistaken
// for a configured per-salesperson rule (plan §6.2).
export const RATE_SOURCE_LABELS: Record<CommissionRateSource, string | null> = {
  rule: null,
  default: '默认费率',
  none: '无费率',
};

// Trailing 6 months through today — same default window as ReportsPage.
export function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const fromDate = new Date(now);
  fromDate.setMonth(fromDate.getMonth() - 6);
  return { from: fromDate.toISOString().slice(0, 10), to };
}

// Shared zh-CN order status labels (order lifecycle, 1F-C).
export const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  pending_approval: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  confirmed: '已确认',
  completed: '已完成',
  cancelled: '已取消',
};

// Payout lifecycle (plan §6.2). Batch: open/paid/void; line: pending/paid/void.
export const PAYOUT_STATUS_LABELS: Record<string, string> = {
  open: '待发放',
  paid: '已发放',
  void: '已作废',
};
export const PAYOUT_LINE_STATUS_LABELS: Record<string, string> = {
  pending: '待发放',
  paid: '已发放',
  void: '已作废',
};

// Colour-codes a payout/line status: green when disbursed, muted-amber when
// pending/open, red when voided.
export function payoutStatusColor(status: string): string {
  if (status === 'paid') return '#1a7';
  if (status === 'void') return 'crimson';
  return '#a60';
}
