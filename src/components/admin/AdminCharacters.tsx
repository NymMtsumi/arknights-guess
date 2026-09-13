'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { adminSortMark, ADMIN_PAGE_SIZES } from './ui';

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

const rarityStars = (r: number): string => '★'.repeat(r) + '☆'.repeat(6 - r);

export default function AdminCharacters() {
  const { t } = useI18n();
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

  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
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
      if (search) params.set('search', search);
      if (rarityFilter > 0) params.set('rarity', String(rarityFilter));
      const res = await fetch(`${baseUrl}/api/admin/characters?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || t('admin.common.loadFailed'));
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
  }, [baseUrl, page, search, rarityFilter, sortKey, sortDir, pageSize, t]);

  useEffect(() => { load(); }, [load]);

  /* 干员列表默认按名字升序（A→Z 更符合找人的直觉），其余列表默认按时间降序。
     所以这里换列时的兜底方向也跟着列走，见 toggleSort。 */
  const toggleSort = (key: string, defaultDir: 'asc' | 'desc' = 'desc') => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(defaultDir); }
    setPage(1);
  };

  const changePageSize = (size: number) => { setPageSize(size); setPage(1); };

  const sortTh = (key: string, label: string, defaultDir: 'asc' | 'desc' = 'desc') => {
    const active = sortKey === key;
    return (
      <th
        className={'so' + (active ? ' on' : '')}
        onClick={() => toggleSort(key, defaultDir)}
        title={t('admin.common.sortHint')}
      >
        {label} <i>{adminSortMark(active, sortDir)}</i>
      </th>
    );
  };

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
      setError(t('admin.characters.nameRequired'));
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
      if (!res.ok) throw new Error(data.error || t('admin.common.opFailed'));
      setMsg(editTarget ? t('admin.characters.updated') : t('admin.characters.added'));
      setShowForm(false);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(t('admin.characters.deleteConfirm', { name }))) return;
    setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/characters/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.common.deleteFailed'));
      setMsg(t('admin.characters.deleted', { name }));
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
      if (!Array.isArray(data)) throw new Error(t('admin.characters.jsonArrayRequired'));

      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/characters/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ characters: data }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || t('admin.characters.previewFailed'));

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
      if (!res.ok) throw new Error(result.error || t('admin.characters.importFailed'));
      setMsg(t('admin.characters.importSuccess', { count: result.imported }));
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
        throw new Error(d.error || t('admin.characters.exportFailed', { status: res.status }));
      }
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'characters.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setMsg(t('admin.characters.exported'));
    } catch (err: any) {
      setError(err.message || t('admin.characters.exportFailedPlain'));
    }
  };

  return (
    <div>
      {/* 搜索 + 操作栏 */}
      <div className="card">
        {/* 一行控件：词汇表无 .cfg-ct/.bar-actions，借用 .card-hd 的 flex + gap + wrap + 居中 */}
        <div className="card-hd">
          <input
            className="search-input bare"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder={t('admin.characters.searchPlaceholder')}
            maxLength={64}
          />
          <select
            className="sel"
            value={rarityFilter}
            onChange={e => { setRarityFilter(parseInt(e.target.value)); setPage(1); }}
          >
            <option value={0}>{t('admin.characters.allRarity')}</option>
            {[6, 5, 4, 3, 2, 1].map(n => (
              <option key={n} value={n}>
                {rarityStars(n)} {t('admin.characters.raritySuffix', { n })}
              </option>
            ))}
          </select>
          <button className="btn-p" onClick={openAdd}>{t('admin.characters.addBtn')}</button>
          <button className="btn-o" onClick={handleExport}>{t('admin.characters.exportJson')}</button>
          <label className="btn-o">
            {t('admin.characters.importJson')}
            <input ref={fileRef} type="file" accept=".json" onChange={handleFileSelect} hidden />
          </label>
          <span className="cnt">{t('admin.characters.total', { count: total })}</span>
        </div>
      </div>

      {/* 消息 */}
      {msg && <p className="alert alert-ok">{msg}</p>}
      {error && <p className="alert alert-dan">{error}</p>}

      {/* 导入预览 —— 两阶段：① 预览已回（本轮请求结束）② 待确认（点了才发第二次请求）。
          这里只是外观，两步的分野、confirm 参数、两次 fetch 全部原样保留。 */}
      {importPreview && (
        <div className="card">
          <div className="card-hd">
            <h2>{t('admin.characters.importPreview')}</h2>
          </div>
          <div className="stage">
            <span className="sn2 done">1</span>
            <span className="stx"><b>{t('admin.characters.importTotal', { count: importPreview.total })}</b></span>
            <span className="sn2 on">2</span>
            <span className="stx"><b>{t('admin.characters.confirmImport')}</b></span>
          </div>
          <div className="tally">
            <span className="t-add">{t('admin.characters.importAdded', { count: importPreview.added })}</span>
            <span className="t-upd">{t('admin.characters.importUpdated', { count: importPreview.updated })}</span>
            <span className="t-skip">{t('admin.characters.importSkipped', { count: importPreview.skipped })}</span>
          </div>
          {/* 操作行复用 .tally 的 flex/gap（设计稿的 .bar-actions 未随词汇表落地） */}
          <div className="tally">
            <button className="btn-p" onClick={confirmImport}>{t('admin.characters.confirmImport')}</button>
            <button className="btn-o" onClick={() => { setImportPreview(null); setImportData(null); }}>
              {t('admin.common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* 干员列表 */}
      <div className="card">
        {/* 页长条：留在表格上方（原位置），所以没有并进底部 pager */}
        <div className="pager">
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
        ) : chars.length === 0 ? (
          <div className="empty"><div className="etx">{t('admin.characters.noMatch')}</div></div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  {sortTh('name', t('admin.characters.colName'), 'asc')}
                  {sortTh('rarity', t('admin.characters.colRarity'))}
                  <th>{t('admin.characters.colClass')}</th>
                  <th>{t('admin.characters.colFaction')}</th>
                  <th>{t('admin.characters.colTags')}</th>
                  <th>{t('admin.characters.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {chars.map(c => (
                  <tr key={c.id || c.name}>
                    <td className="k">
                      {c.name}
                      {c.nameEn && <div className="mono">{c.nameEn}</div>}
                    </td>
                    <td>
                      <span className="bdg bdg-warn">{rarityStars(c.rarity)}</span>
                    </td>
                    <td>{c.class || '—'}</td>
                    <td>{c.faction || '—'}</td>
                    <td>
                      {/* 行内小件成排：词汇表里只有 .pgs 是「无外边距的 flex 行 + gap」 */}
                      <div className="pgs">
                        {(Array.isArray(c.tags) ? c.tags : []).slice(0, 3).map(t => (
                          <span key={t} className="bdg bdg-no">{t}</span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div className="pgs">
                        <button className="btn-sm p" onClick={() => openEdit(c)}>{t('admin.common.edit')}</button>
                        <button className="btn-sm dan" onClick={() => handleDelete(c.name)}>{t('admin.common.delete')}</button>
                      </div>
                    </td>
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
                className={'pg' + (page <= 1 ? ' dis' : '')}
                disabled={page <= 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}
              >
                {t('admin.common.prevPage')}
              </button>
              <button
                className={'pg' + (page >= totalPages ? ' dis' : '')}
                disabled={page >= totalPages}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              >
                {t('admin.common.nextPage')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 添加/编辑模态框 */}
      {showForm && (
        <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) setShowForm(false); }}>
          <div className="dlg mc">
            <div className="dt">
              <span className="di">✎</span>
              {editTarget ? t('admin.characters.editTitle') : t('admin.characters.addTitle')}
            </div>
            <div className="db">
              {/* 表单两列网格沿用 .console-2col（词汇表里唯一的 1fr 1fr 网格） */}
              <div className="console-2col">
                <div>
                  <label className="cfg-lb">{t('admin.characters.fName')}</label>
                  <input className="search-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} maxLength={64} />
                </div>
                <div>
                  <label className="cfg-lb">{t('admin.characters.fNameEn')}</label>
                  <input className="search-input" value={form.nameEn} onChange={e => setForm({ ...form, nameEn: e.target.value })} maxLength={64} />
                </div>
                <div>
                  <label className="cfg-lb">{t('admin.characters.fRarity')}</label>
                  <select className="sel" value={form.rarity} onChange={e => setForm({ ...form, rarity: parseInt(e.target.value) })}>
                    {[1,2,3,4,5,6].map(n => <option key={n} value={n}>{rarityStars(n)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="cfg-lb">{t('admin.characters.fClass')}</label>
                  <input className="search-input" value={form.class} onChange={e => setForm({ ...form, class: e.target.value })} maxLength={32} />
                </div>
                <div>
                  <label className="cfg-lb">{t('admin.characters.fFaction')}</label>
                  <input className="search-input" value={form.faction} onChange={e => setForm({ ...form, faction: e.target.value })} maxLength={32} />
                </div>
                <div>
                  <label className="cfg-lb">{t('admin.characters.fPosition')}</label>
                  <input className="search-input" value={form.position} onChange={e => setForm({ ...form, position: e.target.value })} maxLength={16} />
                </div>
                <div>
                  <label className="cfg-lb">{t('admin.characters.fPopularity')}</label>
                  <select className="sel" value={form.popularity} onChange={e => setForm({ ...form, popularity: e.target.value })}>
                    <option value="hot">{t('admin.characters.popHot')}</option>
                    <option value="normal">{t('admin.characters.popNormal')}</option>
                    <option value="cold">{t('admin.characters.popCold')}</option>
                  </select>
                </div>
                <div>
                  <label className="cfg-lb">{t('admin.characters.fTags')}</label>
                  <input className="search-input" value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })} placeholder={t('admin.characters.fTagsPlaceholder')} maxLength={200} />
                </div>
              </div>
            </div>
            <div className="df">
              <button className="btn-o" onClick={() => setShowForm(false)}>
                {t('admin.common.cancel')}
              </button>
              <button className="btn-p" onClick={submitForm}>
                {editTarget ? t('admin.common.save') : t('admin.characters.add')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
