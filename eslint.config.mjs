import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
// flat config 要求「规则 → 插件」定义在**同一个 config 对象**里；下面两个 override 块
// 只改规则严重度，所以必须自己把插件引用带进来（与 next 配置里的是同一个包实例）。
import reactHooks from "eslint-plugin-react-hooks";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 🔴 2026-10-17 补：Cloudflare/OpenNext 的**构建产物**目录。
    //    它由 `next build` 之后的一步（@opennextjs/cloudflare）生成，里面是压成一行的
    //    chunk 与生成的 handler；此前漏了这条 ignore，于是 lint 会在压缩代码里报
    //    no-this-alias / ban-ts-comment（13 个 error）—— 那些行不是我们写的，也不该被改。
    ".open-next/**",
  ]),
  {
    // Node 侧的 CommonJS 文件（`server/`、`scripts/legacy/`、`tests/` 里给 `node --require`
    // 用的预加载）：`require()` 是 CJS 的语言要求，不是「导入风格违规」。
    // 这些文件不经过 Next/Turbopack 打包、也没有 ESM 入口；机械改成 import 会直接破坏
    // `--require` 的用法与老脚本的可执行性。—— 所以只在**这些文件**里关掉该规则，
    // 不是全局关：src/** 里的 TS/TSX 仍然禁止 require。
    name: "project/cjs-require",
    files: ["**/*.cjs", "scripts/legacy/**/*.js"],
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // 🔴 2026-10-17 清 lint 债：以下 4 条 react-hooks（v7 compiler-powered 规则）降为 `warn`。
    //    它们剩下的 46 个报错全部是**既有债务**，且逐条都要求「重写组件状态机 / 渲染期数据流」
    //    才能消除 —— 那属于**会改变行为**的改动，风险大于收益。按团队结论另开任务，不在这里硬改。
    //    注意：只降这 4 条规则，没有关闭 react-hooks 插件本身；其它 hooks 规则仍是 error。
    name: "project/react-hooks-debt",
    plugins: { "react-hooks": reactHooks },
    rules: {
      // 27 处：`useEffect(() => { setX(...) }, [])`。这是本项目的 **SSR 安全水合模式** ——
      // localStorage / matchMedia / location 只能在 client 读，渲染期读会导致预渲染输出与
      // 水合结果不一致（静态导出 + React 会直接换 DOM）。要消除得改成
      // useState 惰性初始化或 useSyncExternalStore，会动到首帧与水合行为。
      "react-hooks/set-state-in-effect": "warn",
      // 12 处：`optionsRef.current = options` / 渲染期读 `xxxRef.current` 的「latest ref」约定。
      // 改成 state 会引入额外渲染（useSocket 里还会触发重连），属于行为敏感改动。
      "react-hooks/refs": "warn",
      // 5 处：多人页在渲染期调 Math.random()/Date.now() 取情绪图种子。要消除必须把随机源
      // 移进 state/useMemo，会改变「每次渲染重新抽」的现有表现（图会闪），风险大于收益。
      "react-hooks/purity": "warn",
      // 2 处：渲染期读取尚未声明（靠提升）的变量。修它要重排 hook 声明顺序，
      // 牵动多人页 / admin 页的初始化顺序，属行为敏感改动。
      "react-hooks/immutability": "warn",
    },
  },
]);

export default eslintConfig;
