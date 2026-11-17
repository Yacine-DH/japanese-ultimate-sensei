export interface VideoCandidate<T = HTMLVideoElement> {
  element: T;
  width: number;
  height: number;
  visible: boolean;
}

export interface OverlayBounds {
  left: number;
  top: number;
  width: number;
  height: number;
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

export function resolveOverlayMountTarget(
  doc: Pick<Document, 'documentElement' | 'fullscreenElement' | 'body'>,
  video: Node,
): Element {
  const fs = doc.fullscreenElement;
  if (fs && fs.contains(video)) {
    return fs;
  }
  return doc.documentElement ?? doc.body;
}

export function computeOverlayBounds(
  videoRect: OverlayBounds,
  fullscreenContainerRect?: { left: number; top: number } | null,
): OverlayBounds {
  const offsetLeft = fullscreenContainerRect ? fullscreenContainerRect.left : 0;
  const offsetTop = fullscreenContainerRect ? fullscreenContainerRect.top : 0;
  return {
    left: Math.round(videoRect.left - offsetLeft),
    top: Math.round(videoRect.top - offsetTop),
    width: Math.round(videoRect.width),
    height: Math.round(videoRect.height),
  };
}
