import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HOVER_CONFIG,
  HoverIntentController,
  resolvePopupWordAction,
  sanitizeHoverDelayMs,
} from '../src/lib/hover-intent';

describe('hover intent and hovered-word keyboard actions (#5)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not trigger when cursor sweeps across a token before hoverDelayMs', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const ctrl = new HoverIntentController<string>(() => ({
      ...DEFAULT_HOVER_CONFIG,
      hoverDelayMs: 200,
    }));

    ctrl.enter('食べる', false, onOpen);
    vi.advanceTimersByTime(120);
    ctrl.leave();
    vi.advanceTimersByTime(300);

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens after resting for hoverDelayMs', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const ctrl = new HoverIntentController<string>(() => ({
      ...DEFAULT_HOVER_CONFIG,
      hoverDelayMs: 200,
    }));

    ctrl.enter('魔法', false, onOpen);
    vi.advanceTimersByTime(199);
    expect(onOpen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onOpen).toHaveBeenCalledWith('魔法');
  });

  it('supports Yomitan-style Shift+hover trigger mode', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const ctrl = new HoverIntentController<string>(() => ({
      hoverDelayMs: 200,
      pauseOnHover: true,
      requireShiftForHover: true,
    }));

    // Hovering without Shift never triggers on its own
    ctrl.enter('魔導書', false, onOpen);
    vi.advanceTimersByTime(500);
    expect(onOpen).not.toHaveBeenCalled();

    // Pressing Shift while still resting on the token triggers immediately
    expect(ctrl.triggerWithShift(onOpen)).toBe(true);
    expect(onOpen).toHaveBeenCalledWith('魔導書');
  });

  it('maps K / I / S keys to known / ignored / learning when no modifiers are held', () => {
    const base = { altKey: false, ctrlKey: false, shiftKey: false, metaKey: false };
    expect(resolvePopupWordAction({ ...base, code: 'KeyK' })).toBe('known');
    expect(resolvePopupWordAction({ ...base, code: 'KeyI' })).toBe('ignored');
    expect(resolvePopupWordAction({ ...base, code: 'KeyS' })).toBe('learning');
    expect(resolvePopupWordAction({ ...base, code: 'KeyK', ctrlKey: true })).toBeNull();
    expect(resolvePopupWordAction({ ...base, code: 'KeyA' })).toBeNull();
  });

  it('clamps hoverDelayMs safely between 0 and 2000', () => {
    expect(sanitizeHoverDelayMs(-50)).toBe(0);
    expect(sanitizeHoverDelayMs(5000)).toBe(2000);
    expect(sanitizeHoverDelayMs('not-a-number')).toBe(200);
  });
});
