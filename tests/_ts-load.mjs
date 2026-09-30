// 在 Node 里直接加载项目内的 .ts 模块（只用于**纯逻辑**的确定性测试）。
//
// 为什么需要它：项目没有 TS runner（无 tsx / ts-node / vitest），但 tsconfig 里
// 用了 `@/` 路径别名、且源码内部是**无扩展名**的相对导入（`from './utils'`）。
// Node 24 自带的类型擦除能跑 .ts，但它要求显式扩展名、也不认 `@/` 别名 ——
// 于是 `node src/lib/xxx.ts` 必然 ERR_MODULE_NOT_FOUND。
//
// 做法：用 devDependency `typescript` 的 compiler API 逐文件 transpile（只做语法降级，
// 不解析导入），自己走一遍导入图并把说明符重写成**相对 .js 路径**，落到临时目录后再 import。
// 因此它**不做类型检查**（那是 `npx tsc --noEmit` 的事），只保证能跑。
//
// ⚠️ 限制（故意为之，遇到就报错而不是静默出错）：
//   · 只处理相对导入 + `@/` 别名；其余裸说明符（clsx/zustand/next…）原样保留，
//     交给 Node 从 node_modules 解析。
//   · `.json` 会被内联成一个 `export default <字面量>` 的 .js —— 这样既能被 import 到，
//     又绕开 Node 对 JSON 模块要 `with { type: 'json' }` 的要求（重写说明符的字符串
//     改不了 import 语句本身，加不上那个属性）。
//   · `.tsx` / 依赖 React 的模块不在适用范围内（不转 JSX 之外的运行时）。

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const SRC_DIR = join(process.cwd(), 'src');

/** 把相对/别名说明符解析成磁盘上的文件；解析不了返回 null */
function resolveSpecifier(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = join(SRC_DIR, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec);
  else return null; // 裸说明符：交给 Node

  for (const cand of [`${base}.ts`, `${base}.json`, join(base, 'index.ts'), base]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/**
 * 加载入口模块。
 * @param {string} entryRel 相对仓库根的文件路径，如 'src/lib/turtle-engine.ts'
 * @returns {Promise<any>} 模块的命名空间对象
 */
export async function loadTsModule(entryRel) {
  const entry = resolve(process.cwd(), entryRel);
  if (!existsSync(entry)) throw new Error(`入口不存在：${entry}`);

  const outDir = join(process.cwd(), 'node_modules', '.cache', `ts-load-${process.pid}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const emitted = new Map(); // 磁盘 .ts 路径 → 输出 .js 路径
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop();
    if (emitted.has(file)) continue;

    const src = await readFile(file, 'utf8');
    // preProcessFile 是 TS 的快速导入提取器（不做类型检查，够用）
    const info = ts.preProcessFile(src, true, true);

    for (const imp of info.importedFiles) {
      const target = resolveSpecifier(imp.fileName, file);
      if (target) queue.push(target);
    }
    emitted.set(file, file);
  }

  // preProcessFile 只拿到 import，动态 import() 也扫一遍（本项目源码里没有，保险）
  for (const file of [...emitted.keys()]) {
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      const target = resolveSpecifier(m[1], file);
      if (target) {
        emitted.set(target, target);
        // 新入图的文件其依赖也要跟，简单起见直接再跑一轮（图很小）
        const info = ts.preProcessFile(await readFile(target, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
          const t2 = resolveSpecifier(imp.fileName, target);
          if (t2) emitted.set(t2, t2);
        }
      }
    }
  }

  // 转译 + 重写说明符
  const outPathOf = new Map();
  for (const file of emitted.keys()) {
    const rel = relative(process.cwd(), file);
    const out = join(outDir, rel.replace(/\.(ts|json)$/, '.js'));
    outPathOf.set(file, out);
  }

  for (const [file, out] of outPathOf) {
    // JSON：内联成 ESM 默认导出，绕开 `with { type: 'json' }` 的要求
    if (file.endsWith('.json')) {
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, `export default ${await readFile(file, 'utf8')};\n`, 'utf8');
      continue;
    }

    let code = ts.transpileModule(await readFile(file, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        removeComments: false,
        isolatedModules: true,
      },
      fileName: file,
    }).outputText;

    // 重写所有相对/别名说明符 → 输出目录里的相对 .js 路径
    code = code.replace(
      /(\bfrom\s*|\bimport\s*\(\s*)(['"])([^'"]+)\2/g,
      (whole, prefix, quote, spec) => {
        const target = resolveSpecifier(spec, file);
        if (!target || !outPathOf.has(target)) return whole; // 裸说明符原样
        let rel = relative(dirname(out), outPathOf.get(target)).split(sep).join('/');
        if (!rel.startsWith('.')) rel = `./${rel}`;
        return `${prefix}${quote}${rel}${quote}`;
      },
    );

    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, code, 'utf8');
  }

  const entryOut = outPathOf.get(entry);
  const mod = await import(pathToFileURL(entryOut).href + `?t=${Date.now()}`);
  return { mod, outDir, cleanup: () => rm(outDir, { recursive: true, force: true }) };
}
