import type { WordListItem } from '../api/client';

export type KanaDrillMode = 'mixed' | 'hiragana' | 'katakana';

export interface KanaDrillItem {
  id: string;
  /** The kana string the learner reads (hiragana or katakana). */
  prompt: string;
  /** Canonical Hepburn romaji shown as the official answer. */
  romaji: string;
  /** Original lemma (useful when drilling the reading of a kanji word). */
  lemma: string;
  /** Hiragana reading for dictionary lookup. */
  reading: string;
  script: 'hiragana' | 'katakana';
  source: 'anime' | 'starter';
  occurrences?: number | null;
  wordId?: number;
  hintEn?: string;
}

const HIRAGANA_RE = /^[\u3041-\u3096ー]+$/;
const KATAKANA_RE = /^[\u30A1-\u30FAー]+$/;
const KANA_RE = /^[\u3041-\u3096\u30A1-\u30FAー]+$/;

export function isPureHiragana(text: string): boolean {
  return text.length > 0 && HIRAGANA_RE.test(text);
}

export function isPureKatakana(text: string): boolean {
  return text.length > 0 && KATAKANA_RE.test(text);
}

export function isPureKana(text: string): boolean {
  return text.length > 0 && KANA_RE.test(text);
}

export function katakanaToHiragana(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x30a1 && code <= 0x30f6) {
      out += String.fromCharCode(code - 0x60);
    } else {
      out += ch;
    }
  }
  return out;
}

const DIGRAPHS: Record<string, string> = {
  きゃ: 'kya',
  きゅ: 'kyu',
  きょ: 'kyo',
  しゃ: 'sha',
  しゅ: 'shu',
  しょ: 'sho',
  ちゃ: 'cha',
  ちゅ: 'chu',
  ちょ: 'cho',
  にゃ: 'nya',
  にゅ: 'nyu',
  にょ: 'nyo',
  ひゃ: 'hya',
  ひゅ: 'hyu',
  ひょ: 'hyo',
  みゃ: 'mya',
  みゅ: 'myu',
  みょ: 'myo',
  りゃ: 'rya',
  りゅ: 'ryu',
  りょ: 'ryo',
  ぎゃ: 'gya',
  ぎゅ: 'gyu',
  ぎょ: 'gyo',
  じゃ: 'ja',
  じゅ: 'ju',
  じょ: 'jo',
  ぢゃ: 'ja',
  ぢゅ: 'ju',
  ぢょ: 'jo',
  びゃ: 'bya',
  びゅ: 'byu',
  びょ: 'byo',
  ぴゃ: 'pya',
  ぴゅ: 'pyu',
  ぴょ: 'pyo',
  // Extended katakana-origin digraphs (normalized to hiragana)
  ふぁ: 'fa',
  ふぃ: 'fi',
  ふぇ: 'fe',
  ふぉ: 'fo',
  てぃ: 'ti',
  でぃ: 'di',
  とぅ: 'tu',
  どぅ: 'du',
  うぃ: 'wi',
  うぇ: 'we',
  うぉ: 'wo',
  ちぇ: 'che',
  しぇ: 'she',
  じぇ: 'je',
  つぁ: 'tsa',
  つぃ: 'tsi',
  つぇ: 'tse',
  つぉ: 'tso',
  ゔぁ: 'va',
  ゔぃ: 'vi',
  ゔぇ: 've',
  ゔぉ: 'vo',
};

const MONOGRAPHS: Record<string, string> = {
  あ: 'a',
  い: 'i',
  う: 'u',
  え: 'e',
  お: 'o',
  か: 'ka',
  き: 'ki',
  く: 'ku',
  け: 'ke',
  こ: 'ko',
  さ: 'sa',
  し: 'shi',
  す: 'su',
  せ: 'se',
  そ: 'so',
  た: 'ta',
  ち: 'chi',
  つ: 'tsu',
  て: 'te',
  と: 'to',
  な: 'na',
  に: 'ni',
  ぬ: 'nu',
  ね: 'ne',
  の: 'no',
  は: 'ha',
  ひ: 'hi',
  ふ: 'fu',
  へ: 'he',
  ほ: 'ho',
  ま: 'ma',
  み: 'mi',
  む: 'mu',
  め: 'me',
  も: 'mo',
  や: 'ya',
  ゆ: 'yu',
  よ: 'yo',
  ら: 'ra',
  り: 'ri',
  る: 'ru',
  れ: 're',
  ろ: 'ro',
  わ: 'wa',
  ゐ: 'wi',
  ゑ: 'we',
  を: 'wo',
  ん: 'n',
  が: 'ga',
  ぎ: 'gi',
  ぐ: 'gu',
  げ: 'ge',
  ご: 'go',
  ざ: 'za',
  じ: 'ji',
  ず: 'zu',
  ぜ: 'ze',
  ぞ: 'zo',
  だ: 'da',
  ぢ: 'ji',
  づ: 'zu',
  で: 'de',
  ど: 'do',
  ば: 'ba',
  び: 'bi',
  ぶ: 'bu',
  べ: 'be',
  ぼ: 'bo',
  ぱ: 'pa',
  ぴ: 'pi',
  ぷ: 'pu',
  ぺ: 'pe',
  ぽ: 'po',
  ゔ: 'vu',
  ぁ: 'a',
  ぃ: 'i',
  ぅ: 'u',
  ぇ: 'e',
  ぉ: 'o',
  ゃ: 'ya',
  ゅ: 'yu',
  ょ: 'yo',
};

