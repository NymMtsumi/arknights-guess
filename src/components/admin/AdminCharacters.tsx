'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';

interface Character {
  id: string;
  name: string;
  nameEn: string;
  rarity: number;
  tags: string[];
  class: string;
  faction: string;
  position: string;
  popularity: string;
}

interface CharPage {
  characters: Character[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ===== 样式 =====
const cardStyle: React.CSSProperties = {
  background: 'var(--card)',
  borderRadius: 'var(--radius)',
  padding: '20px',
};

const inpStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  background: 'var(--input-bg)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  fontSize: '0.9rem',
};

const thStyle: React.CSSProperties = {
  padding: '10px 8px',
  textAlign: 'left',
  fontSize: '0.75rem',
  fontWeight: 700,
  color: 'var(--text-light)',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '8px',
  verticalAlign: 'middle',
};

const btnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: 'var(--primary)',
  color: 'var(--bg)',
  border: 'none',
  borderRadius: 'var(--radius)',
  fontSize: '0.85rem',
  fontWeight: 700,
  cursor: 'pointer',
};

const smallBtn: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: '0.75rem',
  border: 'none',
  borderRadius: '3px',
  cursor: 'pointer',
  fontWeight: 600,
};

const pageBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--input-bg)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  cursor: 'pointer',
  fontSize: '0.8rem',
};

const modalOverlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: '20px',
};

const modalContent: React.CSSProperties = {
  background: 'var(--card)',
  borderRadius: 'var(--radius)',
  padding: '24px',
  maxWidth: '560px',
  width: '100%',
  maxHeight: '90vh',
  overflowY: 'auto',
};

const rarityStars = (r: number): string => '★'.repeat(r) + '☆'.repeat(6 - r);

