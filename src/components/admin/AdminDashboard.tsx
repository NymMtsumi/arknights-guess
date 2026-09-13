'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

interface DashboardData {
  totalUsers: number;
  newUsersToday: number;
  totalGames: number;
  onlineNow: number;
  recentUsers: Array<{ id: number; username: string; displayId: string; createdAt: string }>;
  recentGames: Array<{ id: number; playerKey: string; playerName: string; won: boolean; guessCount: number; difficulty: string; targetName: string; mode: string; timestamp: string }>;
  dbSize: number;
  uptime: number;
  version: string;
}

export default function AdminDashboard() {
  const { t } = useI18n();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const baseUrl = getServerUrl();

  const load = useCallback(async () => {
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/dashboard`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || t('admin.common.loadFailed'));
      }
      const d: DashboardData = await res.json();
      setData(d);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [baseUrl, t]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="card"><div className="sk"><i /><i /><i /><i /></div></div>;
  }

  if (error) {
    return (
      <div className="card">
        <div className="empty">
          <div className="etx">{error}</div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const fmtUptime = (sec: number) => {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return t('admin.dashboard.uptimeDaysHours', { d, h });
    if (h > 0) return t('admin.dashboard.uptimeHoursMins', { h, m });
    return t('admin.dashboard.uptimeMins', { m });
  };

  const modeLabel = (mode: string, difficulty: string) => {
    if (mode === 'multi') return t('admin.dashboard.modeMulti');
    if (difficulty === 'hard') return t('admin.dashboard.modeHard');
    if (difficulty === 'easy') return t('admin.dashboard.modeEasy');
    return difficulty || '—';
  };

  /* 四个指标共用一条强调色细线（.stat::after），**不**各配一色：
     给每个数字一种颜色会假造出一个并不存在的分类。唯一的例外是「当前在线」——
     它带 pulse，因为那是一个会自己变的活值，不是同类计数。 */
  const stats = [
    { label: t('admin.dashboard.totalUsers'), value: data.totalUsers, live: false },
    { label: t('admin.dashboard.newToday'), value: data.newUsersToday, live: false },
    { label: t('admin.dashboard.totalGames'), value: data.totalGames, live: false },
    { label: t('admin.dashboard.onlineNow'), value: data.onlineNow, live: true },
  ];

  return (
    <div>
      <div className="stats">
        {stats.map((s) => (
          <div key={s.label} className="stat">
            <div className="lb">
              {s.live && <span className="pulse" style={{ display: 'inline-block', marginRight: 6 }} />}
              {s.label}
            </div>
            <div className="vl">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="console-2col">
        {/* 最近注册 */}
        <div className="card">
          <div className="card-hd">
            <h2>{t('admin.dashboard.recentUsers')}</h2>
            <span className="cnt">{data.recentUsers.length}</span>
          </div>
          {data.recentUsers.length === 0 ? (
            <div className="empty"><div className="etx">{t('admin.common.noData')}</div></div>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('admin.dashboard.colUser')}</th>
                    <th>{t('admin.dashboard.colId')}</th>
                    <th className="num">{t('admin.dashboard.colRegisteredAt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentUsers.map((u) => (
                    <tr key={u.id}>
                      <td className="k">{u.username}</td>
                      <td><span className="mono">{u.displayId || '—'}</span></td>
                      <td className="num"><span className="mono">{u.createdAt?.slice(0, 16)?.replace('T', ' ')}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 最近游戏 */}
        <div className="card">
          <div className="card-hd">
            <h2>{t('admin.dashboard.recentGames')}</h2>
            <span className="cnt">{data.recentGames.length}</span>
          </div>
          {data.recentGames.length === 0 ? (
            <div className="empty"><div className="etx">{t('admin.common.noData')}</div></div>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('admin.dashboard.colPlayer')}</th>
                    <th>{t('admin.dashboard.colResult')}</th>
                    <th>{t('admin.dashboard.colTarget')}</th>
                    <th className="num">{t('admin.dashboard.colMode')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentGames.map((g) => (
                    <tr key={g.id}>
                      <td className="k">{g.playerName || g.playerKey || '—'}</td>
                      <td>
                        <span className={'bdg ' + (g.won ? 'bdg-ok' : 'bdg-dan')}>
                          {g.won ? '✓' : '✗'} {t('admin.dashboard.guessCount', { count: g.guessCount })}
                        </span>
                      </td>
                      <td>{g.mode === 'multi' ? `vs ${g.targetName}` : g.targetName}</td>
                      <td className="num">
                        <span className={'bdg ' + (g.mode === 'multi' ? 'bdg-dan' : 'bdg-mc')}>
                          {modeLabel(g.mode || 'single', g.difficulty)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 系统信息 */}
      <div className="card">
        <div className="card-hd">
          <h2>{t('admin.dashboard.systemInfo')}</h2>
        </div>
        <div className="kv-row">
          <span>{t('admin.dashboard.version')} <code className="mono">{data.version}</code></span>
          <span>{t('admin.dashboard.uptime')} <code className="mono">{fmtUptime(data.uptime)}</code></span>
          <span>{t('admin.dashboard.dbSize')} <code className="mono">{data.dbSize} KB</code></span>
        </div>
      </div>
    </div>
  );
}
