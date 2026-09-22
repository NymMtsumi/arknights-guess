// 工具函数模块
import { createHash, randomBytes } from 'node:crypto';

// CORS 允许的来源（与 socket/index.js 保持一致）
// 使用函数延迟求值：模块顶层执行时 process.env 尚未加载 .env 文件
export function getAllowedOrigins() {
  return process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : ['https://www.arknights-guess.online', 'https://arknights-guess.pages.dev', 'http://localhost:3000'];
}
export function getCorsOrigin(requestOrigin) {
  const origins = getAllowedOrigins();
  if (requestOrigin && origins.includes(requestOrigin)) return requestOrigin;
  return origins[0] || 'https://www.arknights-guess.online';
}

// 输入清理：trim 所有字符串，强制最大长度
export function sanitizeString(val, maxLen) {
  if (typeof val !== 'string') return '';
  return val.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, maxLen);
}

// 解析 Cookie
export function parseCookies(str) {
  if (!str) return {};
  const result = {};
  for (const part of str.split(';')) {
    const [k, ...r] = part.split('=');
    if (k) { try { result[k.trim()] = decodeURIComponent(r.join('=').trim()); } catch {} }
  }
  return result;
}

// 获取客户端真实 IP（nginx 已清理伪造头，仅信任本地代理转发）
export function getClientIP(req) {
  const isLocalProxy = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
  if (!isLocalProxy) return req.socket.remoteAddress || 'unknown';

  // 优先 X-Real-IP（nginx 设为 $remote_addr，不可伪造）
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    const ripStr = String(realIp).trim();
    if (/^[\d.]+$/.test(ripStr) || /^[0-9a-fA-F:]+$/.test(ripStr)) return ripStr;
  }
  // 兜底：CF-Connecting-IP（nginx 已清空，仅旧版本兼容）
  const cf = req.headers['cf-connecting-ip'];
  if (cf) {
    const cfStr = String(cf).trim();
    if (/^[\d.]+$/.test(cfStr) || /^[0-9a-fA-F:]+$/.test(cfStr)) return cfStr;
  }
  return '127.0.0.1';
}

// 状态变更方法之外的方法不需要 CSRF 门
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF 前置门 —— 只对 POST/PUT/PATCH/DELETE 生效，返回 null 表示放行，否则返回拒绝原因。
 *
 * 背景（这道门存在的原因）：
 *   token cookie 是 `SameSite=None`（必须如此：前端在 www.*、API 在 ws.*，跨站请求
 *   不带 cookie 就登录不了），所以**浏览器会自动把凭证带上任何跨站请求**。
 *   而 CORS 只能挡住「读取响应」，挡不住「请求被执行」——
 *   一个跨站页面只要发一个**简单请求**（GET/HEAD/POST + Content-Type 为
 *   application/x-www-form-urlencoded、multipart/form-data 或 text/plain 之一），
 *   浏览器就不会发预检，请求直接打到 handler 上，cookie 照样携带。
 *   服务端 parseBody 又不看 Content-Type，只要 body 是合法 JSON 就照单全收 →
 *   攻击者用 `Content-Type: text/plain` + JSON body 就能替已登录用户发起写操作。
 *
 * 两条独立判据，任一不过即拒：
 *   1. 带了 Origin、但不在 allowlist 里 → 跨站发起的写请求。
 *      非浏览器客户端（curl / 冒烟脚本 / GitHub Actions 的部署 webhook）不发 Origin，
 *      这里不拦 —— 它们本来就不共享浏览器 cookie，不是 CSRF 的载体。
 *   2. 带了 body、但 Content-Type 不是 application/json → 上面那三种「简单请求」
 *      类型之一，说明它刻意绕过了预检。要求 JSON 就等于强制它走预检，
 *      而预检是受 allowlist 约束的。
 *      ⚠️ 无 body 的请求不拦：跨站空 body POST 什么也改不了
 *         （parseBody 得到 {}，各 handler 都要求具体字段）。
 *         例如 `POST /api/logout` 就是无 body、无 Content-Type 的调用方。
 */
export function csrfReject(req) {
  if (CSRF_SAFE_METHODS.has(req.method)) return null;

  const origin = req.headers.origin;
  if (origin && !getAllowedOrigins().includes(origin)) {
    return `来源不被允许：${origin}`;
  }

  const len = req.headers['content-length'];
  const hasBody = (len !== undefined && len !== '0') || !!req.headers['transfer-encoding'];
  if (hasBody) {
    // 只取分号前的 media type，"application/json; charset=utf-8" 也算通过
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') {
      return `Content-Type 必须为 application/json（收到 ${ct || '空'}）`;
    }
  }
  return null;
}

