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

export function GameSearch({ onGuess, disabled, guessedIds, remainingGuesses }: GameSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Character[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isComposing, setIsComposing] = useState(false);
  const [shaking, setShaking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = setTimeout(() => {
      if (query.trim() && !isComposing) {
        const filtered = rankResults(query).filter(c => !guessedIds.has(c.id));
        setResults(filtered);
        setShowDropdown(filtered.length > 0);
        setSelectedIndex(-1);
      } else if (!isComposing) {
        setResults([]);
        setShowDropdown(false);
      }
    }, 150); // 150ms debounce to reduce filtering on fast typists
    return () => clearTimeout(handler);
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
    <div ref={containerRef} className="search-box">
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
        className={`search-input game-search-input${remainingGuesses !== undefined && remainingGuesses <= 3 ? ' low-guesses' : ''}${shaking ? ' shake' : ''}`}
        onAnimationEnd={() => setShaking(false)}
      />

      {showDropdown && (
        <div className="search-dropdown" style={{ maxHeight: '320px', overflowY: 'auto' }}>
          {results.map((char, i) => (
            <button
              key={char.id}
              onClick={() => selectChar(char)}
              disabled={disabled}
              className={i === selectedIndex ? 'opt active' : 'opt'}
              style={{ width: '100%', border: 'none', background: 'transparent', textAlign: 'left' }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <b>{char.name}</b>
              <span className="od">{char.class}</span>
              <span className="od">{formatRarity(char.rarity)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
