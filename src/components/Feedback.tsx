import type { ReactNode } from 'react';

export function ErrorState({
  error,
  retry,
  title,
}: {
  error: Error;
  retry?: () => void;
  title?: string;
}) {
  return (
    <div className="state error" role="alert">
      {title && <h3>{title}</h3>}
      <p>{error.message}</p>
      {retry && (
        <button type="button" className="ghost" onClick={retry}>
          重试
        </button>
      )}
    </div>
  );
}

/** Fallback for a render error caught by an error boundary (reader boundary or route backstop). */
export function CaughtError({
  error,
  reset,
  title = '这部分内容显示出错了',
}: {
  error: unknown;
  reset: () => void;
  title?: string;
}) {
  const shown = error instanceof Error ? error : new Error(String(error));
  return <ErrorState title={title} error={shown} retry={reset} />;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <p className="state loading" role="status">
      {label}
    </p>
  );
}
