import { describe, expect, it, vi } from 'vitest';
import type { LineOut, TokenOut } from '../src/api/client';
import {
  buildLineRomaji,
  getLineRomaji,
  renderTokenSegments,
  shouldShowRuby,
} from '../src/lib/furigana';
import {
  adjustOffsetMs,
  applyOffsetToActiveStretch,
  computeSyncOffsetMs,
  createDebouncer,
  findActiveLine,
  findActiveLines,
  findReferenceLineForSync,
  formatActiveLinesKey,
  isLineActive,
  normalizeSyncPoints,
  resolveOffsetAt,
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
    is_proper_noun: false,
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
    romaji: 'nanika tabetai',
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

  it('normalizes and resolves piecewise sync points by video time (#138)', () => {
    const normalized = normalizeSyncPoints([
      { at_ms: 900_000, offset_ms: -500 },
      { at_ms: 0, offset_ms: 9999 },
      { at_ms: -100, offset_ms: 8888 },
      { at_ms: 300_000.4, offset_ms: 1500.2 },
      { at_ms: 300_000, offset_ms: 2300 },
    ]);
    expect(normalized).toEqual([
      { at_ms: 300_000, offset_ms: 2300 },
      { at_ms: 900_000, offset_ms: -500 },
    ]);

    // Empty points -> always base offset
    expect(resolveOffsetAt(500_000, 1200, [])).toBe(1200);

    // Before first point -> base offset
    expect(resolveOffsetAt(0, 1000, normalized)).toBe(1000);
    expect(resolveOffsetAt(299_999, 1000, normalized)).toBe(1000);

    // At and after first point, before second point -> first point offset
    expect(resolveOffsetAt(300_000, 1000, normalized)).toBe(2300);
    expect(resolveOffsetAt(899_999, 1000, normalized)).toBe(2300);

    // At and after second point -> second point offset
    expect(resolveOffsetAt(900_000, 1000, normalized)).toBe(-500);
    expect(resolveOffsetAt(1_400_000, 1000, normalized)).toBe(-500);

    // Works even if caller passes unsorted points
    expect(
      resolveOffsetAt(700_000, 1000, [
        { at_ms: 900_000, offset_ms: -500 },
        { at_ms: 300_000, offset_ms: 2300 },
      ]),
    ).toBe(2300);

    // End-to-end line activation across a cut: [600_000, 603_000) shifted +2300 -> [602_300, 605_300)
    const line = makeLine({ id: 5, start_ms: 600_000, end_ms: 603_000 });
    const pts = [{ at_ms: 500_000, offset_ms: 2300 }];
    const offsetAtCut = resolveOffsetAt(604_000, 0, pts);
    expect(offsetAtCut).toBe(2300);
    expect(findActiveLines([line], 604_000, offsetAtCut).map((l) => l.id)).toEqual([5]);
    expect(findActiveLines([line], 604_000, 0)).toEqual([]);
  });

  it('adjusts only the active stretch for manual offset hotkeys (#138)', () => {
    const points = [
      { at_ms: 300_000, offset_ms: 2300 },
      { at_ms: 900_000, offset_ms: -500 },
    ];

    // Before first point -> adjusts base sub_offset_ms, preserves points
    const beforeCut = applyOffsetToActiveStretch(120_000, 1000, points, 1100);
    expect(beforeCut).toEqual({
      subOffsetMs: 1100,
      syncPoints: points,
      target: 'base',
      pointAtMs: null,
      offsetMs: 1100,
      patch: { sub_offset_ms: 1100 },
    });

    // Inside first sync point stretch -> updates only that point, preserves base and later point
    const firstStretch = applyOffsetToActiveStretch(642_000, 1000, points, 2400);
    expect(firstStretch).toEqual({
      subOffsetMs: 1000,
      syncPoints: [
        { at_ms: 300_000, offset_ms: 2400 },
        { at_ms: 900_000, offset_ms: -500 },
      ],
      target: 'point',
      pointAtMs: 300_000,
      offsetMs: 2400,
      patch: {
        sync_points: [
          { at_ms: 300_000, offset_ms: 2400 },
          { at_ms: 900_000, offset_ms: -500 },
        ],
      },
    });

    // Inside second sync point stretch -> updates only the second point
    const secondStretch = applyOffsetToActiveStretch(900_000, 1000, points, -600);
    expect(secondStretch.target).toBe('point');
    expect(secondStretch.pointAtMs).toBe(900_000);
    expect(secondStretch.subOffsetMs).toBe(1000);
    expect(secondStretch.syncPoints).toEqual([
      { at_ms: 300_000, offset_ms: 2300 },
      { at_ms: 900_000, offset_ms: -600 },
    ]);

    // Cancelable debouncer drops pending callbacks cleanly on reset/episode change
    vi.useFakeTimers();
    const fn = vi.fn();
    const debouncer = createDebouncer(400);
    debouncer(fn);
    debouncer.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
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

  it('prefers grouped LineOut.romaji (#8) and falls back to joined token romaji', () => {
    const line = makeLine({ romaji: 'tabi wa owatta' });
    expect(getLineRomaji(line)).toBe('tabi wa owatta');
    expect(getLineRomaji(makeLine({ romaji: '' }))).toBe('tabe tai');
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
