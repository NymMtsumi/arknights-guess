'use client';

import { useState, useEffect, useCallback } from 'react';
import DOMPurify from 'dompurify';
import { apiCall } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import type { Announcement } from './ChangelogDialog';

const DISMISSED_KEY = 'arknights-dismissed-announcements';

/**
 * 读取「已读公告」列表。
 *
 * 返回 `ok: false` 表示 **localStorage 根本用不了**（Safari 无痕 / 「阻止所有 Cookie」/
 * 隐私扩展 → getItem 直接抛 SecurityError）。这件事必须让调用方看得见：
 * 读不到 = 记不住已读 = 每次进页面都会重弹，而弹窗是一层
 * `position: fixed; inset: 0; z-index: 60` 的全屏遮罩，会把整页的点击全部吃掉。
 * 所以存储不可用时**宁可不弹**（见 load()）。
 */
function readDismissed(): { ok: boolean; ids: number[] } {
  if (typeof window === 'undefined') return { ok: true, ids: [] };
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return { ok: true, ids: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { ok: false, ids: [] };
  }
}

/**
 * 会话内存兜底。localStorage 写不进去时（无痕 / 配额满 / 被禁），
 * 至少让「本次会话内关掉的弹窗不再弹」—— 否则用户点了关闭却什么都没发生。
 */
const sessionDismissed = new Set<number>();

/**
 * 记下这些公告已读。
 *
 * 🔴 **绝不抛异常**：调用方是在点击处理里**同步**调它的，一旦抛错，
 * 后面的 `setPopups([])` 就执行不到，弹窗永远关不掉、整页被遮罩锁死
 * —— 旧实现（`localStorage.setItem` 裸调）正是这个故障。
 */
function dismissIds(ids: number[]) {
  for (const id of ids) sessionDismissed.add(id);

  const { ok, ids: stored } = readDismissed();
  if (!ok) return; // 存不住，完全靠 sessionDismissed 兜底

  let changed = false;
  for (const id of ids) {
    if (!stored.includes(id)) {
      stored.push(id);
      changed = true;
    }
  }
  if (!changed) return;

  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(stored));
  } catch {
    // 写入失败（配额满等）：sessionDismissed 已经记上了，本次会话仍然关得掉
  }
}

export function AnnouncementPopup() {
  const { t, locale } = useI18n();
  const [popups, setPopups] = useState<Announcement[]>([]);
  // 服务端**全部** is_popup 公告的 id（不只是当前展示的这 3 条）。
  // 「关闭全部」按它来记 —— 只记 slice(0,3) 那 3 条的话，
  // 第 4 条会在下次加载时重新弹出来（生产上现在正好是 4 条 is_popup）。
  const [allPopupIds, setAllPopupIds] = useState<number[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await apiCall('/api/announcements');
      const { ok, ids } = readDismissed();

      if (!ok) {
        // 🔴 存储不可用 → 已读记不住 → 每次加载都会重弹 → 全屏遮罩把整页锁死。
        // 宁可这次不弹：公告仍可在改动日志里读到，但页面必须能用。
        setPopups([]);
        setAllPopupIds([]);
        return;
      }

      const active = (data as Announcement[])
        .filter(a => a.is_popup && !ids.includes(a.id) && !sessionDismissed.has(a.id));
      setAllPopupIds(active.map(a => a.id));
      setPopups(active.slice(0, 3)); // 最多同时展示3个弹窗
    } catch {
      // API 不可用时静默失败
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 清空整块弹窗 UI，并把队列里**全部** id 记为已读。
   *
   * 两条退出路径（逐条 ✕ 走到底 / 「关闭全部」）共用同一份实现 —— 这是刻意的：
   * 只要它们各写一份，就总有一条会漏掉「清空 UI 却忘了记已读」，
   * 于是没展示过的公告下次重新弹出来（实测过：dismissed=[8,7,6] → 重载后弹窗 1 层）。
   */
  const dismissAll = (fallbackId: number) => {
    // allPopupIds 是服务端全部 is_popup；为空的兜底路径用当前展示的 + 触发者。
    // 无需去重 —— dismissIds 内部按 stored/sessionDismissed 各自判重。
    const ids = allPopupIds.length ? allPopupIds : [...popups.map(p => p.id), fallbackId];
    setPopups([]);
    setAllPopupIds([]);
    setCurrentIndex(0);
    dismissIds(ids);
  };

  const handleClose = (id: number) => {
    // ⚠️ **先推进 UI、后落盘**。顺序反了的话，落盘一旦抛错就执行不到这里 ——
    // 弹窗永远关不掉，而它是全屏遮罩，整个页面就此点不动。
    if (currentIndex < popups.length - 1) {
      setCurrentIndex(prev => prev + 1);
      dismissIds([id]);
      return;
    }
    dismissAll(id);
  };

  if (loading || popups.length === 0) return null;

  const current = popups[currentIndex];
  if (!current) return null;

  return (
    <div className="modal-mask top">
      <div className="dlg mc sm animate-surface">
        <div className="mdl">
          {/* 关闭按钮 */}
          <div className="mhd">
            <h2>📢 {current.title}</h2>
            <button onClick={() => handleClose(current.id)} className="x">
              ✕
            </button>
          </div>

          {/* 内容 — 支持 HTML */}
          <div
            className="anc"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(current.content) }}
          />

          {/* 底部 */}
          <div className="mfoot">
            {/* 日期跟随界面语言，不再写死 zh-CN —— 英文用户此前会看到中文格式的日期 */}
            <span className="d3">{new Date(current.created_at).toLocaleDateString(locale)}</span>
            <div className="flex gap-2">
              {popups.length > 1 && currentIndex < popups.length - 1 && (
                <button
                  onClick={() => handleClose(current.id)}
                  className="btn-o"
                >
                  {t('announcement.next')}
                </button>
              )}
              <button
                onClick={() => dismissAll(current.id)}
                className="btn-p"
              >
                {t('announcement.dismissAll')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
