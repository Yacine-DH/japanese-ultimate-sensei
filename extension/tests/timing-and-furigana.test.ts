import { describe, expect, it } from 'vitest';
import type { LineOut, TokenOut } from '../src/api/client';
import { buildLineRomaji, renderTokenSegments, shouldShowRuby } from '../src/lib/furigana';
import {
  adjustOffsetMs,
  computeSyncOffsetMs,
  findActiveLine,
  findActiveLines,
  findReferenceLineForSync,
  formatActiveLinesKey,
  isLineActive,
} from '../src/lib/timing';
import {
  computeOverlayBounds,
  pickLargestVisibleVideo,
  resolveOverlayMountTarget,
} from '../src/lib/video';

function makeToken(overrides: Partial<TokenOut> = {}): TokenOut {
  return {
    surface: '食べ',
    lemma: '食べる',
    reading: 'たべ',
    lemma_reading: 'たべる',
    pos: '動詞',
    pos_detail: ['一般'],
    furigana: [
      { text: '食', ruby: 'た' },
      { text: 'べ', ruby: null },
    ],
    romaji: 'tabe',
    is_content: true,
    word_id: 42,
    status: 'new',
    common: true,
    ...overrides,
  };
}

function makeLine(overrides: Partial<LineOut> = {}): LineOut {
  return {
    id: 1,
    idx: 0,
    start_ms: 1000,
    end_ms: 3500,
    text: '何か食べたい',
    tokens: [
      makeToken(),
      makeToken({
        surface: 'たい',
        lemma: 'たい',
        reading: 'たい',
        lemma_reading: 'たい',
        pos: '助動詞',
        furigana: [{ text: 'たい', ruby: null }],
        romaji: 'tai',
        is_content: false,
        word_id: null,
        status: null,
        common: false,
      }),
    ],
    translation_en: null,
    translation_de: null,
    ...overrides,
  };
}

describe('subtitle timing logic (E-2)', () => {
  it('checks active window [start_ms + offset, end_ms + offset)', () => {
    const line = makeLine({ start_ms: 1000, end_ms: 3000 });
    expect(isLineActive(line, 999, 0)).toBe(false);
    expect(isLineActive(line, 1000, 0)).toBe(true);
    expect(isLineActive(line, 2999, 0)).toBe(true);
    expect(isLineActive(line, 3000, 0)).toBe(false);

    // With +200ms offset: active in [1200, 3200)
    expect(isLineActive(line, 1100, 200)).toBe(false);
    expect(isLineActive(line, 1200, 200)).toBe(true);
    expect(isLineActive(line, 3150, 200)).toBe(true);
  });

  it('finds active line and syncs offset via hotkeys', () => {
    const lines = [
      makeLine({ id: 1, idx: 0, start_ms: 1000, end_ms: 2500 }),
      makeLine({ id: 2, idx: 1, start_ms: 3000, end_ms: 5000 }),
    ];

    expect(findActiveLine(lines, 1500, 0)?.id).toBe(1);
    expect(findActiveLine(lines, 2700, 0)).toBeNull();
    expect(findActiveLine(lines, 3200, 0)?.id).toBe(2);


    expect(adjustOffsetMs(0, -100)).toBe(-100);
    expect(adjustOffsetMs(-100, 100)).toBe(0);

    // Syncing line 2 (start_ms 3000) when video is at 3450ms -> offset = +450ms
    const ref = findReferenceLineForSync(lines, 2900, 0);
    expect(ref?.id).toBe(2);
    const syncedOffset = computeSyncOffsetMs(3450, ref!);
    expect(syncedOffset).toBe(450);
    expect(isLineActive(ref!, 3450, syncedOffset)).toBe(true);
  });

  it('returns all overlapping active lines ordered by idx (#6)', () => {
    const lines = [
      makeLine({ id: 10, idx: 0, start_ms: 1000, end_ms: 4000, text: 'フリーレン！' }),
      makeLine({ id: 11, idx: 1, start_ms: 2000, end_ms: 3500, text: 'フェルン、伏せて！' }),
      makeLine({ id: 12, idx: 2, start_ms: 4000, end_ms: 5500, text: '撃つよ' }),
    ];

    // At 1500ms only line 10 is active
    expect(findActiveLines(lines, 1500, 0).map((l) => l.id)).toEqual([10]);

    // At 2500ms both line 10 and line 11 overlap
    const both = findActiveLines(lines, 2500, 0);
    expect(both.map((l) => l.id)).toEqual([10, 11]);
    expect(formatActiveLinesKey(both)).toBe('10,11');

    // At exact boundary 4000ms, line 10 and 11 have ended and line 12 begins
    expect(findActiveLines(lines, 4000, 0).map((l) => l.id)).toEqual([12]);
  });
});

describe('furigana and romaji rendering (E-2)', () => {
  it('shows ruby on new/learning words and hides ruby on known/ignored words', () => {
    const newTok = makeToken({ status: 'new' });
    const learningTok = makeToken({ status: 'learning' });
    const knownTok = makeToken({ status: 'known' });
    const ignoredTok = makeToken({ status: 'ignored' });

    expect(shouldShowRuby(newTok, { text: '食', ruby: 'た' })).toBe(true);
    expect(shouldShowRuby(learningTok, { text: '食', ruby: 'た' })).toBe(true);
    expect(shouldShowRuby(knownTok, { text: '食', ruby: 'た' })).toBe(false);
    expect(shouldShowRuby(ignoredTok, { text: '食', ruby: 'た' })).toBe(false);

    expect(renderTokenSegments(knownTok)).toEqual([
      { text: '食', ruby: null },
      { text: 'べ', ruby: null },
    ]);
  });

  it('joins non-empty token romaji into a single line', () => {
    const line = makeLine();
    expect(buildLineRomaji(line.tokens)).toBe('tabe tai');
  });
});

describe('video detection and overlay positioning (E-2, #1)', () => {
  it('picks the largest visible video above minimum dimensions', () => {
    const picked = pickLargestVisibleVideo([
      { element: 'small-ad', width: 120, height: 60, visible: true },
      { element: 'hidden-big', width: 1920, height: 1080, visible: false },
      { element: 'player-720p', width: 1280, height: 720, visible: true },
      { element: 'preview', width: 320, height: 180, visible: true },
    ]);
    expect(picked).toBe('player-720p');
  });

  it('mounts on documentElement by default so transformed player wrappers never break position:fixed', () => {
    const playerWrapper = document.createElement('div');
    playerWrapper.style.transform = 'translateZ(0)';
    const video = document.createElement('video');
    playerWrapper.appendChild(video);
    document.body.appendChild(playerWrapper);

    expect(
      resolveOverlayMountTarget(
        {
          documentElement: document.documentElement,
          fullscreenElement: null,
          body: document.body,
        },
        video,
      ),
    ).toBe(document.documentElement);

    expect(
      resolveOverlayMountTarget(
        {
          documentElement: document.documentElement,
          fullscreenElement: playerWrapper,
          body: document.body,
        },
        video,
      ),
    ).toBe(playerWrapper);

    expect(
      computeOverlayBounds({ left: 100.4, top: 240.2, width: 1280, height: 720 }, null),
    ).toEqual({
      left: 100,
      top: 240,
      width: 1280,
      height: 720,
    });
  });
});
