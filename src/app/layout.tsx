import type { Metadata } from "next";
import Script from "next/script";
import { Providers } from "./providers";
import { VersionCheck } from "@/components/VersionCheck";
import { HistoryInit } from "@/components/HistoryInit";
import "./globals.css";

export const metadata: Metadata = {
  title: "明日方舟 — 干员猜测游戏",
  description: "猜明日方舟干员！基于 blast.tv/counter-strikle 灵感的角色猜测游戏。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // data-ui 是**字面量**，不是脚本设的。
  // V12 就是当前唯一的皮肤，所以它从 HTML 第一个字节起就成立，首帧即终态，
  // 不存在「先画旧 UI、再被脚本纠正」的窗口期。
  // 早先的写法是把 data-ui 交给 theme-init 脚本设（值取自 ui-skin），
  // 并为此写了预执行脚本 + CI 哨兵 —— 那套复杂度只服务于「运行时切回 classic」
  // 这个逃生舱。该逃生舱已移除：回退改用改代码路径（见 v12.css 头部注释）。
  // ⚠️ 不要把它改回脚本设置：next/script 在静态导出里只是往 __next_s 队列塞字符串，
  //    真正的执行在首帧之后，会复现「新 UI 闪一下变旧」。
  // ⚠️ 写死在这儿是安全的：这一列值不随用户状态变化，水合前后完全一致
  //    （suppressHydrationWarning 仍保留，兜住主题属性那一路的差异）。
  return (
    <html lang="zh-CN" data-ui="v12" data-theme-ready="" suppressHydrationWarning>
      {/* ui-v12 挂在 <body> 而非逐页根元素：终态等价，但作用域覆盖到
          所有路由（含 error.tsx / global-error.tsx）以及任何 portal 到
          document.body 的弹窗 —— 挂在页面根上时，portal 会逃出作用域。
          整块由 <html> 上写死的 data-ui="v12" 门控；回退见 v12.css 头部注释。 */}
      <body className="ui-v12">
        {/* ⚠️⚠️ 必须是**裸内联 <script>**，且放在 <body> 最前面、所有内容之前。
            绝不能用 next/script —— 在静态导出里它只是往队列里塞一个**字符串**：
              <script>(self.__next_s=self.__next_s||[]).push([0,{"children":"…"}])</script>
            函数体要等 Next 运行时把它取出来才执行，那是**首帧之后**，
            于是会先按错的主题画一帧，用户就看到闪动。

            它只管 data-theme（外加 colorScheme 与 <html> 底色）。
            data-ui **不在这里** —— 它已经是 <html> 上的字面量，所以 V12 生不生效
            与脚本何时执行无关。这正是「新 UI 闪一下变回旧 UI」的根因修法：
            原来 data-ui 由本脚本设置，脚本晚于首帧执行，首帧就落回旧 UI。

            ⚠️ 必须与 use-theme.ts 的 getStoredTheme() / applyTheme() 逐字对应，
            否则会闪错主题。
            ⚠️ 'blast-wine' 是**已删除**的酒红主题的遗留存值，这里仍要认它并归并到
            blast（暗色）。删掉这一支的后果：老用户 localStorage 里还是 'blast-wine'
            → 两个分支都不匹配 → 落到媒体查询 → 系统偏好浅色的人每次加载都会先闪白。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('ui-theme');var t=s==='light'?'light':(s==='blast'||s==='blast-wine')?'blast':(window.matchMedia&&window.matchMedia('(prefers-color-scheme:light)').matches?'light':'blast');document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t==='light'?'light':'dark';document.documentElement.style.background=t==='light'?'#f3f0ea':'#0c1517';}catch(e){document.documentElement.dataset.theme='blast';document.documentElement.style.background='#0c1517';}})()`,
          }}
        />
        {/* V12 氛围层 —— 挂在这里而不是逐页：设计稿把它放在 <body> 顶层
            （index-v12.html:874-876），固定定位；挂在页面里会让 error.tsx /
            global-error.tsx 漏掉，也会在路由切换时重挂一次、闪一下。
            三层都是装饰，aria-hidden。样式见 v12-components.css 第 17 节。
            ⚠️ 它们 z-index:0 且 fixed —— 内容根必须同时提权，否则会被盖住。 */}
        <div className="aurora" aria-hidden="true" />
        <div className="grid-lines" aria-hidden="true" />
        <div className="motes" aria-hidden="true">
          <i className="m m1" /><i className="m m2" /><i className="m m3" /><i className="m m4" />
          <i className="m m5" /><i className="m m6" /><i className="m m7" /><i className="m m8" />
        </div>
        <Script id="redirect-pages-dev" strategy="beforeInteractive">
          {`if(location.hostname==='arknights-guess.pages.dev')location.replace('https://www.arknights-guess.online'+location.pathname+location.search)`}
        </Script>
        <VersionCheck />
        <HistoryInit />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
