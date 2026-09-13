'use client';

import { useState } from 'react';

// 模式页顶部的装饰插画。样式：v12-components.css §21.2（稿子 modes:837-842）。
//
// 纯装饰 —— 加载失败时整块收起（.mode-art.is-fb），不留一块空白。
// 这一点与 .menu-icon / .dialog-img 不同：那两个槽位是内容位，失败要退回 emoji；
// 这里是氛围位，没有它版式照样成立。
export function ModeArt({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);

  return (
    <div className={failed ? 'mode-art is-fb' : 'mode-art'}>
      <img src={src} alt="" aria-hidden="true" onError={() => setFailed(true)} />
    </div>
  );
}
