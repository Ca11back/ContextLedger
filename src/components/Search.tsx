import { Link } from '@tanstack/react-router';
import { searchKindLabel } from '../client/format';
import { type AppSearch, validateAppSearch } from '../client/search';
import type { SearchOperation, SearchSummary } from '../conversation-contracts';
import { Icon } from './Icon';

/** Search state that opens one search request in the request reader, keeping filters. */
export function openSearchRequest(search: AppSearch, recordId: number): AppSearch {
  return validateAppSearch({
    ...search,
    tab: 'requests',
    c: undefined,
    t: undefined,
    r: recordId,
  });
}

/** Operations as escaped plain text: kind label plus query, URL or reference (never fetched). */
export function SearchOperations({ operations }: { operations: readonly SearchOperation[] }) {
  if (operations.length === 0) return <p className="muted small">没有记录到具体操作。</p>;
  return (
    <ul className="search-ops">
      {operations.map((operation, index) => (
        // Operations are an ordered, immutable list; the position is their identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: ordered, never reordered
        <li key={index}>
          <span className="search-kind">
            {searchKindLabel[operation.kind] ?? searchKindLabel.other}
          </span>
          <span className="search-op-text">{operation.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** One linked Codex web search whose output this tool result consumed. */
export function SearchBlock({ summary, search }: { summary: SearchSummary; search: AppSearch }) {
  return (
    <section className="search-block" aria-label="联网搜索">
      <div className="search-head">
        <Icon name="search" size={14} />
        <strong>联网搜索</strong>
        {summary.resultCount !== null && (
          <span className="muted">{summary.resultCount.toLocaleString()} 条结果</span>
        )}
        <Link
          to="/"
          activeOptions={{ exact: true }}
          search={openSearchRequest(search, summary.recordId)}
          className="link small"
        >
          查看搜索请求
        </Link>
      </div>
      <SearchOperations operations={summary.operations} />
    </section>
  );
}
