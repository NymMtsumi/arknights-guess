'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

interface OnlinePlayer {
  playerKey: string;
  displayName: string;
  username: string | null;
  type: 'multi' | 'single' | 'idle';
  roomCode: string | null;
  ip: string | null;
  lastSeen: string;
}

interface OnlineStats {
  totalOnline: number;
  inMultiplayer: number;
  inSinglePlayer: number;
  idle: number;
  players: OnlinePlayer[];
}

/* 模式徽标的视觉分组。原先每种模式各配一个色值，这里收敛到 V12 的三档语义色：
   multi = 正在对局（最"活"）→ ok / single = 自开一局 → mc（管理端强调色）/
   idle = 只浏览 → no（最低对比度）。
   未知类型回退到 idle 那一档 —— 与旧实现的 `colors[type] || colors.idle` 同义。 */
const TYPE_BADGE: Record<string, string> = {
  multi: 'bdg-ok',
  single: 'bdg-mc',
  idle: 'bdg-no',
};

const TYPE_LABEL_KEYS: Record<string, string> = {
  multi: 'admin.online.typeMulti',
  single: 'admin.online.typeSingle',
  idle: 'admin.online.typeIdle',
};

function typeLabel(type: string, t: (k: string) => string): string {
  const key = TYPE_LABEL_KEYS[type];
  // 未知类型原样透传 —— 后端加了新状态时至少能看到原始值，而不是一片空白
  return key ? t(key) : type;
}

export default function AdminOnline() {
  const { t, locale } = useI18n();
  const [stats, setStats] = useState<OnlineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const baseUrl = getServerUrl();

  const load = useCallback(async () => {
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/online`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('admin.common.loadFailed'));
      }
      const data: OnlineStats = await res.json();
      setStats(data);
      setError('');
    } catch (err: any) {
      // ⚠️ 轮询失败只记错误，**不清空 stats** —— 新数据拿不到时，
      // 列表保持上一次的结果（配合下面的 error 提示条），这是刻意设计。
      setError(err.message);
    }
    setLoading(false);
  }, [baseUrl, t]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading && !stats) {
    return <div className="card"><div className="sk"><i /><i /><i /><i /></div></div>;
  }

  return (
    <div>
      {/* 轮询失败时这里出现一行提示，但下方表格仍是上一轮的数据 */}
      {error && (
        <p className="alert alert-dan">{error}</p>
      )}

      {/* 统计卡片 —— 四项共用一条强调色细线（.stat::after），不各配一色 */}
      <div className="stats">
        {[
          { label: t('admin.online.total'), value: stats?.totalOnline ?? 0 },
          { label: t('admin.online.multiplayer'), value: stats?.inMultiplayer ?? 0 },
          { label: t('admin.online.single'), value: stats?.inSinglePlayer ?? 0 },
          { label: t('admin.online.idle'), value: stats?.idle ?? 0 },
        ].map(s => (
          <div key={s.label} className="stat">
            <div className="lb">{s.label}</div>
            <div className="vl">{s.value}</div>
          </div>
        ))}
      </div>

      {/* 玩家列表 */}
      <div className="card">
        <div className="card-hd">
          <h2>{t('admin.online.players', { count: stats?.totalOnline ?? 0 })}</h2>
        </div>

        {(!stats || stats.players.length === 0) ? (
          <div className="empty"><div className="etx">{t('admin.online.empty')}</div></div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('admin.online.colName')}</th>
                  <th>{t('admin.online.colUsername')}</th>
                  <th>{t('admin.online.colStatus')}</th>
                  <th>{t('admin.online.colRoom')}</th>
                  <th>{t('admin.online.colIp')}</th>
                  <th>{t('admin.online.colLastSeen')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.players.map(p => (
                  <tr key={p.playerKey}>
                    <td className="k">{p.displayName}</td>
                    <td>{p.username || '-'}</td>
                    <td>
                      <span className={'bdg ' + (TYPE_BADGE[p.type] || TYPE_BADGE.idle)}>
                        {typeLabel(p.type, t)}
                      </span>
                    </td>
                    <td className="mono">{p.roomCode || '-'}</td>
                    {/* IP 是后端脱敏后的值，原样展示 —— 审计日志里的才是完整 IP，两者刻意不对称 */}
                    <td className="mono">{p.ip || '—'}</td>
                    <td className="num">
                      {p.lastSeen ? new Date(p.lastSeen).toLocaleTimeString(locale) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
