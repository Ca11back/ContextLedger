import { useQueryClient } from '@tanstack/react-query';
import {
  CatchBoundary,
  createFileRoute,
  type ErrorComponentProps,
  useRouter,
} from '@tanstack/react-router';
import { useCallback } from 'react';
import { type AppSearch, appSearchSchema, validateAppSearch } from '../client/search';
import { CaughtError, EmptyState } from '../components/Feedback';
import { ConversationList, RequestList } from '../components/Lists';
import { ConversationReader, RequestReader } from '../components/Reader';
import { TopBar } from '../components/TopBar';

export const Route = createFileRoute('/')({
  ssr: false,
  validateSearch: appSearchSchema,
  component: App,
  errorComponent: AppError,
});

/** Route backstop: anything the reader boundary did not contain. */
function AppError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div className="app-error">
      <CaughtError
        title="页面出错了"
        error={error}
        reset={() => {
          reset();
          void router.invalidate();
        }}
      />
    </div>
  );
}

function ReaderError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="reader-empty">
      <CaughtError title="阅读区出错了，左侧列表仍可使用" error={error} reset={reset} />
    </div>
  );
}

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
          <CatchBoundary getResetKey={() => `${search.c}:${search.r}`} errorComponent={ReaderError}>
            {search.c !== undefined ? (
              <ConversationReader key={search.c} id={search.c} search={search} />
            ) : search.r !== undefined ? (
              <RequestReader key={search.r} recordId={search.r} search={search} />
            ) : (
              <div className="reader-empty">
                <EmptyState title="选一段会话开始阅读">
                  也可以把 new-api 后台的请求编号粘贴到上方搜索框，直接跳到那一轮。
                </EmptyState>
              </div>
            )}
          </CatchBoundary>
        </main>
      </div>
    </div>
  );
}
