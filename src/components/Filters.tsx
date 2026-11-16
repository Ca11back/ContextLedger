import type { FormEvent } from 'react';
import { type DashboardSearch, filterKeys, validateDashboardSearch } from '../client/search';
import { Icon } from './Icon';

const labels = { request: '请求 ID', model: '模型', channel: '渠道', user: '用户', token: '令牌' };
export function Filters({
  search,
  apply,
}: {
  search: DashboardSearch;
  apply: (value: DashboardSearch) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    for (const key of ['from', 'to'])
      if (data[key]) data[key] = String(new Date(String(data[key])).getTime());
    apply(validateDashboardSearch(data));
  }
  const localDate = (value?: string) => {
    if (!value) return '';
    const date = new Date(Number(value));
    if (!Number.isFinite(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  const active = filterKeys.filter((key) => search[key]).length;
  return (
    <form className="filterbar" onSubmit={submit} key={JSON.stringify(search)}>
      <div className="primary-filters">
        <label>
          请求 ID
          <input
            name="request"
            defaultValue={search.request}
            maxLength={512}
            placeholder="精确匹配请求 ID"
          />
        </label>
        <label>
          模型
          <input
            name="model"
            defaultValue={search.model}
            maxLength={512}
            placeholder="精确匹配模型"
          />
        </label>
        <label className="date-field">
          接收时间 · 从
          <input type="datetime-local" name="from" defaultValue={localDate(search.from)} />
        </label>
        <label className="date-field">
          至<input type="datetime-local" name="to" defaultValue={localDate(search.to)} />
        </label>
        <button className="primary" type="submit">
          查询
        </button>
        <button type="button" onClick={() => apply({})}>
          重置{active ? ` (${active})` : ''}
        </button>
      </div>
      <details className="more-filters">
        <summary>
          更多筛选 <Icon name="down" size={14} />
        </summary>
        <div className="secondary-filters">
          {(['channel', 'user', 'token'] as const).map((key) => (
            <label key={key}>
              {labels[key]}
              <input
                name={key}
                defaultValue={search[key]}
                maxLength={512}
                placeholder={`精确匹配${labels[key]}`}
              />
            </label>
          ))}
          <label>
            上报结果
            <select name="outcome" defaultValue={search.outcome ?? ''}>
              <option value="">全部</option>
              <option value="reported">已上报</option>
              <option value="error">错误</option>
            </select>
          </label>
          <label>
            网关截断
            <select name="truncated" defaultValue={search.truncated ?? ''}>
              <option value="">全部</option>
              <option value="1">已截断</option>
              <option value="0">未报告截断</option>
            </select>
          </label>
          <label>
            内联媒体
            <select name="media" defaultValue={search.media ?? ''}>
              <option value="">全部</option>
              <option value="1">包含遮罩描述</option>
              <option value="0">无描述</option>
            </select>
          </label>
        </div>
      </details>
    </form>
  );
}