function lastVowelOf(str: string): string {
  for (let i = str.length - 1; i >= 0; i--) {
    const ch = str[i];
    if (ch === 'a' || ch === 'i' || ch === 'u' || ch === 'e' || ch === 'o') {
      return ch;
    }
  }
  return '';
}

/**
 * Convert Hiragana or Katakana text into clean Hepburn romaji.
 */
export function kanaToRomaji(kana: string): string {
  const hira = katakanaToHiragana(kana);
  let result = '';
  let i = 0;

  while (i < hira.length) {
    const ch = hira[i];
    if (!ch) break;

    if (ch === 'っ') {
      const nextTwo = hira.slice(i + 1, i + 3);
      const nextOne = hira[i + 1] ?? '';
      const nextSyl = DIGRAPHS[nextTwo] ?? MONOGRAPHS[nextOne] ?? '';
      if (nextSyl.startsWith('ch')) {
        result += 't';
      } else if (nextSyl.length > 0 && /^[bcdfghjklmnpqrstvwxyz]/.test(nextSyl)) {
        result += nextSyl[0];
      }
      i += 1;
      continue;
    }

    if (ch === 'ー') {
      const v = lastVowelOf(result);
      if (v) {
        result += v;
      }
      i += 1;
      continue;
    }

    const pair = hira.slice(i, i + 2);
    const dig = DIGRAPHS[pair];
    if (dig) {
      result += dig;
      i += 2;
      continue;
    }

    const mono = MONOGRAPHS[ch];
    if (mono) {
      result += mono;
      i += 1;
      continue;
    }

    result += ch;
    i += 1;
  }

  return result;
}

/**
 * Canonicalize romaji spelling variants (Hepburn, Kunrei-shiki, IME conventions)
 * so beginners aren't penalized for typing e.g. `si`/`shi`, `tu`/`tsu`, `hu`/`fu`,
 * `ti`/`chi`, `cch`/`tch`, `nn`/`n'`.
 */
export function canonicalizeRomaji(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s\-_']/g, '')
    .replace(/ā/g, 'aa')
    .replace(/ī/g, 'ii')
    .replace(/ū/g, 'uu')
    .replace(/ē/g, 'ee')
    .replace(/ō/g, 'ou')
    .replace(/tch/g, 'cch')
    .replace(/shi/g, 'si')
    .replace(/chi/g, 'ti')
    .replace(/tsu/g, 'tu')
    .replace(/fu/g, 'hu')
    .replace(/ji/g, 'zi')
    .replace(/sha/g, 'sya')
    .replace(/shu/g, 'syu')
    .replace(/sho/g, 'syo')
    .replace(/cha/g, 'tya')
    .replace(/chu/g, 'tyu')
    .replace(/cho/g, 'tyo')
    .replace(/jya/g, 'zya')
    .replace(/jyu/g, 'zyu')
    .replace(/jyo/g, 'zyo')
    .replace(/ja/g, 'zya')
    .replace(/ju/g, 'zyu')
    .replace(/jo/g, 'zyo')
    .replace(/dzu/g, 'zu')
    .replace(/du/g, 'zu')
    .replace(/di/g, 'zi')
    .replace(/nn/g, 'n');
}

/**
 * Check whether the user's typed romaji matches the target kana prompt.
 * Accepts standard Hepburn, Kunrei-shiki/IME spellings, and optional short/long
 * vowel notation for katakana `ー` (e.g. `geemu` or `gemu` for `ゲーム`) and `ou`/`oo`/`o`.
 */
