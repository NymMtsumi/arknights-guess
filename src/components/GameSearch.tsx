'use client';

import { useState, useRef, useEffect } from 'react';
import type { Character } from '@/types/character';
import { searchCharacters } from '@/lib/game-engine';
import charactersData from '@/data/characters.json';

const allCharacters: Character[] = charactersData as Character[];

interface GameSearchProps {
  onGuess: (character: Character) => void;
  disabled: boolean;
  guessedIds: Set<string>;
}

export function GameSearch({ onGuess, disabled, guessedIds }: GameSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Character[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (query.trim()) {
      const filtered = searchCharacters(allCharacters, query)
        .filter(c => !guessedIds.has(c.id));
      setResults(filtered);
      setShowDropdown(filtered.length > 0);
      setSelectedIndex(-1);
    } else {
      setResults([]);
      setShowDropdown(false);
    }
  }, [query, guessedIds]);

  // 点击外部关闭下拉
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleSelect = (character: Character) => {
    onGuess(character);
    setQuery('');
    setShowDropdown(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showDropdown) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0 && results[selectedIndex]) {
        handleSelect(results[selectedIndex]);
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
        onFocus={() => query.trim() && results.length > 0 && setShowDropdown(true)}
        placeholder="输入干员名字..."
        disabled={disabled}
        style={{
          width: '100%',
          padding: '12px 16px',
          background: 'var(--input-bg)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          fontSize: '1rem',
          outline: 'none',
          transition: 'border-color 0.2s',
        }}
        className="game-search-input"
      />

      {/* 下拉建议 */}
      {showDropdown && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 20,
            marginTop: '4px',
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-lg)',
            maxHeight: '320px',
            overflowY: 'auto',
          }}
        >
          {results.map((char, i) => (
            <button
              key={char.id}
              onClick={() => handleSelect(char)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 16px',
                background: i === selectedIndex ? 'var(--primary-soft)' : 'transparent',
                color: 'var(--text)',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: '0.95rem',
                transition: 'background 0.15s',
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span style={{ fontWeight: 600 }}>{char.name}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: 'var(--text-light)', fontSize: '0.82rem' }}>{char.class}</span>
                <span style={{
                  color: 'var(--primary)',
                  fontSize: '0.75rem',
                  fontFamily: 'monospace',
                }}>
                  {formatRarity(char.rarity)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <style>{`
        .game-search-input:focus {
          border-color: var(--primary) !important;
          box-shadow: 0 0 0 3px var(--primary-soft);
        }
        html[data-theme="blast"] .game-search-input:focus {
          border-color: var(--primary) !important;
          box-shadow: 0 0 12px rgba(217, 255, 63, 0.18);
        }
      `}</style>
    </div>
  );
}
