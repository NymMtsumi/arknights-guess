'use client';

import { useState, useEffect, useCallback } from 'react';
import DOMPurify from 'dompurify';
import { apiCall } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

interface ChangelogDialogProps {
  open: boolean;
  onClose: () => void;
}

export interface Announcement {
  id: number;
  title: string;
  content: string;
  is_popup: boolean;
  created_at: string;
}

// 历史硬编码日志，作为 API 不可用时的 fallback
const HISTORICAL_CHANGELOG = [
  { date: '2026-08-02', items: [
    '更新了服务器和域名，优化了多人对战的体验',
    '修复和优化了阵营匹配的逻辑',
    '更新了干员列表，数据库中加入夏活新干员',
    '为多人模式增添了难度选择（简单/普通/困难）',
    '优化了多人模式的体验，每一小局结算后有时间查看答案',
    '修复了多人模式的一些 bug（时间耗尽平局、结算卡住等）',
  ]},
  { date: '2026-08-01', items: [
    '多人对战模式：BO3/BO5/BO7，4位纯数字房间码，120秒倒计时',
    '对手颜色网格：实时查看对方每列绿/黄/灰状态，不暴露具体内容',
    '放弃确认弹窗，双方都放弃直接平局进下一局',
    '断线检测：30秒未重连自动判负，手机切后台不断线',
    '自动重连：切回浏览器自动恢复游戏',
    '再理一把：双方同意不解散房间直接下一轮BO',
    '服务器统一分配目标，两人猜同一干员',
    '昵称记忆：自动记住上次昵称',
    '战绩系统接入多人模式',
    '移除 Umami 统计脚本',
    '性能优化：修复首页按钮卡死问题',
  ]},
  { date: '2026-07-31', items: [
    'NGA 人气投票热度曲线：简单=热门+六星(150)，普通=普通(388)，困难=全部(421)',
    '防连庄：最近5局不重复抽取同一干员',
    '战绩历史扩展至最近80局，新增刷新按钮',
    '部署位猜测列：高台/地面',
    '阵营系统重构：主阵营,子阵营格式，同主阵营标黄',
    '上线年份、词缀标签猜测列',
    '异格检测：37组异格关系，猜中异格名字标黄',
    '搜索精确匹配优先、回车确认',
    '游戏结束弹窗双按钮：查看战绩/再来一把',
    '猜测次数从10次减少为8次',
    '3平台自动部署：GitHub→Vercel+Cloudflare Pages',
    'Cloudflare Pages 国内直连部署',
  ]},
  { date: '2026-07-30', items: [
    '项目上线：Next.js 16 + Tailwind v4 + TypeScript',
    '双主题：Blast暗黑 + 浅色纸质感（复刻 shnlfriberg.online）',
    '中英双语国际化',
    '421个干员数据：从 ArknightsGameData 提取，PRTS 交叉校验',
    '主标题"理一把"',
    '制作人：若叶家若麦',
    '阿里云 ECS 部署对战服务器',
  ]},
];

export function ChangelogDialog({ open, onClose }: ChangelogDialogProps) {
  const { t } = useI18n();
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [apiOk, setApiOk] = useState(false);

  const load = useCallback(async () => {
    if (!open) return;
    try {
      const data = await apiCall('/api/announcements');
      setAnnouncements(data as Announcement[]);
      setApiOk(true);
    } catch {
      setApiOk(false);
    }
  }, [open]);

  useEffect(() => {
    load();
  }, [load]);

  if (!open) return null;

  const hasApiData = apiOk && announcements.length > 0;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="dlg mc" onClick={(e) => e.stopPropagation()}>
        <div className="mdl">
          <div className="mhd">
            <h2>{t('changelog.title')}</h2>
            <button onClick={onClose} className="x">
              ✕
            </button>
          </div>

          {hasApiData ? (
            <div className="log">
              {announcements.map((a) => (
                <div key={a.id} className="ent">
                  <div className="d2 flex items-baseline justify-between gap-3">
                    <span>{a.title}</span>
                    <span>
                      {new Date(a.created_at).toLocaleDateString('zh-CN')}
                    </span>
                  </div>
                  <div
                    className="anc"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(a.content) }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="log">
              {HISTORICAL_CHANGELOG.map((entry) => (
                <div key={entry.date} className="ent">
                  <div className="d2">{entry.date}</div>
                  <ul>
                    {entry.items.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
