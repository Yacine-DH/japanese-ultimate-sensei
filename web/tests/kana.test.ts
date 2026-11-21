import { describe, expect, it } from 'vitest';
import type { WordListItem } from '../src/api/client';
import {
  buildKanaDrillDeck,
  extractTrickyKana,
  isPureHiragana,
  isPureKatakana,
  isRomajiAnswerCorrect,
  kanaToRomaji,
} from '../src/lib/kana';

describe('kana detection and romaji conversion', () => {
  it('classifies pure hiragana and pure katakana words accurately', () => {
    expect(isPureHiragana('ありがとう')).toBe(true);
    expect(isPureHiragana('ゲーム')).toBe(false);
    expect(isPureHiragana('魔法')).toBe(false);
    expect(isPureKatakana('ゲーム')).toBe(true);
    expect(isPureKatakana('パーティ')).toBe(true);
    expect(isPureKatakana('ありがとう')).toBe(false);
  });

  it('converts hiragana and katakana including digraphs, gemination, and chōonpu', () => {
    expect(kanaToRomaji('ありがとう')).toBe('arigatou');
    expect(kanaToRomaji('ちょっと')).toBe('chotto');
    expect(kanaToRomaji('やっぱり')).toBe('yappari');
    expect(kanaToRomaji('いっしょ')).toBe('issho');
    expect(kanaToRomaji('マッチ')).toBe('matchi');
    expect(kanaToRomaji('ゲーム')).toBe('geemu');
    expect(kanaToRomaji('コーヒー')).toBe('koohii');
    expect(kanaToRomaji('パーティ')).toBe('paati');
    expect(kanaToRomaji('モンスター')).toBe('monsutaa');
    expect(kanaToRomaji('チャンス')).toBe('chansu');
    expect(kanaToRomaji('ファン')).toBe('fan');
  });

  it('accepts Hepburn, Kunrei-shiki, and reasonable long-vowel variants while rejecting wrong answers', () => {
    expect(isRomajiAnswerCorrect('arigatou', 'ありがとう')).toBe(true);
    expect(isRomajiAnswerCorrect('arigato', 'ありがとう')).toBe(true);
    expect(isRomajiAnswerCorrect('geemu', 'ゲーム')).toBe(true);
    expect(isRomajiAnswerCorrect('gemu', 'ゲーム')).toBe(true);
    expect(isRomajiAnswerCorrect('tyotto', 'ちょっと')).toBe(true);
    expect(isRomajiAnswerCorrect('chotto', 'ちょっと')).toBe(true);
    expect(isRomajiAnswerCorrect('matci', 'マッチ')).toBe(false);
    expect(isRomajiAnswerCorrect('matchi', 'マッチ')).toBe(true);
    expect(isRomajiAnswerCorrect('macchi', 'マッチ')).toBe(true);
    expect(isRomajiAnswerCorrect('susi', 'すし')).toBe(true);
    expect(isRomajiAnswerCorrect('sushi', 'すし')).toBe(true);
    expect(isRomajiAnswerCorrect('ramen', 'ラーメン')).toBe(true);
    expect(isRomajiAnswerCorrect('konnichiwa', 'ありがとう')).toBe(false);
    expect(isRomajiAnswerCorrect('   ', 'すし')).toBe(false);
  });
});

describe('buildKanaDrillDeck', () => {
  const sampleWords: WordListItem[] = [
    { id: 1, lemma: 'ありがとう', reading: 'ありがとう', pos: '感動詞', jmdict_id: null, status: 'new', common: true, occurrences: 12 },
    { id: 2, lemma: 'ゲーム', reading: 'げーむ', pos: '名詞', jmdict_id: null, status: 'learning', common: true, occurrences: 8 },
    { id: 3, lemma: '魔法', reading: 'まほう', pos: '名詞', jmdict_id: null, status: 'new', common: true, occurrences: 20 },
    { id: 4, lemma: 'すごい', reading: 'すごい', pos: '形容詞', jmdict_id: null, status: 'ignored', common: true, occurrences: 15 },
    { id: 5, lemma: 'フリーレン', reading: 'ふりーれん', pos: '名詞', jmdict_id: null, status: 'known', common: false, occurrences: 40 },
  ];

  it('prioritizes anime words, skips ignored words, and tops up with starter deck', () => {
    const deck = buildKanaDrillDeck(sampleWords, {
      mode: 'mixed',
      includeKanjiReadings: false,
      deckSize: 5,
      rng: () => 0.25,
    });
    expect(deck).toHaveLength(5);
    const animePrompts = deck.filter((d) => d.source === 'anime').map((d) => d.prompt);
    expect(animePrompts).toContain('ありがとう');
    expect(animePrompts).toContain('ゲーム');
    expect(animePrompts).toContain('フリーレン');
    // Ignored word excluded
    expect(animePrompts).not.toContain('すごい');
    // Kanji reading excluded when includeKanjiReadings is false
    expect(animePrompts).not.toContain('まほう');
  });

  it('includes kanji word readings when enabled and filters by script mode', () => {
    const hiraDeck = buildKanaDrillDeck(sampleWords, {
      mode: 'hiragana',
      includeKanjiReadings: true,
      deckSize: 4,
      rng: () => 0.5,
    });
    expect(hiraDeck.every((d) => d.script === 'hiragana')).toBe(true);
    expect(hiraDeck.some((d) => d.prompt === 'まほう' && d.lemma === '魔法')).toBe(true);

    const kataDeck = buildKanaDrillDeck(sampleWords, {
      mode: 'katakana',
      includeKanjiReadings: true,
      deckSize: 4,
      rng: () => 0.5,
    });
    expect(kataDeck.every((d) => d.script === 'katakana')).toBe(true);
    expect(kataDeck.some((d) => d.prompt === 'ゲーム')).toBe(true);
  });

  it('tallies tricky kana characters from missed words', () => {
    const tricky = extractTrickyKana(['モンスター', 'スター']);
    expect(tricky[0]?.char).toBe('ス');
    expect(tricky[0]?.misses).toBe(2);
    expect(tricky[0]?.romaji).toBe('su');
    // Long vowel bar is excluded from tricky char counts
    expect(tricky.some((t) => t.char === 'ー')).toBe(false);
  });
});
