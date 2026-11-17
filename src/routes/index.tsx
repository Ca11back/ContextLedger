import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { type AppSearch, validateAppSearch } from '../client/search';
import { EmptyState } from '../components/Feedback';
import { ConversationList, RequestList } from '../components/Lists';
import { ConversationReader, RequestReader } from '../components/Reader';
import { TopBar } from '../components/TopBar';

export const Route = createFileRoute('/')({
  ssr: false,
  validateSearch: validateAppSearch,
  component: App,
});

function App() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const client = useQueryClient();
  const go = useCallback(
    (next: AppSearch) => void navigate({ search: validateAppSearch({ ...next }) }),
    [navigate],
  );
  const refresh = () => {
    for (const key of ['conversations', 'requests', 'metrics', 'uploads', 'conversation'])
      void client.invalidateQueries({ queryKey: [key] });
    void client.resetQueries({ queryKey: ['fragments'] });
  };
  const reading = search.c !== undefined || search.r !== undefined;
  return (
    <div className={`app${reading ? ' reading' : ''}`}>
      <TopBar search={search} go={go} refresh={refresh} />
      <div className="main">
        {search.tab === 'requests' ? (
          <RequestList search={search} go={go} />
        ) : (
          <ConversationList search={search} go={go} />
        )}
        <main className="reader">
          {search.c !== undefined ? (
            <ConversationReader key={search.c} id={search.c} search={search} go={go} />
          ) : search.r !== undefined ? (
            <RequestReader key={search.r} recordId={search.r} search={search} go={go} />
          ) : (
            <div className="reader-empty">
              <EmptyState title="选一段会话开始阅读">
                也可以把 new-api 后台的请求编号粘贴到上方搜索框，直接跳到那一轮。
              </EmptyState>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