export default function AdminCharacters() {
  const [chars, setChars] = useState<Character[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [rarityFilter, setRarityFilter] = useState(0);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  // Modal state
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<Character | null>(null);
  const [form, setForm] = useState({ name: '', nameEn: '', rarity: 1, class: '', faction: '', position: '', tags: '', popularity: 'normal' });

  // Import state
  const [importPreview, setImportPreview] = useState<{ total: number; added: number; updated: number; skipped: number } | null>(null);
  const [importData, setImportData] = useState<any[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pageSize = 30;
  const baseUrl = getServerUrl();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = getToken();
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      if (rarityFilter > 0) params.set('rarity', String(rarityFilter));
      const res = await fetch(`${baseUrl}/api/admin/characters?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || '加载失败');
      }
      const data: CharPage = await res.json();
      setChars(data.characters);
      setTotal(data.total);
      setPage(data.page);
      setTotalPages(data.totalPages);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, page, search, rarityFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Open add/edit form
  const openAdd = () => {
    setEditTarget(null);
    setForm({ name: '', nameEn: '', rarity: 1, class: '', faction: '', position: '', tags: '', popularity: 'normal' });
    setShowForm(true);
  };

  const openEdit = (c: Character) => {
    setEditTarget(c);
    setForm({
      name: c.name, nameEn: c.nameEn || '', rarity: c.rarity,
      class: c.class || '', faction: c.faction || '', position: c.position || '',
      tags: Array.isArray(c.tags) ? c.tags.join(', ') : '',
      popularity: c.popularity || 'normal',
    });
    setShowForm(true);
  };

  const submitForm = async () => {
    if (!form.name.trim()) {
      setError('干员名称不能为空');
      return;
    }
    setMsg(''); setError('');
    try {
      const token = getToken();
      const body: any = {
        name: form.name.trim(),
        nameEn: form.nameEn.trim(),
        rarity: form.rarity,
        class: form.class.trim(),
        faction: form.faction.trim(),
        position: form.position.trim(),
        tags: form.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean),
        popularity: form.popularity,
      };

      let res;
      if (editTarget) {
        res = await fetch(`${baseUrl}/api/admin/characters/${encodeURIComponent(editTarget.name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch(`${baseUrl}/api/admin/characters`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '操作失败');
      setMsg(editTarget ? '干员已更新' : '干员已添加');
      setShowForm(false);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(`确定删除干员「${name}」？此操作不可撤销。`)) return;
    setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/characters/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '删除失败');
      setMsg(`已删除「${name}」`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  // JSON Import
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMsg(''); setError('');
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('JSON 必须是数组格式');

      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/characters/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ characters: data }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || '导入预览失败');

      setImportData(data);
      setImportPreview(result);
    } catch (err: any) {
      setError(err.message);
    }
    // Reset file input
    if (fileRef.current) fileRef.current.value = '';
  };

  const confirmImport = async () => {
    if (!importData) return;
    setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/characters/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ characters: importData, confirm: true }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || '导入失败');
      setMsg(`导入成功：${result.imported} 条记录`);
      setImportPreview(null);
      setImportData(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Export
  const handleExport = async () => {
    setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/characters/export`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `导出失败 (HTTP ${res.status})`);
      }
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'characters.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setMsg('JSON 已导出');
    } catch (err: any) {
      setError(err.message || '导出失败');
    }
  };

  return (
    <div>
      {/* 搜索 + 操作栏 */}
      <div style={{ ...cardStyle, marginBottom: '16px' }}>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="搜索干员名/英文名/标签..."
            maxLength={64}
            style={{ ...inpStyle, flex: 1, minWidth: '180px', marginBottom: 0 }}
          />
          <select
            value={rarityFilter}
            onChange={e => { setRarityFilter(parseInt(e.target.value)); setPage(1); }}
            style={{
              padding: '8px 12px', background: 'var(--input-bg)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '0.85rem',
            }}
          >
            <option value={0}>全部稀有度</option>
            <option value={6}>★★★★★★ (6星)</option>
            <option value={5}>★★★★★ (5星)</option>
            <option value={4}>★★★★ (4星)</option>
            <option value={3}>★★★ (3星)</option>
            <option value={2}>★★ (2星)</option>
            <option value={1}>★ (1星)</option>
          </select>
          <button onClick={openAdd} style={btnStyle}>+ 添加干员</button>
          <button onClick={handleExport} style={{ ...btnStyle, background: 'var(--input-bg)', color: 'var(--text)', border: '1px solid var(--border)' }}>
            导出 JSON
          </button>
          <label style={{ ...btnStyle, background: 'var(--input-bg)', color: 'var(--text)', border: '1px solid var(--border)', cursor: 'pointer' }}>
            JSON 导入
            <input ref={fileRef} type="file" accept=".json" onChange={handleFileSelect} style={{ display: 'none' }} />
          </label>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-light)', whiteSpace: 'nowrap' }}>
            共 {total} 位干员
          </span>
        </div>
      </div>

      {/* 消息 */}
      {msg && <p style={{ color: 'var(--correct)', fontSize: '0.8rem', marginBottom: '10px' }}>{msg}</p>}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: '10px' }}>{error}</p>}

      {/* 导入预览 */}
      {importPreview && (
        <div style={{ ...cardStyle, marginBottom: '16px', border: '1px solid var(--primary)' }}>
          <h4 style={{ margin: '0 0 10px', fontSize: '0.95rem' }}>导入预览</h4>
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-light)' }}>
            共 {importPreview.total} 条：<span style={{ color: 'var(--correct)' }}>新增 {importPreview.added}</span>，
            <span style={{ color: '#f0ad4e' }}>更新 {importPreview.updated}</span>，
            <span style={{ color: 'var(--danger)' }}>跳过 {importPreview.skipped}</span>
          </p>
          <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
            <button onClick={confirmImport} style={btnStyle}>确认导入</button>
            <button onClick={() => { setImportPreview(null); setImportData(null); }} style={{ ...btnStyle, background: 'transparent', color: 'var(--text-light)', border: '1px solid var(--border)' }}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 干员列表 */}
      <div style={{ ...cardStyle, overflowX: 'auto' }}>
        {loading ? (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: '40px' }}>加载中...</p>
        ) : chars.length === 0 ? (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: '40px' }}>无匹配干员</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                <th style={thStyle}>名称</th>
                <th style={thStyle}>稀有度</th>
                <th style={thStyle}>职业</th>
                <th style={thStyle}>阵营</th>
                <th style={thStyle}>标签</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {chars.map(c => (
                <tr key={c.id || c.name} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={tdStyle}>
                    <strong>{c.name}</strong>
                    {c.nameEn && <div style={{ fontSize: '0.7rem', color: 'var(--text-light)' }}>{c.nameEn}</div>}
                  </td>
                  <td style={{ ...tdStyle, color: '#f0ad4e', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {rarityStars(c.rarity)}
                  </td>
                  <td style={tdStyle}>{c.class || '—'}</td>
                  <td style={tdStyle}>{c.faction || '—'}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                      {(Array.isArray(c.tags) ? c.tags : []).slice(0, 3).map(t => (
                        <span key={t} style={{ fontSize: '0.65rem', padding: '1px 5px', background: 'var(--input-bg)', borderRadius: '3px', color: 'var(--text-light)' }}>{t}</span>
                      ))}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button onClick={() => openEdit(c)} style={{ ...smallBtn, background: 'var(--primary)', color: 'var(--bg)' }}>编辑</button>
                      <button onClick={() => handleDelete(c.name)} style={{ ...smallBtn, background: 'var(--danger)', color: '#fff' }}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* 分页 */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
            <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} style={{ ...pageBtn, opacity: page <= 1 ? 0.3 : 1 }}>
              上一页
            </button>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-light)' }}>{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))} style={{ ...pageBtn, opacity: page >= totalPages ? 0.3 : 1 }}>
              下一页
            </button>
          </div>
        )}
      </div>

      {/* 添加/编辑模态框 */}
      {showForm && (
        <div style={modalOverlay} onClick={e => { if (e.target === e.currentTarget) setShowForm(false); }}>
          <div style={modalContent}>
            <h3 style={{ margin: '0 0 16px', fontSize: '1.1rem' }}>{editTarget ? '编辑干员' : '添加干员'}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <label style={labelStyle}>名称 *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} maxLength={64} style={inpStyle} />
              </div>
              <div>
                <label style={labelStyle}>英文名</label>
                <input value={form.nameEn} onChange={e => setForm({ ...form, nameEn: e.target.value })} maxLength={64} style={inpStyle} />
              </div>
              <div>
                <label style={labelStyle}>稀有度</label>
                <select value={form.rarity} onChange={e => setForm({ ...form, rarity: parseInt(e.target.value) })} style={inpStyle}>
                  {[1,2,3,4,5,6].map(n => <option key={n} value={n}>{rarityStars(n)}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>职业</label>
                <input value={form.class} onChange={e => setForm({ ...form, class: e.target.value })} maxLength={32} style={inpStyle} />
              </div>
              <div>
                <label style={labelStyle}>阵营</label>
                <input value={form.faction} onChange={e => setForm({ ...form, faction: e.target.value })} maxLength={32} style={inpStyle} />
              </div>
              <div>
                <label style={labelStyle}>位置</label>
                <input value={form.position} onChange={e => setForm({ ...form, position: e.target.value })} maxLength={16} style={inpStyle} />
              </div>
              <div>
                <label style={labelStyle}>热度</label>
                <select value={form.popularity} onChange={e => setForm({ ...form, popularity: e.target.value })} style={inpStyle}>
                  <option value="hot">热门 (hot)</option>
                  <option value="normal">普通 (normal)</option>
                  <option value="cold">冷门 (cold)</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>标签（逗号分隔）</label>
                <input value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })} placeholder="治疗, 爆发..." maxLength={200} style={inpStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button onClick={() => setShowForm(false)} style={{ ...btnStyle, background: 'transparent', color: 'var(--text-light)', border: '1px solid var(--border)' }}>
                取消
              </button>
              <button onClick={submitForm} style={btnStyle}>
                {editTarget ? '保存' : '添加'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: 'var(--text-light)',
  marginBottom: '4px',
};
