'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { adminSortMark, ADMIN_PAGE_SIZES } from './ui';

interface GuestInfo {
  playerKey: string;
  displayName: string;
  totalGames: number;
  wins: number;
  lastSeen: string;
}

interface GuestPage {
  guests: GuestInfo[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function AdminGuests() {
  const { t } = useI18n();
  const [guests, setGuests] = useState<GuestInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const [sortKey, setSortKey] = useState('lastSeen');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [pageSize, setPageSize] = useState(30);
  const baseUrl = getServerUrl();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = getToken();
      const params = new URLSearchParams({
        page: String(page), pageSize: String(pageSize),
        sort: sortKey, dir: sortDir,
      });
      if (search) params.set('search', search);
      const res = await fetch(`${baseUrl}/api/admin/guests?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('admin.common.loadFailed'));
      }
      const data: GuestPage = await res.json();
      setGuests(data.guests);
      setTotal(data.total);
      setPage(data.page);
      setTotalPages(data.totalPages);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, page, search, sortKey, sortDir, pageSize, t]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const toggleSort = (key: string) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
    setPage(1);
  };

  const changePageSize = (size: number) => { setPageSize(size); setPage(1); };

  const sortTh = (key: string, label: string) => {
    const active = sortKey === key;
    return (
      <th
        className={'so' + (active ? ' on' : '')}
        onClick={() => toggleSort(key)}
        title={t('admin.common.sortHint')}
      >
        {label} <i>{adminSortMark(active, sortDir)}</i>
      </th>
    );
  };

  return (
    <div>
      {/* 搜索 + 统计 */}
      <div className="card">
        <div className="card-hd">
          <h2>{t('admin.tabGuests')}</h2>
          <span className="cnt">{t('admin.guests.total', { count: total })}</span>
        </div>
        <input
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder={t('admin.guests.searchPlaceholder')}
          maxLength={64}
          className="search-input"
        />
      </div>

      {msg && <p className="alert alert-ok">{msg}</p>}
      {error && <p className="alert alert-dan">{error}</p>}

      {/* 游客列表 */}
      <div className="card">
        <div className="card-hd">
          <label className="psize">
            {t('admin.common.pageSizeLabel')}
            <select
              value={pageSize}
              onChange={e => changePageSize(Number(e.target.value))}
              className="sel"
            >
              {ADMIN_PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>
        {loading ? (
          <div className="sk"><i /><i /><i /><i /></div>
        ) : guests.length === 0 ? (
          <div className="empty"><div className="etx">{t('admin.guests.noMatch')}</div></div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  {/* 访客名是 deriveGuestName(player_key) 在服务端算出来的，SQL 排不了，
                      所以这一列故意不给排序 —— 给一个点了没反应的按钮比不给更糟。 */}
                  <th>{t('admin.guests.colName')}</th>
                  {sortTh('totalGames', t('admin.guests.colTotalGames'))}
                  {sortTh('wins', t('admin.guests.colWins'))}
                  <th>{t('admin.guests.colWinRate')}</th>
                  {sortTh('lastSeen', t('admin.guests.colLastSeen'))}
                </tr>
              </thead>
              <tbody>
                {guests.map((g, i) => (
                  <tr key={g.playerKey}>
                    <td className="k">{g.displayName}</td>
                    <td className="num">{g.totalGames}</td>
                    <td className="num">{g.wins}</td>
                    <td className="num">
                      {g.totalGames > 0
                        ? `${Math.round((g.wins / g.totalGames) * 100)}%`
                        : '—'}
                    </td>
                    <td>
                      <span className="mono">
                        {g.lastSeen?.slice(0, 16)?.replace('T', ' ') || '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 分页 */}
        {totalPages > 1 && (
          <div className="pager">
            <span className="meta">
              {page} / {totalPages}
            </span>
            <div className="pgs">
              <button
                disabled={page <= 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}
                className={'pg' + (page <= 1 ? ' dis' : '')}
              >
                {t('admin.common.prevPage')}
              </button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                className={'pg' + (page >= totalPages ? ' dis' : '')}
              >
                {t('admin.common.nextPage')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
