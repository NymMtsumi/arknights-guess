// 干员数据加载
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let ALL_CHARS = [], EASY_CHARS = [], MED_CHARS = [];

export function loadCharacters() {
  try {
    const data = JSON.parse(readFileSync(join(__dirname, 'characters.json'), 'utf-8'));
    ALL_CHARS = data.map(c => ({ id: c.id, name: c.name }));
    EASY_CHARS = data.filter(c => c.popularity === 'hot' || c.rarity >= 6).map(c => ({ id: c.id, name: c.name }));
    MED_CHARS = data.filter(c => c.popularity === 'hot' || c.popularity === 'normal').map(c => ({ id: c.id, name: c.name }));
    console.log(`已加载 ${ALL_CHARS.length} 干员`);
  } catch { console.log('⚠ 未加载干员数据'); }
}

export function randomTarget(diff = 'hard') {
  const pool = diff === 'easy' ? EASY_CHARS : diff === 'medium' ? MED_CHARS : ALL_CHARS;
  if (!pool.length) return { id: '', name: '?' };
  return pool[Math.floor(Math.random() * pool.length)];
}
