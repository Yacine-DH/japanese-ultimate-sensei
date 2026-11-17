export interface VideoCandidate<T = HTMLVideoElement> {
  element: T;
  width: number;
  height: number;
  visible: boolean;
}

export const MIN_VIDEO_WIDTH = 160;
export const MIN_VIDEO_HEIGHT = 90;

export function pickLargestVisibleVideo<T>(
  candidates: readonly VideoCandidate<T>[],
): T | null {
  let best: T | null = null;
  let bestArea = 0;

  for (const c of candidates) {
    if (!c.visible || c.width < MIN_VIDEO_WIDTH || c.height < MIN_VIDEO_HEIGHT) {
      continue;
    }
    const area = c.width * c.height;
    if (area > bestArea) {
      bestArea = area;
      best = c.element;
    }
  }

  return best;
}

export function findBestVideoInDocument(doc: Document): HTMLVideoElement | null {
  const videos = Array.from(doc.querySelectorAll('video'));
  const candidates: VideoCandidate<HTMLVideoElement>[] = videos.map((video) => {
    const rect = video.getBoundingClientRect();
    const style = doc.defaultView?.getComputedStyle(video);
    const visible =
      style?.display !== 'none' &&
      style?.visibility !== 'hidden' &&
      Number(style?.opacity ?? '1') > 0;
    return {
      element: video,
      width: rect.width,
      height: rect.height,
      visible,
    };
  });
  return pickLargestVisibleVideo(candidates);
}
