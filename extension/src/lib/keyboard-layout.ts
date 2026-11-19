export type LayoutMap = { get(code: string): string | undefined } | null;

/** Chromium-only `navigator.keyboard.getLayoutMap()`; null elsewhere (Firefox). */
export async function getKeyboardLayoutMap(): Promise<LayoutMap> {
  const nav = navigator as Navigator & {
    keyboard?: { getLayoutMap?: () => Promise<LayoutMap> };
  };
  try {
    return (await nav.keyboard?.getLayoutMap?.()) ?? null;
  } catch {
    return null;
  }
}
