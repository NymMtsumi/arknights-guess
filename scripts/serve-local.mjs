// 本地「部署」预览：把 next build 的静态产物 out/ 按生产的路由形态服务出来。
//
// 为什么不直接用 `npm run dev`：dev 是 Turbopack 现编译，与构建产物的 CSS 打包/顺序
// 不完全等价；而本次要验收的正是 V12 的分层样式，必须看构建产物。
// 为什么不用 `npm start`（npx serve out）：npx 会尝试联网拉包，且端口行为不受控。
//
// 端口默认 3000 —— **不能改**：后端 server/utils.js:6 的 CORS 白名单默认只放行
// http://localhost:3000，换端口浏览器会直接拦掉所有 API/WS 请求。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
};

async function resolveFile(urlPath) {
  const rel = decodeURIComponent((urlPath || '/').split('?')[0]);
  const outRoot = normalize(OUT_DIR);
  const candidate = normalize(join(outRoot, rel));
  // 路径穿越防护
  if (!candidate.startsWith(outRoot + '\\') && !candidate.startsWith(outRoot + '/') && candidate !== outRoot) return null;

  if (existsSync(candidate) && (await stat(candidate)).isFile()) return candidate;
  if (existsSync(candidate) && (await stat(candidate)).isDirectory()) {
    const idx = join(candidate, 'index.html');
    if (existsSync(idx)) return idx;
  }
  const htmlForm = candidate + '.html';
  if (existsSync(htmlForm)) return htmlForm;
  return null;
}

if (!existsSync(join(OUT_DIR, 'index.html'))) {
  console.error(`❌ 找不到 ${join(OUT_DIR, 'index.html')} —— 先跑 npm run build`);
  process.exit(1);
}

createServer(async (req, res) => {
  try {
    const file = await resolveFile(req.url || '/');
    if (!file) {
      const notFound = join(OUT_DIR, '404.html');
      if (existsSync(notFound)) {
        res.writeHead(404, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        return res.end(await readFile(notFound));
      }
      res.writeHead(404, { 'Content-Type': MIME['.txt'] });
      return res.end('not found');
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      // 本地预览一律不缓存，避免改完看不到变化
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': MIME['.txt'] });
    res.end(String(e));
  }
}).listen(PORT, () => {
  console.log(`▲ 本地预览：http://localhost:${PORT}   (产物目录 ${OUT_DIR})`);
});
