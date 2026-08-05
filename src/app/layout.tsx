import type { Metadata } from "next";
import Script from "next/script";
import { Providers } from "./providers";
import { VersionCheck } from "@/components/VersionCheck";
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
  return (
    <html lang="zh-CN" data-theme-ready="" suppressHydrationWarning>
      <body>
        <Script id="theme-init" strategy="beforeInteractive">
          {`(function(){try{var s=localStorage.getItem('ui-theme');var t=s==='light'?'light':s==='blast'?'blast':(window.matchMedia&&window.matchMedia('(prefers-color-scheme:light)').matches?'light':'blast');document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t==='blast'?'dark':'light';document.documentElement.style.background=t==='blast'?'#160a13':'#f3f0ea';}catch(e){document.documentElement.dataset.theme='blast';document.documentElement.style.background='#160a13';}})()`}
        </Script>
        <Script id="redirect-pages-dev" strategy="beforeInteractive">
          {`if(location.hostname==='arknights-guess.pages.dev')location.replace('https://www.arknights-guess.online'+location.pathname+location.search)`}
        </Script>
        <VersionCheck />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