export function isRomajiAnswerCorrect(userInput: string, kana: string): boolean {
  const normalizedInput = canonicalizeRomaji(userInput);
  if (!normalizedInput) return false;

  const hira = katakanaToHiragana(kana);
  const fullRomaji = kanaToRomaji(kana);
  const accepted = new Set<string>([canonicalizeRomaji(fullRomaji)]);

  // Also allow katakana chōonpu `ー` to be omitted (e.g. ゲーム -> gemu, ラーメン -> ramen)
  if (hira.includes('ー')) {
    const withoutBar = kanaToRomaji(hira.replace(/ー/g, ''));
    accepted.add(canonicalizeRomaji(withoutBar));
    // Also allow `ou` for `oo` (e.g. ヒーロー -> hiirou / hirou)
    accepted.add(canonicalizeRomaji(fullRomaji.replace(/oo/g, 'ou')));
  }

  // Allow `oo` or `o` for long `ou` (e.g. ありがとう -> arigato / arigatoo / arigatou)
  if (fullRomaji.includes('ou')) {
    accepted.add(canonicalizeRomaji(fullRomaji.replace(/ou/g, 'oo')));
    accepted.add(canonicalizeRomaji(fullRomaji.replace(/ou/g, 'o')));
  }

  // Allow `o` for particle `を`
  if (hira.includes('を')) {
    accepted.add(canonicalizeRomaji(fullRomaji.replace(/wo/g, 'o')));
  }

  return accepted.has(normalizedInput);
}

export const STARTER_KANA_DECK: readonly Omit<KanaDrillItem, 'id' | 'romaji' | 'source'>[] = [
  // Hiragana anime staples
  { prompt: 'ありがとう', lemma: 'ありがとう', reading: 'ありがとう', script: 'hiragana', hintEn: 'thank you' },
  { prompt: 'すごい', lemma: 'すごい', reading: 'すごい', script: 'hiragana', hintEn: 'amazing / incredible' },
  { prompt: 'だいじょうぶ', lemma: '大丈夫', reading: 'だいじょうぶ', script: 'hiragana', hintEn: 'all right / okay' },
  { prompt: 'ちょっと', lemma: 'ちょっと', reading: 'ちょっと', script: 'hiragana', hintEn: 'a little / wait a sec' },
  { prompt: 'やっぱり', lemma: 'やっぱり', reading: 'やっぱり', script: 'hiragana', hintEn: 'as expected / after all' },
  { prompt: 'ほんとう', lemma: '本当', reading: 'ほんとう', script: 'hiragana', hintEn: 'truth / really' },
  { prompt: 'ともだち', lemma: '友達', reading: 'ともだち', script: 'hiragana', hintEn: 'friend' },
  { prompt: 'おはよう', lemma: 'おはよう', reading: 'おはよう', script: 'hiragana', hintEn: 'good morning' },
  { prompt: 'ごめん', lemma: 'ごめん', reading: 'ごめん', script: 'hiragana', hintEn: 'sorry' },
  { prompt: 'ゆっくり', lemma: 'ゆっくり', reading: 'ゆっくり', script: 'hiragana', hintEn: 'slowly / take it easy' },
  { prompt: 'いっしょ', lemma: '一緒', reading: 'いっしょ', script: 'hiragana', hintEn: 'together' },
  { prompt: 'まほう', lemma: '魔法', reading: 'まほう', script: 'hiragana', hintEn: 'magic' },
  // Katakana anime staples
  { prompt: 'ゲーム', lemma: 'ゲーム', reading: 'げーむ', script: 'katakana', hintEn: 'game' },
  { prompt: 'アニメ', lemma: 'アニメ', reading: 'あにめ', script: 'katakana', hintEn: 'anime' },
  { prompt: 'パーティ', lemma: 'パーティ', reading: 'ぱーてぃ', script: 'katakana', hintEn: 'party (RPG / group)' },
  { prompt: 'モンスター', lemma: 'モンスター', reading: 'もんすたー', script: 'katakana', hintEn: 'monster' },
  { prompt: 'ヒーロー', lemma: 'ヒーロー', reading: 'ひーろー', script: 'katakana', hintEn: 'hero' },
  { prompt: 'レベル', lemma: 'レベル', reading: 'れべる', script: 'katakana', hintEn: 'level' },
  { prompt: 'コーヒー', lemma: 'コーヒー', reading: 'こーひー', script: 'katakana', hintEn: 'coffee' },
  { prompt: 'ラーメン', lemma: 'ラーメン', reading: 'らーめん', script: 'katakana', hintEn: 'ramen' },
  { prompt: 'チャンス', lemma: 'チャンス', reading: 'ちゃんす', script: 'katakana', hintEn: 'chance / opportunity' },
  { prompt: 'クエスト', lemma: 'クエスト', reading: 'くえすと', script: 'katakana', hintEn: 'quest' },
  { prompt: 'スキル', lemma: 'スキル', reading: 'すきる', script: 'katakana', hintEn: 'skill' },
  { prompt: 'メッセージ', lemma: 'メッセージ', reading: 'めっせーじ', script: 'katakana', hintEn: 'message' },
];

