'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiCall } from '@/lib/auth';

interface Announcement {
  id: number;
  title: string;
  content: string;
  is_popup: boolean;
  created_at: string;
}

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
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
    >
      <div
        className="relative max-w-md w-full max-h-[75vh] overflow-y-auto p-6 rounded-lg animate-surface"
        style={{
          background: 'var(--card)',
          color: 'var(--text)',
          boxShadow: 'var(--shadow-lg)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 关闭按钮 */}
        <button
          onClick={() => handleClose(current.id)}
          className="absolute top-3 right-3 text-[var(--text-light)] hover:text-[var(--text)] text-xl leading-none"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}
        >
          ✕
        </button>

        {/* 标题 */}
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.3rem',
            fontStyle: 'italic',
            fontWeight: 900,
            letterSpacing: '0.04em',
            color: 'var(--primary-strong)',
            marginBottom: '14px',
            paddingRight: '28px',
          }}
        >
          📢 {current.title}
        </h2>

        {/* 内容 — 支持 HTML */}
        <div
          style={{ fontSize: '0.92rem', lineHeight: 1.7, color: 'var(--text-sec)' }}
          dangerouslySetInnerHTML={{ __html: current.content }}
        />

        {/* 底部 */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: '20px',
          paddingTop: '14px',
          borderTop: '1px solid var(--border)',
          fontSize: '0.78rem',
          color: 'var(--text-light)',
        }}>
          <span>{new Date(current.created_at).toLocaleDateString('zh-CN')}</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            {popups.length > 1 && currentIndex < popups.length - 1 && (
              <button
                onClick={() => handleClose(current.id)}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  color: 'var(--text-light)',
                  padding: '6px 14px',
                  borderRadius: 'var(--radius)',
                  cursor: 'pointer',
                  fontSize: '0.82rem',
                }}
              >
                下一条
              </button>
            )}
            <button
              onClick={() => {
                // 关闭所有剩余弹窗
                popups.slice(currentIndex).forEach(p => dismissAnnouncement(p.id));
                setPopups([]);
              }}
              style={{
                background: 'transparent',
                border: '1px solid var(--border)',
                color: 'var(--text-light)',
                padding: '6px 14px',
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                fontSize: '0.82rem',
              }}
            >
              不再显示
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
