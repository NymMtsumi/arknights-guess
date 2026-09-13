'use client';

import { useState, useEffect, useCallback } from 'react';
import DOMPurify from 'dompurify';
import { apiCall } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import type { Announcement } from './ChangelogDialog';

const DISMISSED_KEY = 'arknights-dismissed-announcements';

function getDismissed(): number[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function dismissAnnouncement(id: number) {
  const dismissed = getDismissed();
  if (!dismissed.includes(id)) {
    dismissed.push(id);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
  }
}

export function AnnouncementPopup() {
  const { t, locale } = useI18n();
  const [popups, setPopups] = useState<Announcement[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await apiCall('/api/announcements');
      const dismissed = getDismissed();
      const active = (data as Announcement[])
        .filter(a => a.is_popup && !dismissed.includes(a.id))
        .slice(0, 3); // 最多同时展示3个弹窗
      setPopups(active);
    } catch {
      // API 不可用时静默失败
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleClose = (id: number) => {
    dismissAnnouncement(id);
    if (currentIndex < popups.length - 1) {
      setCurrentIndex(prev => prev + 1);
    } else {
      setPopups([]);
    }
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
                onClick={() => {
                  // 关闭所有剩余弹窗
                  popups.slice(currentIndex).forEach(p => dismissAnnouncement(p.id));
                  setPopups([]);
                }}
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
