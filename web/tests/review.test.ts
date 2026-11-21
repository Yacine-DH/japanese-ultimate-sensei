import { describe, expect, it } from 'vitest';
import {
  formatIntervalFromIso,
  groupCardMedia,
  resolveMediaUrl,
  resolveReviewHotkey,
} from '../src/lib/review';

describe('FSRS review session helpers (W-3, #24)', () => {
  it('formats next_due ISO timestamps into compact interval labels', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    expect(formatIntervalFromIso('2026-11-19T12:00:30Z', now)).toBe('<1m');
    expect(formatIntervalFromIso('2026-11-19T12:06:00Z', now)).toBe('6m');
    expect(formatIntervalFromIso('2026-11-19T15:00:00Z', now)).toBe('3h');
    expect(formatIntervalFromIso('2026-11-26T12:00:00Z', now)).toBe('7d');
    expect(formatIntervalFromIso('2027-01-20T12:00:00Z', now)).toBe('2.1mo');
    expect(formatIntervalFromIso(undefined, now)).toBe('');
  });

  it('groups card media by screenshot / audio / clip and resolves relative URLs', () => {
    const grouped = groupCardMedia([
      { id: 1, kind: 'screenshot', mime: 'image/webp', url: '/media/1', bytes: 32000, ready: true },
      { id: 2, kind: 'audio', mime: 'audio/ogg', url: '/media/2', bytes: 18000, ready: true },
      { id: 3, kind: 'clip', mime: 'video/webm', url: '/media/3', bytes: 180000, ready: false },
    ]);
    expect(grouped.screenshot?.id).toBe(1);
    expect(grouped.audio?.id).toBe(2);
    expect(grouped.clip?.id).toBe(3);

    expect(resolveMediaUrl('/media/1', 'http://homeserver:8000/')).toBe(
      'http://homeserver:8000/media/1',
    );
    expect(resolveMediaUrl('https://cdn.example/clip.webm', 'http://homeserver:8000')).toBe(
      'https://cdn.example/clip.webm',
    );
  });

  it('maps review keyboard shortcuts Space, 1-4, and R according to reveal state', () => {
    const base = { altKey: false, ctrlKey: false, shiftKey: false, metaKey: false };

    // Before reveal: Space reveals, 1-4 do nothing, R replays audio
    expect(resolveReviewHotkey({ ...base, code: 'Space' }, false)).toEqual({ type: 'reveal' });
    expect(resolveReviewHotkey({ ...base, code: 'Digit3' }, false)).toBeNull();
    expect(resolveReviewHotkey({ ...base, code: 'KeyR' }, false)).toEqual({ type: 'replay' });

    // After reveal: 1-4 rate Again/Hard/Good/Easy, Space does nothing
    expect(resolveReviewHotkey({ ...base, code: 'Digit1' }, true)).toEqual({
      type: 'rate',
      rating: 1,
    });
    expect(resolveReviewHotkey({ ...base, code: 'Digit2' }, true)).toEqual({
      type: 'rate',
      rating: 2,
    });
    expect(resolveReviewHotkey({ ...base, code: 'Digit3' }, true)).toEqual({
      type: 'rate',
      rating: 3,
    });
    expect(resolveReviewHotkey({ ...base, code: 'Digit4' }, true)).toEqual({
      type: 'rate',
      rating: 4,
    });
    expect(resolveReviewHotkey({ ...base, code: 'Space' }, true)).toBeNull();
    // Modified keys are ignored
    expect(resolveReviewHotkey({ ...base, code: 'Digit1', ctrlKey: true }, true)).toBeNull();
  });
});
