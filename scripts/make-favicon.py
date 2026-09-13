#!/usr/bin/env python3
"""从经典模式的角色图生成 src/app/favicon.ico。

为什么需要这个脚本：favicon.ico 是二进制、进了 git，但「它是怎么来的」在文件里看不出来。
直接改图会让人不知道裁了哪里、下次想调也无从下手。参数写在这儿，改完重跑即可。

用法：python scripts/make-favicon.py
依赖：Pillow

── 为什么是「中心放大」而不是整图 ──────────────────────────
原图 347×331 是一张带四角装饰与「得/意」手写字的完整插画。整图直接缩到
浏览器标签页的 16×16 会糊成一块青绿色（实测过，认不出是什么）。
中心裁到 68% 后，16px 能看出是个人物，32/48px 五官清晰。

⚠️ 裁剪红线：只裁掉背景装饰，**绝不裁到主体**（用户明确要求过）。
   下面的 CROP_W / CROP_H / CROP_ANCHOR_Y 三个值就是这条线，改小它们
   会开始切到头发和手，别动。
"""
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "icons" / "menu-classic.png"
DST = ROOT / "src" / "app" / "favicon.ico"

# 保留中心区域的比例。0.68 是实测出来的：再小就开始切到头发，再大则 16px 又糊回去。
CROP_W = 0.68
CROP_H = 0.68
# 裁切框的垂直锚点。0.5 = 正中心；取 0.42 略微上移，让头部落在画布中间
# （角色是坐姿，正中心裁会让头偏上、下方留一堆身子）。
CROP_ANCHOR_Y = 0.42

# ICO 内嵌的尺寸档。16/32 是标签页，48 是部分浏览器的书签栏，
# 256 供高分屏与任务栏固定（Windows 会挑最大那档缩放，给小图会发虚）。
SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    w, h = src.size

    # ⚠️ 先放大源图，再裁。这一步不是为了让图更清晰，是为了**喂饱 ICO 的 256 档**：
    #    Pillow 会**静默丢弃**比画布还大的档位（不报错、不警告）。原图裁完只有
    #    235px，于是 256 那一档凭空消失 —— 但 Next 写死的 link 标签仍是
    #    sizes="256x256"，于是「声明的尺寸是假的」，而且高分屏/任务栏固定
    #    只能拿 128 去放大，发虚。实测过：加不加这一步，16/32/48 档的图像
    #    平均绝对差只有 2.6~6.5（肉眼噪声级），所以放大不损失什么。
    crop_side = int(min(w, h) * CROP_W)
    max_size = max(s[0] for s in SIZES)
    if crop_side < max_size:
        k = max_size / crop_side
        w, h = round(w * k), round(h * k)
        src = src.resize((w, h), Image.LANCZOS)
        print(f"源图放大 {k:.3f}x → {w}x{h}（为保住 {max_size} 档）")

    cw, ch = int(w * CROP_W), int(h * CROP_H)
    left = (w - cw) // 2
    top = int((h - ch) * CROP_ANCHOR_Y)
    cropped = src.crop((left, top, left + cw, top + ch))

    # 补成方形（透明填充），否则浏览器会把非方形图标拉变形
    side = max(cropped.size)
    square = ImageOps.pad(cropped, (side, side), color=(0, 0, 0, 0), centering=(0.5, 0.5))

    DST.parent.mkdir(parents=True, exist_ok=True)
    square.save(DST, format="ICO", sizes=SIZES)

    # 回读断言：Pillow 的静默丢档必须在这儿炸掉，不能等到线上才发现
    got = sorted(s[0] for s in Image.open(DST).info.get("sizes", []))
    want = sorted(s[0] for s in SIZES)
    assert got == want, f"ICO 档位不符：期望 {want}，实得 {got}"

    print(f"裁切框  ({left}, {top}) - ({left + cw}, {top + ch})  即中心 {CROP_W:.0%}，锚点 {CROP_ANCHOR_Y}")
    print(f"补方形  {side}x{side}")
    print(f"已写出  {DST.relative_to(ROOT)}  ({DST.stat().st_size / 1024:.0f} KB, 档位 {got})")


if __name__ == "__main__":
    main()
