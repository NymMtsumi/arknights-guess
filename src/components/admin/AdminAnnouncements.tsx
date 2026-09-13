'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

interface Announcement {
  id: number;
  title: string;
  content: string;
  is_popup: boolean;
  created_at: string;
}

export default function AdminAnnouncements() {
  const { t } = useI18n();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [isPopup, setIsPopup] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editIsPopup, setEditIsPopup] = useState(false);

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
      setError(t('admin.announcements.titleRequired'));
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
      if (!res.ok) throw new Error(data.error || t('admin.announcements.publishFailed'));
      setTitle(''); setContent(''); setIsPopup(false);
      setMsg(t('admin.announcements.published'));
      await load();
    } catch (err: any) {
      setError(err.message || t('admin.announcements.publishFailed'));
    } finally {
      setPublishing(false);
    }
  };

  const remove = async (id: number) => {
    if (!window.confirm(t('admin.announcements.deleteConfirm'))) return;
    try {
      const token = getToken();
      if (!token) {
        setError(t('admin.announcements.notLoggedIn'));
        return;
      }
      const res = await fetch(`${baseUrl}/api/admin/announcements/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        // 尝试解析服务器错误消息
        let serverMsg = '';
        try { const d = await res.json(); serverMsg = d.error || ''; } catch {}
        throw new Error(serverMsg || t('admin.announcements.deleteFailedHttp', { status: res.status }));
      }
      setMsg(t('admin.announcements.deleted'));
      await load();
    } catch (err: any) {
      // 区分网络错误和服务器错误
      const msg = err.message || '';
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        setError(t('admin.announcements.networkError'));
      } else {
        setError(msg || t('admin.common.deleteFailed'));
      }
    }
  };

  const startEdit = (item: Announcement) => {
    setEditingId(item.id);
    setEditTitle(item.title);
    setEditContent(item.content);
    setEditIsPopup(item.is_popup);
    setMsg(''); setError('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditTitle('');
    setEditContent('');
    setEditIsPopup(false);
  };

  const saveEdit = async () => {
    if (!editTitle.trim() || !editContent.trim()) {
      setError(t('admin.announcements.titleRequired'));
      return;
    }
    setPublishing(true); setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/announcements/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ title: editTitle.trim(), content: editContent.trim(), is_popup: editIsPopup }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.announcements.updateFailed'));
      setMsg(t('admin.announcements.updated'));
      setEditingId(null);
      await load();
    } catch (err: any) {
      setError(err.message || t('admin.announcements.updateFailed'));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div>
      {/* 发布表单 */}
      <div className="card">
        <div className="card-hd">
          <h2>{t('admin.announcements.newTitle')}</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={t('admin.announcements.titlePlaceholder')}
            maxLength={128}
            className="search-input"
          />
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder={t('admin.announcements.contentPlaceholder')}
            maxLength={10000}
            rows={4}
            className="search-input"
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <label className="cfg-ck">
            <input type="checkbox" checked={isPopup} onChange={e => setIsPopup(e.target.checked)} />
            {t('admin.announcements.isPopup')}
          </label>
          <button onClick={publish} className="btn-p" disabled={publishing}>
            {publishing ? t('admin.announcements.publishing') : t('admin.announcements.publish')}
          </button>
        </div>
        {msg && <p className="alert alert-ok">{msg}</p>}
        {error && <p className="alert alert-dan">{error}</p>}
      </div>

      {/* 已有公告 */}
      <div className="card">
        <div className="card-hd">
          <h2>{t('admin.announcements.existing', { count: items.length })}</h2>
        </div>
        {loading ? (
          <div className="sk"><i /><i /><i /><i /></div>
        ) : items.length === 0 ? (
          <div className="empty">
            <div className="etx">{t('admin.announcements.empty')}</div>
          </div>
        ) : (
          <div>
            {items.map(item => (
              // 编辑中的那条加 .on 高亮：编辑表单和展示态长得很像，不标出来分不清在改哪条
              <div key={item.id} className={editingId === item.id ? 'card on' : 'card'}>
                {editingId === item.id ? (
                  /* 编辑模式 */
                  <div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <input
                        value={editTitle}
                        onChange={e => setEditTitle(e.target.value)}
                        placeholder={t('admin.announcements.titlePlaceholder')}
                        maxLength={128}
                        className="search-input"
                      />
                      <textarea
                        value={editContent}
                        onChange={e => setEditContent(e.target.value)}
                        placeholder={t('admin.announcements.contentPlaceholder')}
                        maxLength={10000}
                        rows={4}
                        className="search-input"
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
                      <label className="cfg-ck">
                        <input type="checkbox" checked={editIsPopup} onChange={e => setEditIsPopup(e.target.checked)} />
                        {t('admin.announcements.isPopup')}
                      </label>
                      <button onClick={saveEdit} className="btn-p" disabled={publishing}>
                        {publishing ? t('admin.common.saving') : t('admin.common.save')}
                      </button>
                      <button onClick={cancelEdit} className="btn-o">
                        {t('admin.common.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  /* 展示模式 */
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                      <div>
                        <strong>{item.title}</strong>
                        {item.is_popup && (
                          <span className="bdg bdg-mc" style={{ marginLeft: 8 }}>{t('admin.announcements.popupBadge')}</span>
                        )}
                        <span className="mono" style={{ marginLeft: 8 }}>
                          {item.created_at?.slice(0, 16)?.replace('T', ' ')}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => startEdit(item)} className="btn-sm p">{t('admin.common.edit')}</button>
                        <button onClick={() => remove(item.id)} className="btn-sm dan">{t('admin.common.delete')}</button>
                      </div>
                    </div>
                    <p className="sec-note" style={{ wordBreak: 'break-all' }}>
                      {item.content.length > 200 ? item.content.slice(0, 200) + '...' : item.content}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