export interface BuildDeckOptions {
  mode: KanaDrillMode;
  includeKanjiReadings?: boolean;
  deckSize?: number;
  rng?: () => number;
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = copy[i];
    const b = copy[j];
    if (a !== undefined && b !== undefined) {
      copy[i] = b;
      copy[j] = a;
    }
  }
  return copy;
}

/**
 * Build a kana reading drill deck prioritized from the learner's own anime words,
 * topped up with curated anime starter kana words if needed.
 */
export function buildKanaDrillDeck(
  words: readonly WordListItem[],
  options: BuildDeckOptions,
): KanaDrillItem[] {
  const { mode, includeKanjiReadings = false, deckSize = 10, rng = Math.random } = options;
  const seenPrompts = new Set<string>();
  const animeItems: KanaDrillItem[] = [];

  for (const w of words) {
    if (w.status === 'ignored') continue;
    const lemma = w.lemma.trim();
    const reading = w.reading.trim();

    if (isPureKatakana(lemma)) {
      if (mode === 'hiragana') continue;
      if (lemma.length < 2 || seenPrompts.has(lemma)) continue;
      seenPrompts.add(lemma);
      animeItems.push({
        id: `anime-${w.id}`,
        prompt: lemma,
        romaji: kanaToRomaji(lemma),
        lemma,
        reading: reading || katakanaToHiragana(lemma),
        script: 'katakana',
        source: 'anime',
        occurrences: w.occurrences,
        wordId: w.id,
      });
      continue;
    }

    if (isPureHiragana(lemma)) {
      if (mode === 'katakana') continue;
      if (lemma.length < 2 || seenPrompts.has(lemma)) continue;
      seenPrompts.add(lemma);
      animeItems.push({
        id: `anime-${w.id}`,
        prompt: lemma,
        romaji: kanaToRomaji(lemma),
        lemma,
        reading: lemma,
        script: 'hiragana',
        source: 'anime',
        occurrences: w.occurrences,
        wordId: w.id,
      });
      continue;
    }

    // Optional: include hiragana readings of kanji words from the user's anime
    if (includeKanjiReadings && mode !== 'katakana' && isPureHiragana(reading)) {
      if (reading.length < 2 || seenPrompts.has(reading)) continue;
      seenPrompts.add(reading);
      animeItems.push({
        id: `anime-reading-${w.id}`,
        prompt: reading,
        romaji: kanaToRomaji(reading),
        lemma,
        reading,
        script: 'hiragana',
        source: 'anime',
        occurrences: w.occurrences,
        wordId: w.id,
      });
    }
  }

  // Prefer higher-frequency anime words, then shuffle within the top candidate pool
  animeItems.sort((a, b) => (b.occurrences ?? 0) - (a.occurrences ?? 0));
  const candidatePool = shuffle(animeItems.slice(0, Math.max(deckSize * 3, 30)), rng);
  const selected = candidatePool.slice(0, deckSize);

  if (selected.length < deckSize) {
    const starterCandidates: KanaDrillItem[] = STARTER_KANA_DECK.filter((item) => {
      if (mode === 'hiragana' && item.script !== 'hiragana') return false;
      if (mode === 'katakana' && item.script !== 'katakana') return false;
      return !seenPrompts.has(item.prompt);
    }).map((item, idx) => ({
      ...item,
      id: `starter-${idx}-${item.prompt}`,
      romaji: kanaToRomaji(item.prompt),
      source: 'starter',
    }));

    const shuffledStarter = shuffle(starterCandidates, rng);
    for (const item of shuffledStarter) {
      if (selected.length >= deckSize) break;
      selected.push(item);
    }
  }

  return selected;
}

export interface TrickyKanaStat {
  char: string;
  romaji: string;
  misses: number;
}

/**
 * Tally individual kana characters from missed drill items so the learner sees
 * which characters to focus on next.
 */
