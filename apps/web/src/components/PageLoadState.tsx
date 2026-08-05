import { ApiError } from '../lib/types';

export interface PageLoadFailure {
  status: number | null;
  message: string;
}

export function toPageLoadFailure(error: unknown, fallback: string): PageLoadFailure {
  return {
    status: error instanceof ApiError ? error.status : null,
    message: error instanceof Error ? error.message : fallback,
  };
}

export function PageLoadState({
  loading,
  failure,
  loadingText,
  onRetry,
}: {
  loading: boolean;
  failure: PageLoadFailure | null;
  loadingText: string;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <p role="status" aria-live="polite" style={{ color: '#64748b' }}>
        {loadingText}
      </p>
    );
  }
  if (!failure) return null;

  const title =
    failure.status === 403
      ? '无权访问（403）'
      : failure.status !== null && failure.status >= 500
        ? `服务暂时不可用（${failure.status}）`
        : '加载失败';
  return (
    <div role="alert" style={{ border: '1px solid #fecaca', padding: 12, borderRadius: 8 }}>
      <strong>{title}</strong>
      <p style={{ margin: '6px 0 10px', color: '#7f1d1d' }}>{failure.message}</p>
      <button type="button" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}
