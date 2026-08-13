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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

// 游客显示名
export function deriveGuestName(key) {
  const code = createHash('sha256').update(key + 'display').digest('hex').slice(0, 5).toUpperCase();
  return `访客#${code}`;
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
