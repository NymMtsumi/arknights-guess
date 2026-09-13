'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { adminSortMark, ADMIN_PAGE_SIZES } from './ui';

interface LogEntry {
  id: number;
  adminName: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: string;
  ip: string;
  createdAt: string;
}

interface LogPage {
  logs: LogEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/* 徽标按动作语义归类：新增/解封=ok / 编辑类=mc（管理端强调色）/ 角色与部署=warn /
   删除与封禁=dan。

   原先颜色是照 blast 主题色板写死的 6 个十六进制字面量，浅色主题下几乎不可读；
   这里改挂 V12 的 .bdg-* 语义徽标，底色随主题走。代价是原先 primary 与 accent
   两类色相（编辑 vs 令牌/导入）在徽标词汇表里合并到同一档 —— 设计稿本身也把
   「创建令牌 / 干员同步」画成 bdg-mc，故按设计稿收敛。

   这里只放「不随语言变」的部分（动作 → 徽标类 + 文案键）；label 由组件内的 t() 解析。 */
const ACTION_META: Record<string, { labelKey: string; cls: string }> = {
  create_announcement: { labelKey: 'admin.audit.actionCreateAnnouncement', cls: 'bdg-ok' },
  update_announcement: { labelKey: 'admin.audit.actionUpdateAnnouncement', cls: 'bdg-mc' },
  delete_announcement: { labelKey: 'admin.audit.actionDeleteAnnouncement', cls: 'bdg-dan' },
  ban_user: { labelKey: 'admin.audit.actionBanUser', cls: 'bdg-dan' },
  unban_user: { labelKey: 'admin.audit.actionUnbanUser', cls: 'bdg-ok' },
  change_nickname: { labelKey: 'admin.audit.actionChangeNickname', cls: 'bdg-mc' },
  self_change_nickname: { labelKey: 'admin.audit.actionSelfChangeNickname', cls: 'bdg-mc' },
  change_role: { labelKey: 'admin.audit.actionChangeRole', cls: 'bdg-warn' },
  create_token: { labelKey: 'admin.audit.actionCreateToken', cls: 'bdg-mc' },
  revoke_token: { labelKey: 'admin.audit.actionRevokeToken', cls: 'bdg-dan' },
  create_character: { labelKey: 'admin.audit.actionCreateCharacter', cls: 'bdg-ok' },
  update_character: { labelKey: 'admin.audit.actionUpdateCharacter', cls: 'bdg-mc' },
  delete_character: { labelKey: 'admin.audit.actionDeleteCharacter', cls: 'bdg-dan' },
  import_characters: { labelKey: 'admin.audit.actionImportCharacters', cls: 'bdg-mc' },
  deploy: { labelKey: 'admin.audit.actionDeploy', cls: 'bdg-warn' },
};

export default function AdminAuditLog() {
  const { t } = useI18n();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
      if (actionFilter) params.set('action', actionFilter);
      const res = await fetch(`${baseUrl}/api/admin/audit-log?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(t('admin.common.loadFailed'));
      const data: LogPage = await res.json();
      setLogs(data.logs);
      setTotal(data.total);
      setPage(data.page);
      setTotalPages(data.totalPages);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, page, actionFilter, sortKey, sortDir, pageSize, t]);

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
        className={active ? 'so on' : 'so'}
        onClick={() => toggleSort(key)}
        title={t('admin.common.sortHint')}
      >
        {label} <i>{adminSortMark(active, sortDir)}</i>
      </th>
    );
  };

  useEffect(() => { load(); }, [load]);

  const actionOptions = useMemo(() => [
    { value: '', label: t('admin.audit.actionAll') },
    ...Object.entries(ACTION_META).map(([value, m]) => ({ value, label: t(m.labelKey) })),
  ], [t]);

  const getActionBadge = (action: string) => {
    const info = ACTION_META[action];
    // 未知动作回退到原始 action 字符串 —— 后端新增动作类型时，
    // 这里会显示 create_foo 而不是空白，便于排查
    if (!info) return <span className="bdg bdg-no">{action}</span>;
    return <span className={'bdg ' + info.cls}>{t(info.labelKey)}</span>;
  };

  return (
    <div>
      {/* 筛选栏 */}
      <div className="card">
        <div className="card-hd">
          <select
            className="sel"
            value={actionFilter}
            onChange={e => { setActionFilter(e.target.value); setPage(1); }}
          >
            {actionOptions.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <span className="cnt">{t('admin.audit.total', { count: total })}</span>
        </div>
      </div>

      {error && <p className="alert alert-dan">{error}</p>}

      {/* 日志列表 */}
      <div className="card">
        <div className="card-hd">
          <label className="psize">
            {t('admin.common.pageSizeLabel')}
            <select
              className="sel"
              value={pageSize}
              onChange={e => changePageSize(Number(e.target.value))}
            >
              {ADMIN_PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>
        {loading ? (
          <div className="sk"><i /><i /><i /><i /></div>
        ) : logs.length === 0 ? (
          <div className="empty"><div className="etx">{t('admin.audit.empty')}</div></div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  {sortTh('created', t('admin.audit.colTime'))}
                  {sortTh('actor', t('admin.audit.colAdmin'))}
                  {sortTh('action', t('admin.audit.colAction'))}
                  <th>{t('admin.audit.colTarget')}</th>
                  <th>{t('admin.audit.colDetail')}</th>
                  {sortTh('ip', t('admin.audit.colIp'))}
                </tr>
              </thead>
              <tbody>
                {logs.map(l => (
                  <tr key={l.id}>
                    <td className="mono">
                      {l.createdAt?.slice(0, 16)?.replace('T', ' ')}
                    </td>
                    <td className="k">{l.adminName}</td>
                    <td>{getActionBadge(l.action)}</td>
                    <td className="mono">
                      {l.targetType ? `${l.targetType}${l.targetId ? ` #${l.targetId}` : ''}` : '—'}
                    </td>
                    <td className="ellip" title={l.detail || ''}>
                      {l.detail || '—'}
                    </td>
                    {/* 完整 IP —— 审计追溯要按位比对，与在线列表的脱敏 IP 刻意不对称 */}
                    <td className="mono">{l.ip || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 分页 */}
        {totalPages > 1 && (
          <div className="pager">
            <span className="meta">{page} / {totalPages}</span>
            <div className="pgs">
              <button
                className={page <= 1 ? 'pg dis' : 'pg'}
                disabled={page <= 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}
              >
                {t('admin.common.prevPage')}
              </button>
              <button
                className={page >= totalPages ? 'pg dis' : 'pg'}
                disabled={page >= totalPages}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
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
