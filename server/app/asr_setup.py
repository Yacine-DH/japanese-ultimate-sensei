"""Download the Japanese speech model used by auto-sync (#147) into <data_dir>/models/.

ReazonSpeech k2 v2 for sherpa-onnx (int8 ONNX, ~160 MB unpacked). Needs `sherpa-onnx`
installed; without the model, auto-sync keeps using voice activity only.

Usage (from server/):
    uv run python -m app.asr_setup
"""

import argparse
import shutil
import tarfile
import tempfile
from pathlib import Path

import httpx

from app.asr_sync import MODEL_NAME, MODEL_URL
from app.config import get_settings

KEEP = (".int8.onnx", "tokens.txt")  # the fp32 files are 3× larger and not needed on a CPU


def _safe(m: tarfile.TarInfo) -> bool:
    """Plain files inside the archive's folder only (no links, no ../, no absolute paths)."""
    p = Path(m.name)
    return m.isfile() and not p.is_absolute() and ".." not in p.parts


def install(models_dir: Path, url: str = MODEL_URL) -> Path:
    dest = models_dir / MODEL_NAME
    if (dest / "tokens.txt").exists():
        print(f"already installed: {dest}")
        return dest
    models_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=models_dir) as tmp:
        archive = Path(tmp) / "model.tar.bz2"
        print(f"downloading {url}")
        with httpx.stream("GET", url, follow_redirects=True, timeout=600) as r:
            r.raise_for_status()
            with archive.open("wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
        out = Path(tmp) / "out"
        with tarfile.open(archive, "r:bz2") as tar:
            members = [m for m in tar.getmembers() if _safe(m) and m.name.endswith(KEEP)]
            tar.extractall(out, members=members, filter="data")
        found = next(out.rglob("tokens.txt"), None)
        if found is None:
            raise SystemExit("tokens.txt missing from the archive")
        # decoder has no int8 variant in some releases: keep it if it was skipped
        if not list(found.parent.glob("decoder*.onnx")):
            with tarfile.open(archive, "r:bz2") as tar:
                dec = [m for m in tar.getmembers() if _safe(m) and "decoder" in m.name]
                tar.extractall(out, members=dec, filter="data")
        shutil.move(str(found.parent), dest)
    print(f"installed: {dest}")
    return dest


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--url", default=MODEL_URL)
    args = p.parse_args()
    install(get_settings().models_dir, args.url)


if __name__ == "__main__":
    main()
