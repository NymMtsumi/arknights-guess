'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';

interface Announcement {
  id: number;
  title: string;
  content: string;
  is_popup: boolean;
  created_at: string;
}

export default function AdminAnnouncements() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [isPopup, setIsPopup] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const baseUrl = getServerUrl();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/announcements`);
      const data = await res.json();
      if (Array.isArray(data)) setItems(data);
    } catch {
      // 静默失败
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => { load(); }, [load]);

  const publish = async () => {
    if (!title.trim() || !content.trim()) {
      setError('标题和内容不能为空');
      return;
    }
    setPublishing(true); setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/announcements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ title: title.trim(), content: content.trim(), is_popup: isPopup }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '发布失败');
      setTitle(''); setContent(''); setIsPopup(false);
      setMsg('公告已发布');
      await load();
    } catch (err: any) {
      setError(err.message || '发布失败');
    } finally {
      setPublishing(false);
    }
  };

  const remove = async (id: number) => {
    if (!window.confirm('确定删除此公告？')) return;
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/announcements/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('删除失败');
      setMsg('公告已删除');
      await load();
    } catch (err: any) {
      setError(err.message || '删除失败');
    }
  };

  // ===== 样式 =====
  const cardStyle: React.CSSProperties = {
    background: 'var(--card)',
    borderRadius: 'var(--radius)',
    padding: '20px',
    marginBottom: '20px',
  };

  const inpStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontSize: '0.95rem',
    marginBottom: '10px',
  };

  const btnStyle: React.CSSProperties = {
    padding: '8px 18px',
    background: 'var(--primary)',
    color: 'var(--bg)',
    border: 'none',
    borderRadius: 'var(--radius)',
    fontSize: '0.85rem',
    fontWeight: 700,
    cursor: 'pointer',
  };

  const dangerBtn: React.CSSProperties = {
    ...btnStyle,
    background: 'var(--danger)',
    padding: '4px 10px',
    fontSize: '0.75rem',
  };

  return (
    <div>
      {/* 发布表单 */}
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 16px', fontSize: '1rem' }}>发布新公告</h3>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="公告标题"
          maxLength={128}
          style={inpStyle}
        />
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="公告内容（支持 HTML）"
          maxLength={10000}
          rows={4}
          style={{ ...inpStyle, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-light)' }}>
            <input type="checkbox" checked={isPopup} onChange={e => setIsPopup(e.target.checked)} />
            弹窗公告
          </label>
          <button onClick={publish} style={btnStyle} disabled={publishing}>
            {publishing ? '发布中...' : '发布'}
          </button>
        </div>
        {msg && <p style={{ color: 'var(--correct)', fontSize: '0.8rem', marginTop: '10px' }}>{msg}</p>}
        {error && <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginTop: '10px' }}>{error}</p>}
      </div>

      {/* 已有公告 */}
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 16px', fontSize: '1rem' }}>已有公告 ({items.length})</h3>
        {loading ? (
          <p style={{ color: 'var(--text-light)' }}>加载中...</p>
        ) : items.length === 0 ? (
          <p style={{ color: 'var(--text-light)' }}>暂无公告</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {items.map(item => (
              <div key={item.id} style={{
                padding: '12px',
                background: 'var(--input-bg)',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div>
                    <strong style={{ fontSize: '0.9rem' }}>{item.title}</strong>
                    {item.is_popup && (
                      <span style={{ marginLeft: '8px', fontSize: '0.7rem', background: '#f0ad4e', color: '#000', padding: '1px 5px', borderRadius: '3px' }}>弹窗</span>
                    )}
                    <span style={{ marginLeft: '8px', fontSize: '0.7rem', color: 'var(--text-light)' }}>
                      {item.created_at?.slice(0, 16)?.replace('T', ' ')}
                    </span>
                  </div>
                  <button onClick={() => remove(item.id)} style={dangerBtn}>删除</button>
                </div>
                <p style={{ margin: '6px 0 0', fontSize: '0.8rem', color: 'var(--text-light)', wordBreak: 'break-all' }}>
                  {item.content.length > 200 ? item.content.slice(0, 200) + '...' : item.content}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
