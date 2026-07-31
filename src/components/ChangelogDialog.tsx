'use client';

interface ChangelogDialogProps {
  open: boolean;
  onClose: () => void;
}

const changelog = [
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
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
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