export function extractTrickyKana(missedPrompts: readonly string[]): TrickyKanaStat[] {
  const counts = new Map<string, number>();
  for (const prompt of missedPrompts) {
    for (const ch of prompt) {
      if (ch === 'ー' || ch === 'っ' || ch === 'ッ') continue;
      if (!isPureKana(ch)) continue;
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([char, misses]) => ({
      char,
      romaji: kanaToRomaji(char),
      misses,
    }))
    .sort((a, b) => b.misses - a.misses || a.char.localeCompare(b.char))
    .slice(0, 8);
}

export const GOJUON_ROWS: readonly {
  row: string;
  cells: readonly { hira: string; kata: string; romaji: string }[];
}[] = [
  {
    row: '∅',
    cells: [
      { hira: 'あ', kata: 'ア', romaji: 'a' },
      { hira: 'い', kata: 'イ', romaji: 'i' },
      { hira: 'う', kata: 'ウ', romaji: 'u' },
      { hira: 'え', kata: 'エ', romaji: 'e' },
      { hira: 'お', kata: 'オ', romaji: 'o' },
    ],
  },
  {
    row: 'k',
    cells: [
      { hira: 'か', kata: 'カ', romaji: 'ka' },
      { hira: 'き', kata: 'キ', romaji: 'ki' },
      { hira: 'く', kata: 'ク', romaji: 'ku' },
      { hira: 'け', kata: 'ケ', romaji: 'ke' },
      { hira: 'こ', kata: 'コ', romaji: 'ko' },
    ],
  },
  {
    row: 's',
    cells: [
      { hira: 'さ', kata: 'サ', romaji: 'sa' },
      { hira: 'し', kata: 'シ', romaji: 'shi' },
      { hira: 'す', kata: 'ス', romaji: 'su' },
      { hira: 'せ', kata: 'セ', romaji: 'se' },
      { hira: 'そ', kata: 'ソ', romaji: 'so' },
    ],
  },
  {
    row: 't',
    cells: [
      { hira: 'た', kata: 'タ', romaji: 'ta' },
      { hira: 'ち', kata: 'チ', romaji: 'chi' },
      { hira: 'つ', kata: 'ツ', romaji: 'tsu' },
      { hira: 'て', kata: 'テ', romaji: 'te' },
      { hira: 'と', kata: 'ト', romaji: 'to' },
    ],
  },
  {
    row: 'n',
    cells: [
      { hira: 'な', kata: 'ナ', romaji: 'na' },
      { hira: 'に', kata: 'ニ', romaji: 'ni' },
      { hira: 'ぬ', kata: 'ヌ', romaji: 'nu' },
      { hira: 'ね', kata: 'ネ', romaji: 'ne' },
      { hira: 'の', kata: 'ノ', romaji: 'no' },
    ],
  },
  {
    row: 'h',
    cells: [
      { hira: 'は', kata: 'ハ', romaji: 'ha' },
      { hira: 'ひ', kata: 'ヒ', romaji: 'hi' },
      { hira: 'ふ', kata: 'フ', romaji: 'fu' },
      { hira: 'へ', kata: 'ヘ', romaji: 'he' },
      { hira: 'ほ', kata: 'ホ', romaji: 'ho' },
    ],
  },
  {
    row: 'm',
    cells: [
      { hira: 'ま', kata: 'マ', romaji: 'ma' },
      { hira: 'み', kata: 'ミ', romaji: 'mi' },
      { hira: 'む', kata: 'ム', romaji: 'mu' },
      { hira: 'め', kata: 'メ', romaji: 'me' },
      { hira: 'も', kata: 'モ', romaji: 'mo' },
    ],
  },
  {
    row: 'y',
    cells: [
      { hira: 'や', kata: 'ヤ', romaji: 'ya' },
      { hira: '', kata: '', romaji: '' },
      { hira: 'ゆ', kata: 'ユ', romaji: 'yu' },
      { hira: '', kata: '', romaji: '' },
      { hira: 'よ', kata: 'ヨ', romaji: 'yo' },
    ],
  },
  {
    row: 'r',
    cells: [
      { hira: 'ら', kata: 'ラ', romaji: 'ra' },
      { hira: 'り', kata: 'リ', romaji: 'ri' },
      { hira: 'る', kata: 'ル', romaji: 'ru' },
      { hira: 'れ', kata: 'レ', romaji: 're' },
      { hira: 'ろ', kata: 'ロ', romaji: 'ro' },
    ],
  },
  {
    row: 'w/n',
    cells: [
      { hira: 'わ', kata: 'ワ', romaji: 'wa' },
      { hira: '', kata: '', romaji: '' },
      { hira: 'を', kata: 'ヲ', romaji: 'wo' },
      { hira: '', kata: '', romaji: '' },
      { hira: 'ん', kata: 'ン', romaji: 'n' },
    ],
  },
];
