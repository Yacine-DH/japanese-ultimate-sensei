"""Scene media (screenshot / line audio / short clip): ffmpeg transcoding + signed URLs.

Targets (about 0.3 MB per card in total):
- screenshot → WebP, ≤ 640 px wide, quality 70 (~40 KB)
- audio      → Opus 32 kbps mono in Ogg (~20 KB for a line)
- clip       → VP9 WebM, ≤ 360 px tall, 12 fps, no audio, ≤ 20 s (~150–300 KB)
"""

import hashlib
import hmac
import logging
import shutil
import subprocess
from pathlib import Path

from app.models import MediaKind

log = logging.getLogger(__name__)

MAX_BYTES = {
    MediaKind.screenshot: 10 * 1024 * 1024,
    MediaKind.audio: 15 * 1024 * 1024,
    MediaKind.clip: 80 * 1024 * 1024,
}
OUTPUT = {  # kind → (extension, mime, ffmpeg output args)
    MediaKind.screenshot: (
        "webp",
        "image/webp",
        ["-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-c:v", "libwebp", "-quality", "70"],
    ),
    MediaKind.audio: (
        "ogg",
        "audio/ogg",
        ["-vn", "-t", "30", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k"],
    ),
    MediaKind.clip: (
        "webm",
        "video/webm",
        [
            "-an", "-t", "20", "-vf", "scale=-2:'min(360,ih)',fps=12",
            "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40",
            "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1",
        ],
    ),
}  # fmt: skip
TIMEOUT_S = 180


class MediaError(Exception):
    pass


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def probe(src: Path) -> None:
    """Raise MediaError unless ffprobe can read at least one stream."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", src],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if r.returncode != 0 or not r.stdout.strip():
        raise MediaError(f"not a readable media file: {r.stderr.strip()[:200]}")


def transcode(kind: MediaKind, src: Path, dst_stem: Path) -> tuple[Path, str]:
    """Transcode `src` into `dst_stem.<ext>`. Returns (output path, mime)."""
    ext, mime, args = OUTPUT[kind]
    dst = dst_stem.with_suffix("." + ext)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".part." + ext)
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(src), *args, str(tmp)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired as e:
        tmp.unlink(missing_ok=True)
        raise MediaError("transcoding timed out") from e
    if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        raise MediaError(f"ffmpeg failed: {r.stderr.strip()[-300:]}")
    tmp.replace(dst)
    return dst, mime


def ensure_mp3(src: Path) -> Path:
    """MP3 copy of an audio file next to it (cached), for Anki clients without Opus support."""
    dst = src.with_suffix(".mp3")
    if dst.is_file() and dst.stat().st_mtime >= src.stat().st_mtime:
        return dst
    tmp = src.with_suffix(".part.mp3")
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(src), "-vn", "-ac", "1",
         "-c:a", "libmp3lame", "-b:a", "64k", str(tmp)],
        capture_output=True, text=True, timeout=TIMEOUT_S,
    )  # fmt: skip
    if r.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        raise MediaError(f"mp3 conversion failed: {r.stderr.strip()[-200:]}")
    tmp.replace(dst)
    return dst


def sign(token: str, media_id: int) -> str:
    """Per-file URL signature so <img>/<audio> tags work without an auth header.
    Derived from the API token, so it never reveals it and rotating the token revokes it."""
    return hmac.new(token.encode(), f"media:{media_id}".encode(), hashlib.sha256).hexdigest()[:32]


def check_sig(token: str, media_id: int, sig: str | None) -> bool:
    return bool(sig) and hmac.compare_digest(sign(token, media_id), sig or "")
