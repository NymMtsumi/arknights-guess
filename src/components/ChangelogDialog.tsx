'use client';

interface ChangelogDialogProps {
  open: boolean;
  onClose: () => void;
}

const changelog = [
  { date: '2026-07-29', items: [
    '难度曲线重做：简单=热门+六星(150个)，普通=全部，困难=隐藏星级',
    '防连庄：最近5局不重复出现同一干员',
    '战绩历史扩展至最近80局',
    '阵营系统重构：统一 主阵营,子阵营 格式',
    '阵营匹配优化：同主阵营不同子阵营标黄',
    '更新首页描述文案',
  ]},
  { date: '2026-07-28', items: [
    '新增部署位猜测列：高台/地面',
    'NGA人气投票热度曲线：简单~86热门，普通~388，困难~全部',
    '删除9个未实装精英干员（430→421）',
    '子职业PRTS全量校验，修正5条',
    'PRTS性别全量校验，421条全部通过',
    'Cloudflare Pages部署成功，国内直连',
    'GitHub+Vercel+Cloudflare三平台自动部署',
  ]},
  { date: '2026-07-27', items: [
    '新增词缀标签列：18种标签，有相同=黄',
    '新增异格检测：37组异格关系，猜中异格名字标黄',
    '新增上线年份猜测列：同年绿，差1年黄',
    '游戏结束弹窗双按钮：查看战绩 / 再来一把',
    '猜测次数从10减为8次',
    '阵营从PRTS所属势力全量修正163条',
    '搜索精确匹配优先排序',
  ]},
  { date: '2026-07-26', items: [
    '项目初始化：Next.js 16 + Tailwind v4 + TypeScript',
    '双主题系统：Blast暗黑 + 浅色纸质感（复刻shnlfriberg.online）',
    '中英双语国际化',
    '441个干员数据，从ArknightsGameData提取',
    '子职业名称从PRTS全量修正',
    '主标题「理一把」+ 制作人署名',
  ]},
];

export function ChangelogDialog({ open, onClose }: ChangelogDialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="relative max-w-lg w-full max-h-[80vh] overflow-y-auto p-6 rounded-lg"
        style={{
          background: 'var(--card)',
          color: 'var(--text)',
          boxShadow: 'var(--shadow-lg)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-[var(--text-light)] hover:text-[var(--text)] text-xl leading-none"
        >
          ✕
        </button>

        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.5rem',
            fontStyle: 'italic',
            fontWeight: 900,
            letterSpacing: '0.06em',
            color: 'var(--primary)',
            marginBottom: '20px',
          }}
        >
          📋 更新日志
        </h2>

        {changelog.map((entry) => (
          <div key={entry.date} style={{ marginBottom: '18px' }}>
            <div style={{
              fontSize: '0.82rem',
              fontWeight: 700,
              color: 'var(--text-light)',
              marginBottom: '6px',
              borderBottom: '1px solid var(--border)',
              paddingBottom: '4px',
            }}>
              {entry.date}
            </div>
            <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '0.9rem', lineHeight: 1.7, color: 'var(--text-sec)' }}>
              {entry.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
