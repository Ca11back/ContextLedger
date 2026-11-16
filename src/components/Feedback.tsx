import { Icon } from './Icon';
export function Feedback({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div className="feedback error" role="alert">
      <p>{error.message}</p>
      <button type="button" onClick={retry}>
        重试
      </button>
    </div>
  );
}
export function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-symbol" aria-hidden="true">
        <Icon name="records" size={22} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
