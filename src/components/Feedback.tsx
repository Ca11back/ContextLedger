import type { ReactNode } from 'react';

export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="state error" role="alert">
      <p>{error.message}</p>
      {retry && (
        <button type="button" className="ghost" onClick={retry}>
          重试
        </button>
      )}
    </div>
  );
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
