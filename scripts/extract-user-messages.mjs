// 从会话 JSONL 文件中提取用户真实消息（排除工具结果注入）
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

const TRANSCRIPT = 'C:\\Users\\27125\\.claude\\projects\\C--Users-27125\\f871e232-7f80-4bbc-9762-543aaf673e86.jsonl';
const OUTPUT = 'C:\\Users\\27125\\arknights-guess\\session-user-messages.md';

let count = 0;
let totalUser = 0;
const lines = [];

const rl = createInterface({
  input: createReadStream(TRANSCRIPT, { encoding: 'utf-8' }),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  if (!line.trim()) continue;
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }

  if (obj.type !== 'user') continue;
  totalUser++;

  // 跳过工具结果注入（toolUseResult 字段存在，且 content 是数组）
  if (obj.toolUseResult) continue;
  // 额外保险：origin.kind 必须是 "human"
  if (!obj.origin || obj.origin.kind !== 'human') continue;
  // content 必须是纯字符串
  if (typeof obj.message?.content !== 'string') continue;
  // 跳过空消息
  if (!obj.message.content.trim()) continue;

  count++;
  const ts = new Date(obj.timestamp).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  lines.push(`## ${ts}\n\n${obj.message.content.trim()}\n`);
}

// 写 Markdown 文件
const header = `# 会话用户消息记录\n\n> 会话 ID: f871e232-7f80-4bbc-9762-543aaf673e86\n> 时间跨度: 2026-07-28 ~ 2026-08-09\n> 提取消息数: ${count}\n> 总 user 行数 (含工具结果): ${totalUser}\n\n---\n\n`;
writeFileSync(OUTPUT, header + lines.join('\n---\n\n'), 'utf-8');

console.log(`✅ 完成！提取 ${count} 条用户消息（共 ${totalUser} 条 type=user）`);
console.log(`📄 输出: ${OUTPUT}`);
console.log(`📏 大小: ${(Buffer.byteLength(header + lines.join('\n---\n\n'), 'utf-8') / 1024).toFixed(1)} KB`);
