'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { adminSortMark, ADMIN_PAGE_SIZES } from './ui';

interface AdminUser {
  id: number;
  username: string;
  displayId: string;
  nickname: string | null;
  email: string | null;
  emailVerified: boolean;
  role: string;
  banned: boolean;
  createdAt: string;
}

interface UserPage {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function AdminUsers() {
  const { t } = useI18n();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [editingNickname, setEditingNickname] = useState<{ id: number; nickname: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  /* 排序与页长都由服务端处理 —— 前端排序只能排到当前这一页的 30 行，
     把 5000 行里的 30 行排一下再标上「已排序」是错的，且看不出错。 */
  const [sortKey, setSortKey] = useState('created');
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
      const res = await fetch(`${baseUrl}/api/admin/users?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('admin.common.loadFailed'));
      }
      const data: UserPage = await res.json();
      setUsers(data.users);
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

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  /* 点同一列切方向，点别的列换列并回到 desc。
     换列必须回 desc：从「创建时间降序」点到「用户名」时，沿用 asc 会让
     管理员看到一份 A→Z 的列表，但心里预期是「最新的在前」那种默认感。 */
  const toggleSort = (key: string) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
    setPage(1);
  };

  /* 表格与页长的关系是「先排序再切页」，改页长必须回第 1 页 ——
     否则停在第 5 页、每页从 30 变 100，会直接落到一个不存在的页码上。 */
  const changePageSize = (size: number) => { setPageSize(size); setPage(1); };

  /** 生成一个可排序表头 */
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

  const toggleBan = async (userId: number, currentBanned: boolean) => {
    const action = currentBanned ? t('admin.users.unban') : t('admin.users.ban');
    if (!window.confirm(currentBanned ? t('admin.users.unbanConfirm') : t('admin.users.banConfirm'))) return;
    setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/users/${userId}/ban`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ banned: !currentBanned }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.common.opFailed'));
      setMsg(t('admin.users.actionSuccess', { action }));
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const saveNickname = async () => {
    if (!editingNickname) return;
    setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/users/${editingNickname.id}/nickname`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ nickname: editingNickname.nickname.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.users.nicknameUpdateFailed'));
      setMsg(t('admin.users.nicknameUpdated'));
      setEditingNickname(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const toggleRole = async (userId: number, currentRole: string) => {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    const action = newRole === 'admin' ? t('admin.users.promote') : t('admin.users.demote');
    if (!window.confirm(t('admin.users.roleConfirm', { id: userId, action }))) return;
    setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.common.opFailed'));
      setMsg(t('admin.users.actionSuccess', { action }));
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const maskEmail = (email: string): string => {
    if (!email || !email.includes('@')) return email || '—';
    const [name, domain] = email.split('@');
    if (!name || name.length === 0) return `***@${domain}`;
    if (name.length <= 2) return `${name[0]}***@${domain}`;
    return `${name[0]}***${name[name.length - 1]}@${domain}`;
  };

  return (
    <div>
      {/* 搜索 + 统计 */}
      <div className="card">
        <div className="card-hd">
          <h2>{t('admin.tabUsers')}</h2>
          <span className="cnt">{t('admin.users.total', { count: total })}</span>
        </div>
        <input
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder={t('admin.users.searchPlaceholder')}
          maxLength={64}
          className="search-input"
        />
      </div>

      {/* 消息 */}
      {msg && <p className="alert alert-ok">{msg}</p>}
      {error && <p className="alert alert-dan">{error}</p>}

      {/* 用户列表 */}
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
        ) : users.length === 0 ? (
          <div className="empty"><div className="etx">{t('admin.users.noMatch')}</div></div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  {sortTh('username', t('admin.users.colUser'))}
                  <th>{t('admin.users.colDisplayId')}</th>
                  <th>{t('admin.users.colNickname')}</th>
                  {sortTh('email', t('admin.users.colEmail'))}
                  {sortTh('role', t('admin.users.colRole'))}
                  {sortTh('banned', t('admin.users.colStatus'))}
                  <th>{t('admin.users.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className={u.banned ? 'dim' : undefined}>
                    <td className="k">
                      {u.username}
                      <div className="mono">#{u.id}</div>
                    </td>
                    <td>
                      <span className="mono">{u.displayId || '-'}</span>
                    </td>
                    <td>
                      {editingNickname?.id === u.id ? (
                        <>
                          <input
                            value={editingNickname.nickname}
                            onChange={e => setEditingNickname({ ...editingNickname, nickname: e.target.value })}
                            maxLength={30}
                            className="search-input bare"
                          />
                          {' '}
                          <button onClick={saveNickname} className="btn-sm p">✓</button>
                          {' '}
                          <button onClick={() => setEditingNickname(null)} className="btn-sm">✗</button>
                        </>
                      ) : (
                        <span className="inline-edit" onClick={() => setEditingNickname({ id: u.id, nickname: u.nickname || '' })} title={t('admin.users.clickToEdit')}>
                          {u.nickname || '—'}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="mono">{u.email ? maskEmail(u.email) : '—'}</span>
                      {/* 原来这里是个裸的 "!" —— 没有任何图例，管理员只能靠猜。
                          换成带文字的徽标后，含义自明，也就不需要额外的图例了。 */}
                      {u.email && (
                        <>
                          {' '}
                          <span className={'bdg ' + (u.emailVerified ? 'bdg-ok' : 'bdg-warn')}>
                            {u.emailVerified ? t('admin.users.verified') : t('admin.users.unverified')}
                          </span>
                        </>
                      )}
                    </td>
                    <td>
                      {u.role === 'admin'
                        ? <span className="bdg bdg-mc">{t('admin.users.roleAdmin')}</span>
                        : t('admin.users.roleUser')}
                    </td>
                    <td>
                      <span className={'bdg ' + (u.banned ? 'bdg-dan' : 'bdg-ok')}>
                        {u.banned ? t('admin.users.banned') : t('admin.users.normal')}
                      </span>
                    </td>
                    <td>
                      <button
                        onClick={() => toggleRole(u.id, u.role)}
                        className={'btn-sm ' + (u.role === 'admin' ? 'dan' : 'p')}
                      >
                        {u.role === 'admin' ? t('admin.users.demoteBtn') : t('admin.users.promoteBtn')}
                      </button>
                      {' '}
                      <button
                        onClick={() => toggleBan(u.id, u.banned)}
                        className={'btn-sm ' + (u.banned ? 'p' : 'dan')}
                      >
                        {u.banned ? t('admin.users.unban') : t('admin.users.ban')}
                      </button>
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
