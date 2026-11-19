import { describe, expect, it } from 'vitest';
import {
  bindingFromEvent,
  bindingMatches,
  DEFAULT_HOTKEYS,
  findConflicts,
  formatBinding,
  isEditableTarget,
  isModifierOnly,
  matchHotkey,
  sanitizeHotkeys,
} from '../src/lib/hotkeys';

describe('layout-independent hotkeys (#4)', () => {
  it('matches physical KeyboardEvent.code without AltGr on both QWERTZ and QWERTY', () => {
    // On German QWERTZ, physical `Slash` produces `-`, while on US QWERTY it produces `/`
    expect(
      matchHotkey(DEFAULT_HOTKEYS, {
        code: 'Comma',
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toBe('offsetBack');

    expect(
      matchHotkey(DEFAULT_HOTKEYS, {
        code: 'Period',
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toBe('offsetForward');

    expect(
      matchHotkey(DEFAULT_HOTKEYS, {
        code: 'Slash',
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toBe('syncNow');

    // Pressing with Shift should NOT accidentally match a non-Shift binding
    expect(
      matchHotkey(DEFAULT_HOTKEYS, {
        code: 'Comma',
        altKey: false,
        ctrlKey: false,
        shiftKey: true,
        metaKey: false,
      }),
    ).toBeNull();
  });

  it('captures valid bindings and ignores modifier-only presses', () => {
    expect(isModifierOnly('AltRight')).toBe(true);
    expect(
      bindingFromEvent({
        code: 'ShiftLeft',
        altKey: false,
        ctrlKey: false,
        shiftKey: true,
        metaKey: false,
      }),
    ).toBeNull();

    const custom = bindingFromEvent({
      code: 'ArrowLeft',
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
    });
    expect(custom).toEqual({
      code: 'ArrowLeft',
      alt: true,
      ctrl: false,
      shift: false,
      meta: false,
    });
    expect(
      bindingMatches(custom!, {
        code: 'ArrowLeft',
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toBe(true);
  });

  it('sanitizes partial or invalid bindings and detects conflicts', () => {
    const clean = sanitizeHotkeys({
      offsetBack: { code: 'ArrowLeft', alt: true, ctrl: false, shift: false, meta: false },
      offsetForward: { code: 'ShiftLeft', alt: false, ctrl: false, shift: true, meta: false },
    });
    expect(clean.offsetBack.code).toBe('ArrowLeft');
    expect(clean.offsetBack.alt).toBe(true);
    // Invalid modifier-only binding falls back to default
    expect(clean.offsetForward).toEqual(DEFAULT_HOTKEYS.offsetForward);

    const conflicting = {
      ...DEFAULT_HOTKEYS,
      offsetForward: { ...DEFAULT_HOTKEYS.offsetBack },
    };
    expect(findConflicts(conflicting).sort()).toEqual(['offsetBack', 'offsetForward']);
    expect(findConflicts(DEFAULT_HOTKEYS)).toEqual([]);
  });

  it('formats bindings using layout map when available (e.g. QWERTZ Slash -> -)', () => {
    const qwertzMap = new Map([
      ['Comma', ','],
      ['Period', '.'],
      ['Slash', '-'],
    ]);
    expect(formatBinding(DEFAULT_HOTKEYS.syncNow, qwertzMap)).toBe('-');
    expect(formatBinding(DEFAULT_HOTKEYS.syncNow, null)).toBe('/');
    expect(
      formatBinding({ code: 'ArrowLeft', alt: true, ctrl: false, shift: false, meta: false }),
    ).toBe('Alt+←');
  });

  it('detects editable targets so hotkeys do not hijack typing', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const div = document.createElement('div');
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