// 解析 JSON 请求体（Body 大小限制 1MB，读取超时 30s）
export function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    const MAX_SIZE = 1_048_576;
    let size = 0;
    let settled = false;
    let timeout;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    // 读取超时保护：慢速/超大 body 长时间占用连接时强制断开
    timeout = setTimeout(() => { req.destroy(); }, 30_000);
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_SIZE) {
        // 超限：断开连接（无法安全复用带未读数据的 keep-alive 连接）
        done({});
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { done(JSON.parse(body)); } catch { done({}); }
    });
    // 防止客户端断开/异常导致请求挂起
    req.on('error', () => done({}));
    req.on('close', () => done({}));
  });
}

// 输出 JSON 响应（自动匹配请求 origin 实现 credentialed CORS）
export function jsonResponse(res, data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': getCorsOrigin(res._requestOrigin || null),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PATCH, DELETE',
    // 与 server/index.js 的 OPTIONS 预检保持逐字一致（含 X-Player-Key）：
    // 两处不一致会造成「预检放行、实际响应缺头」，最难排查的一类 CORS 故障。
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Player-Key',
    'Access-Control-Allow-Credentials': 'true',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

/* 从 Accept-Language 解析出界面语言，只区分中/英两档，与前端 Locale 类型对齐。
   兜底是 'zh-CN'，与客户端一致（src/lib/i18n.tsx 的 getStoredLocale 解析不出时同样是 zh-CN）。
   始终返回确定的字符串、绝不返回 null：null 会被当成「有值」传下去，
   反而绕过 deriveGuestName 的 `= 'zh-CN'` 默认参数（默认参数只对 undefined 生效）。 */
export function parseLocale(acceptLanguage) {
  if (typeof acceptLanguage !== 'string' || !acceptLanguage) return 'zh-CN';
  const lower = acceptLanguage.toLowerCase();
  if (lower.includes('zh')) return 'zh-CN';
  if (/^[a-z]{2}/.test(lower)) return 'en';
  return 'zh-CN';
}

/* 游客显示名。
   ⚠️ 这个名字是**共享身份**，不是纯展示文本：src/hooks/usePlayerName.ts 会把它
   当作玩家的 playerName，随组队请求广播给同房其他玩家，而他们的界面语言未知。
   所以不可能「返回结构体、由各自的客户端本地化」—— 必须在这里定成唯一一个字符串。
   唯一有资格决定它是哪种语言的人，就是游客自己（Accept-Language）。

   ⚠️ 已知取舍：名字由 (key, locale) 纯函数导出，没有落库。
   同一游客换浏览器/换系统语言后，重新派生出的名字前缀会跟着变。
   这对一次性占位名可以接受（游客随时可以自己改昵称）；
   若将来要求跨设备稳定，就得在首次生成时把结果连同 guest_id 一起持久化。 */
export function deriveGuestName(key, locale = 'zh-CN') {
  const code = createHash('sha256').update(key + 'display').digest('hex').slice(0, 5).toUpperCase();
  // 不加空格：'Guest #A1B2C' 恰好 12 字符，正好顶到 usePlayerName 的 MAX_LENGTH=12，
  // 没有任何余量，将来格式一变就会被静默截断、还少一位校验码。中文侧本来也无空格。
  return locale === 'en' ? `Guest#${code}` : `访客#${code}`;
}

// 唯一显示编号（基于 userId + 盐值，确保跨重启稳定）
// 盐值可经环境变量 DISPLAY_ID_SALT 覆盖（默认值不变，向后兼容既有编号）
function getDisplayIdSalt() {
  return process.env.DISPLAY_ID_SALT || 'arknights-display-v2-fixed-salt-2026';
}
function getDisplayDomainPrefix() {
  return createHash('sha256').update('arknights-display-v2\0', 'ascii').update(getDisplayIdSalt()).digest();
}
export function generateDisplayCode(userId) {
  const digest = createHash('sha256')
    .update(getDisplayDomainPrefix())
    .update(String(userId))
    .digest();
  const value = digest.readUInt32BE(0) % (36 ** 5);
  return value.toString(36).padStart(5, '0').toUpperCase();
}

// 生成随机 key
export function generateKey() {
  return 'p_' + randomBytes(9).toString('base64url');
}

// 统一时间戳规范化：数字→ISO字符串（供 save-game 和 sync 共用）
export function normalizeTimestamp(ts) {
  if (typeof ts === 'number') {
    if (ts <= 0 || !Number.isFinite(ts)) return new Date().toISOString();
    if (ts < 1e11) {
      // 秒级时间戳
      try { return new Date(ts * 1000).toISOString(); } catch { return new Date().toISOString(); }
    }
    if (ts <= 1e13) {
      // 毫秒级时间戳
      try { return new Date(ts).toISOString(); } catch { return new Date().toISOString(); }
    }
    return new Date().toISOString();
  }
  if (typeof ts !== 'string' || !ts) return new Date().toISOString();
  const parsed = new Date(ts);
  if (isNaN(parsed.getTime())) return new Date().toISOString();
  // 拒绝明显异常的未来时间戳（允许 1 天时钟偏移，防污染排序）
  if (parsed.getTime() > Date.now() + 24 * 3600_000) return new Date().toISOString();
  return parsed.toISOString();
}

// 服务端统一发件人
// QQ SMTP 要求发件人地址必须与 SMTP_USER 相同，因此：
// 1. 生产环境必须在 .env 中设置 SMTP_FROM='"显示名" <你的QQ号@qq.com>'
// 2. 如果未设置 SMTP_FROM 但有 SMTP_USER，则自动使用 SMTP_USER 作为发件人
// 3. 均未设置时回退到 noreply 占位（QQ SMTP 会拒绝发送）
// 使用函数延迟求值：模块顶层执行时 process.env 尚未加载 .env 文件，调用时 .env 已就绪
export function getSmtpSender() {
  return process.env.SMTP_FROM
    || (process.env.SMTP_USER ? `"明日方舟猜干员" <${process.env.SMTP_USER}>` : null)
    || '"明日方舟猜干员" <noreply@arknights-guess.online>';
}

// ===== 昵称违禁词过滤 =====
const NICKNAME_FORBIDDEN = new Set([
  '傻逼', '傻比', '傻b', 'sb', '傻杯', '煞笔', '沙比', '沙雕', '傻屌', '傻叉',
  '弱智', '脑残', '智障', '白痴', '二百五', '废物', '垃圾',
  '操你', '草你', '艹你', '草泥马', '操你妈', 'cnm', 'cao', '我操', '卧槽', '我艹',
  '妈的', '他妈的', '你妈的', '你妈', '他妈', '妈逼', '妈比', '妈了个',
  '贱人', '贱货', '骚货', '骚比', '婊子', '婊', '妓女', '鸡婆', '荡妇',
  '淫', '奸', '强奸', '轮奸', '鸡巴', '鸡吧', '几把', '几巴', 'jb', 'j8',
  '屌', '屄', '逼', ' bitch', 'bitch', 'fuck', 'fck', 'fuk', 'f*ck', 'shit',
  '狗日的', '日你', '日了狗', '狗东西', '狗娘养',
  '龟儿子', '王八蛋', '王八', '杂种', '野种', '孽种',
  '去死', '去死吧', '死妈', '死全家', '全家死', '不得好死',
  '废物', '辣鸡', '垃圾', '恶心',
  '习近平', '习大大', '习包子', '习皇帝', '小熊维尼', '维尼',
  '毛泽东', '邓小平', '江泽民', '胡锦涛', '温家宝', '李克强',
  '共产党', '中共', '国民党', '民进党',
  '法轮功', '法轮大法', 'falun', '六四', '天安门', '八九',
  '台独', '藏独', '疆独', '港独', '西藏独立', '新疆独立',
  '民主', '自由', '人权', '迫害', '专制', '独裁', '暴政',
  '支那', '赤佬', '黑鬼', 'nigger', 'nigga', 'negro',
  'faggot', 'fag', 'tranny', 'retard', 'retarded',
  '加微信', '加我微信', '加qq', '加我q', '加我QQ',
  '微信号', '微信：', 'qq：', 'QQ：', 'vx：', 'VX：',
  '出售', '代练', '陪玩', '包赢', '刷分', '外挂', '作弊',
  '看片', '视频', '直播', '加群',
  '管理员', '官方', '客服', 'GM', 'gm', 'admin', '系统',
  '版主', ' moderator', 'moderator',
  '　',
]);

export function checkNicknameProfanity(nickname) {
  if (typeof nickname !== 'string' || nickname.trim().length === 0) return '空白昵称';
  const lower = nickname.toLowerCase();
  for (const rawWord of NICKNAME_FORBIDDEN) {
    const word = rawWord.trim(); // 去掉前导/尾随空格（原 bug：' bitch' 等无法命中词首）
    if (!word) continue;
    const wl = word.toLowerCase();
    if (word.length <= 2 && /^[a-z0-9]+$/.test(word)) {
      // 短 ASCII 词用词边界匹配，避免 'sb'/'jb'/'fag' 误伤包含该子串的合法昵称
      const re = new RegExp(`\\b${wl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(lower)) return word;
    } else if (lower.includes(wl)) {
      return word;
    }
  }
  if (/^[\d\s._\-+*=#@!~`]+$/.test(nickname)) return '纯数字符号';
  if (/(.)\1{6,}/.test(nickname)) return '重复字符';
  return null;
}
