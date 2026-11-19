import type { WordStatus } from '../api/client';
import type { KeyEventLike } from './hotkeys';

export interface HoverConfig {
  hoverDelayMs: number;
  pauseOnHover: boolean;
  requireShiftForHover: boolean;
}

export const DEFAULT_HOVER_CONFIG: HoverConfig = {
  hoverDelayMs: 200,
  pauseOnHover: true,
  requireShiftForHover: false,
};

export function sanitizeHoverDelayMs(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return DEFAULT_HOVER_CONFIG.hoverDelayMs;
  }
  return Math.max(0, Math.min(2000, Math.round(n)));
}

export function resolvePopupWordAction(event: KeyEventLike): WordStatus | null {
  if (event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) {
    return null;
  }
  if (event.code === 'KeyK') {
    return 'known';
  }
  if (event.code === 'KeyI') {
    return 'ignored';
  }
  if (event.code === 'KeyS') {
    return 'learning';
  }
  return null;
}

export class HoverIntentController<T> {
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private hoveredItem: T | null = null;
  private getConfig: () => HoverConfig;

  constructor(getConfig: () => HoverConfig) {
    this.getConfig = getConfig;
  }

  enter(item: T, shiftPressed: boolean, onOpen: (item: T) => void): void {
    this.cancelTimer();
    this.hoveredItem = item;
    const cfg = this.getConfig();

    if (cfg.requireShiftForHover && !shiftPressed) {
      return;
    }

    if (cfg.hoverDelayMs <= 0) {
      onOpen(item);
      return;
    }

    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      if (this.hoveredItem === item) {
        onOpen(item);
      }
    }, cfg.hoverDelayMs);
  }

  leave(): void {
    this.cancelTimer();
    this.hoveredItem = null;
  }

  triggerWithShift(onOpen: (item: T) => void): boolean {
    const cfg = this.getConfig();
    if (!cfg.requireShiftForHover || this.hoveredItem === null) {
      return false;
    }
    this.cancelTimer();
    onOpen(this.hoveredItem);
    return true;
  }

  private cancelTimer(): void {
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }
}
