'use client';

import { useState, useRef, useEffect } from 'react';
import { pinyin } from 'pinyin-pro';
import type { Character } from '@/types/character';
import { findCharacterByName } from '@/lib/game-engine';
import { useGameStore } from '@/stores/game-store';
import charactersData from '@/data/characters.json';

const allCharacters: Character[] = charactersData as Character[];

// 预计算拼音索引
const pinyinIndex = new Map<Character, string[]>();
function getPinyin(c: Character): string[] {
  if (pinyinIndex.has(c)) return pinyinIndex.get(c)!;
  const py = pinyin(c.name, { toneType: 'none', type: 'array' });
  const initials = py.map(s => s[0]).join('');
  pinyinIndex.set(c, [py.join(''), initials]);
  return [py.join(''), initials];
}

function rankResults(query: string): Character[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const ranked: { char: Character; score: number }[] = [];

  for (const c of allCharacters) {
    const nameLow = c.name.toLowerCase();
    const nameEnLow = c.nameEn.toLowerCase();
    const [py, initials] = getPinyin(c);

    // 精确匹配
    if (nameLow === q || nameEnLow === q) { ranked.push({ char: c, score: 100 }); continue; }

    // 拼音精确匹配
    if (py === q) { ranked.push({ char: c, score: 95 }); continue; }

    // 开头匹配
    if (nameLow.startsWith(q) || nameEnLow.startsWith(q)) { ranked.push({ char: c, score: 80 }); continue; }

    // 拼音开头匹配
    if (py.startsWith(q)) { ranked.push({ char: c, score: 75 }); continue; }

    // 首字母匹配
    if (initials === q) { ranked.push({ char: c, score: 70 }); continue; }
    if (initials.startsWith(q)) { ranked.push({ char: c, score: 65 }); continue; }

    // 包含匹配
    if (nameLow.includes(q) || nameEnLow.includes(q)) { ranked.push({ char: c, score: 50 }); continue; }
    if (py.includes(q)) { ranked.push({ char: c, score: 45 }); continue; }
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, 12).map(r => r.char);
}

interface GameSearchProps {
  onGuess: (character: Character) => void;
  disabled: boolean;
  guessedIds: Set<string>;
  target?: Character | null; // 开发者 cheat（预留，暂未使用）
  remainingGuesses?: number; // 剩余猜测次数，≤3 时输入框红色预警
}

export function GameSearch({ onGuess, disabled, guessedIds, target: _target, remainingGuesses }: GameSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Character[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isComposing, setIsComposing] = useState(false);
  const [shaking, setShaking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (query.trim() && !isComposing) {
      const filtered = rankResults(query).filter(c => !guessedIds.has(c.id));
      setResults(filtered);
      setShowDropdown(filtered.length > 0);
      setSelectedIndex(-1);
    } else if (!isComposing) {
      setResults([]);
      setShowDropdown(false);
    }
  }, [query, guessedIds, isComposing]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selectChar = (character: Character) => {
    if (disabled) return;
    onGuess(character);
    setQuery('');
    setShowDropdown(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (disabled) return;
      if (showDropdown && results.length > 0) {
        const idx = selectedIndex >= 0 ? selectedIndex : 0;
        if (results[idx]) selectChar(results[idx]);
      } else if (query.trim()) {
        const char = findCharacterByName(allCharacters, query.trim());
        if (char) {
          if (guessedIds.has(char.id)) {
            // 已猜过 → 抖动反馈
            setShaking(true);
          } else {
            selectChar(char);
          }
        } else {
          // 名字无效 → 抖动反馈
          setShaking(true);
        }
      }
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
    }
  };

  const formatRarity = (r: number) => '★'.repeat(r) + '☆'.repeat(6 - r);

  return (
    <div ref={containerRef} style={{ position: 'relative', maxWidth: '500px', marginBottom: '20px' }}>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        onFocus={() => { if (query.trim() && results.length > 0) setShowDropdown(true); }}
        placeholder="输入干员名字或拼音..."
        disabled={disabled}
        className={`game-search-input${remainingGuesses !== undefined && remainingGuesses <= 3 ? ' low-guesses' : ''}${shaking ? ' shake' : ''}`}
        onAnimationEnd={() => setShaking(false)}
        style={{
          width: '100%', padding: '12px 16px', background: 'var(--input-bg)', color: 'var(--text)',
          border: remainingGuesses !== undefined && remainingGuesses <= 3 ? '1px solid var(--danger)' : '1px solid var(--border)',
          borderRadius: 'var(--radius)', fontSize: '1rem', outline: 'none',
          transition: 'border-color 0.2s',
        }}
      />
      <style>{`
        .game-search-input:focus { border-color: var(--primary) !important; box-shadow: 0 0 0 3px var(--primary-soft); }
        html[data-theme="blast"] .game-search-input:focus { box-shadow: 0 0 12px rgba(217, 255, 63, 0.18); }
      `}</style>

      {showDropdown && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: '4px',
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-lg)', maxHeight: '320px', overflowY: 'auto',
        }}>
          {results.map((char, i) => (
            <button
              key={char.id}
              onClick={() => selectChar(char)}
              disabled={disabled}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 16px', background: i === selectedIndex ? 'var(--primary-soft)' : 'transparent',
                color: 'var(--text)', border: 'none', cursor: disabled ? 'default' : 'pointer',
                textAlign: 'left', fontSize: '0.95rem', transition: 'background 0.15s',
                opacity: disabled ? 0.5 : 1,
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span style={{ fontWeight: 600 }}>{char.name}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: 'var(--text-light)', fontSize: '0.82rem' }}>{char.class}</span>
                <span style={{ color: 'var(--primary)', fontSize: '0.75rem', fontFamily: 'monospace' }}>
                  {formatRarity(char.rarity)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
