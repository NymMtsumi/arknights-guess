// 工具函数模块
import { createHash, randomBytes } from 'node:crypto';

// 输入清理：trim 所有字符串，强制最大长度
export function sanitizeString(val, maxLen) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
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

  // nginx 设置了 CF-Connecting-IP（来自 Cloudflare 的真实 client IP）
  const cf = req.headers['cf-connecting-ip'];
  if (cf) {
    const cfStr = String(cf).trim();
    if (/^[\d.]+$/.test(cfStr) || /^[0-9a-fA-F:]+$/.test(cfStr)) return cfStr;
  }
  // fallback: nginx 设置了 X-Real-IP = $remote_addr（直连时使用）
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    const ripStr = String(realIp).trim();
    if (/^[\d.]+$/.test(ripStr) || /^[0-9a-fA-F:]+$/.test(ripStr)) return ripStr;
  }
  return '127.0.0.1';
}

// 解析 JSON 请求体（Body 大小限制 1MB）
export function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    const MAX_SIZE = 1_048_576;
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_SIZE) {
        req.destroy();
        resolve({});
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// 输出 JSON 响应
export function jsonResponse(res, data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'false',
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

// 唯一显示编号（基于 userId + salt）
const DISPLAY_ID_SALT = randomBytes(32).toString('hex');
export function generateDisplayCode(userId) {
  const digest = createHash('sha256')
    .update(`arknights-display-v1\0`, 'ascii')
    .update(String(userId))
    .update(DISPLAY_ID_SALT)
    .digest();
  const value = digest.readUInt32BE(0) % (36 ** 5);
  return value.toString(36).padStart(5, '0').toUpperCase();
}

// 生成随机 key
export function generateKey() {
  return 'p_' + randomBytes(9).toString('base64url');
}

// ===== 昵称违禁词过滤 =====
const NICKNAME_FORBIDDEN = new Set([
  '傻逼', '傻比', '傻b', 'sb', '傻杯', '煞笔', '沙比', '沙雕', '傻屌', '傻叉',
  '弱智', '脑残', '智障', '白痴', '二百五', '废物', '垃圾',
  '操你', '草你', '艹你', '草泥马', '操你妈', 'cnm', 'cao', '我操', '卧槽', '我艹',
  '妈的', '妈的', '他妈的', '你妈的', '你妈', '他妈', '妈逼', '妈比', '妈了个',
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
  const lower = nickname.toLowerCase();
  for (const word of NICKNAME_FORBIDDEN) {
    if (lower.includes(word.toLowerCase())) return word;
  }
  if (/^[\d\s._\-+*=#@!~`]+$/.test(nickname)) return '纯数字符号';
  if (/(.)\1{6,}/.test(nickname)) return '重复字符';
  if (nickname.trim().length === 0) return '空白昵称';
  return null;
}
