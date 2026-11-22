/**
 * Layout-independent hotkeys (#4). Bindings match on `KeyboardEvent.code` (physical key),
 * so the defaults sit on the same physical keys on German QWERTZ and US QWERTY and never
 * need AltGr.
 */

export type HotkeyAction =
  | 'offsetBack'
  | 'offsetForward'
  | 'syncNow'
  | 'autoSync'
  | 'replayLine'
  | 'slowReplayLine'
  | 'toggleAutoPause'
  | 'toggleRomaji'
  | 'revealTranslation'
  | 'explainLine';

export interface HotkeyBinding {
  code: string;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

export type HotkeyBindings = Record<HotkeyAction, HotkeyBinding>;

export const HOTKEY_ACTIONS: readonly HotkeyAction[] = [
  'offsetBack',
  'offsetForward',
  'syncNow',
  'autoSync',
  'replayLine',
  'slowReplayLine',
  'toggleAutoPause',
  'toggleRomaji',
  'revealTranslation',
  'explainLine',
];

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  offsetBack: 'Subtitles earlier (−100 ms)',
  offsetForward: 'Subtitles later (+100 ms)',
  syncNow: 'Sync: current line starts now',
  autoSync: 'Auto-sync subtitles from audio',
  replayLine: 'Replay current / last line',
  slowReplayLine: 'Slow replay line (0.75×)',
  toggleAutoPause: 'Toggle auto-pause after line',
  toggleRomaji: 'Toggle romaji line',
  revealTranslation: 'Reveal translation (current line)',
  explainLine: 'Explain current line (LLM)',
};

function key(code: string, mods: Partial<Omit<HotkeyBinding, 'code'>> = {}): HotkeyBinding {
  return { code, alt: false, ctrl: false, shift: false, meta: false, ...mods };
}

/** Layout-independent defaults on physical keys (all work on QWERTZ & QWERTY without AltGr). */
export const DEFAULT_HOTKEYS: HotkeyBindings = {
  offsetBack: key('Comma'),
  offsetForward: key('Period'),
  syncNow: key('Slash'),
  autoSync: key('KeyY'),
  replayLine: key('KeyR'),
  slowReplayLine: key('KeyR', { shift: true }),
  toggleAutoPause: key('KeyP', { alt: true }),
  toggleRomaji: key('KeyR', { alt: true }),
  revealTranslation: key('KeyT'),
  explainLine: key('KeyE'),
};

export interface KeyEventLike {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
]);

export function isModifierOnly(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

export function bindingFromEvent(event: KeyEventLike): HotkeyBinding | null {
  if (!event.code || isModifierOnly(event.code)) {
    return null;
  }
  return {
    code: event.code,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

export function bindingMatches(binding: HotkeyBinding, event: KeyEventLike): boolean {
  return (
    binding.code === event.code &&
    binding.alt === event.altKey &&
    binding.ctrl === event.ctrlKey &&
    binding.shift === event.shiftKey &&
    binding.meta === event.metaKey
  );
}

export function matchHotkey<A extends string>(
  bindings: Record<A, HotkeyBinding>,
  event: KeyEventLike,
): A | null {
  for (const action of Object.keys(bindings) as A[]) {
    if (bindingMatches(bindings[action], event)) {
      return action;
    }
  }
  return null;
}

function isValidBinding(raw: unknown): raw is HotkeyBinding {
  if (typeof raw !== 'object' || raw === null) return false;
  const b = raw as Record<string, unknown>;
  return (
    typeof b.code === 'string' &&
    b.code.length > 0 &&
    !isModifierOnly(b.code) &&
    typeof b.alt === 'boolean' &&
    typeof b.ctrl === 'boolean' &&
    typeof b.shift === 'boolean' &&
    typeof b.meta === 'boolean'
  );
}

export function sanitizeHotkeys(raw: unknown): HotkeyBindings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const result = { ...DEFAULT_HOTKEYS };
  for (const action of HOTKEY_ACTIONS) {
    const candidate = source[action];
    if (isValidBinding(candidate)) {
      result[action] = { ...candidate };
    }
  }
  return result;
}

/** Actions whose binding collides with another action's binding. */
export function findConflicts(bindings: HotkeyBindings): HotkeyAction[] {
  const conflicts = new Set<HotkeyAction>();
  for (let i = 0; i < HOTKEY_ACTIONS.length; i++) {
    for (let j = i + 1; j < HOTKEY_ACTIONS.length; j++) {
      const a = HOTKEY_ACTIONS[i]!;
      const b = HOTKEY_ACTIONS[j]!;
      const ba = bindings[a];
      const bb = bindings[b];
      if (
        ba.code === bb.code &&
        ba.alt === bb.alt &&
        ba.ctrl === bb.ctrl &&
        ba.shift === bb.shift &&
        ba.meta === bb.meta
      ) {
        conflicts.add(a);
        conflicts.add(b);
      }
    }
  }
  return [...conflicts];
}

const FRIENDLY_CODES: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

/**
 * Human label. `layoutMap` (from `navigator.keyboard.getLayoutMap()`, Chromium only) gives the
 * character printed on the user's physical key, e.g. `Slash` → `-` on QWERTZ.
 */
export function formatBinding(
  binding: HotkeyBinding,
  layoutMap?: { get(code: string): string | undefined } | null,
): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  if (binding.meta) parts.push('Meta');

  const fromLayout = layoutMap?.get(binding.code);
  let keyLabel: string;
  if (fromLayout && fromLayout.trim() !== '') {
    keyLabel = fromLayout.length === 1 ? fromLayout.toUpperCase() : fromLayout;
  } else if (FRIENDLY_CODES[binding.code]) {
    keyLabel = FRIENDLY_CODES[binding.code]!;
  } else if (binding.code.startsWith('Key')) {
    keyLabel = binding.code.slice(3);
  } else if (binding.code.startsWith('Digit')) {
    keyLabel = binding.code.slice(5);
  } else {
    keyLabel = binding.code;
  }
  parts.push(keyLabel);
  return parts.join('+');
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}
