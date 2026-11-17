"""Download jmdict-simplified (English + German) and build data/jmdict.sqlite.

Usage (from server/):
    uv run python -m app.dictionary_setup            # download latest release + build
    uv run python -m app.dictionary_setup --from-dir /path/with/json/files
"""

import argparse
import io
import re
import sys
import zipfile
from pathlib import Path

import httpx

from app.config import get_settings
from app.dictionary import build

RELEASES_API = "https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest"
# Per-language full dictionaries, e.g. jmdict-eng-3.6.1+20251110.json.zip / jmdict-ger-...
WANTED = {
    "eng": re.compile(r"^jmdict-eng-\d.*\.json\.zip$"),
    "ger": re.compile(r"^jmdict-ger-\d.*\.json\.zip$"),
}
FALLBACK_ALL = re.compile(r"^jmdict-all-\d.*\.json\.zip$")


def _download_json(client: httpx.Client, url: str, dest_dir: Path) -> Path:
    print(f"  downloading {url}")
    r = client.get(url, follow_redirects=True, timeout=300)
    r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        name = next(n for n in z.namelist() if n.endswith(".json"))
        z.extract(name, dest_dir)
        return dest_dir / name


def download(dest_dir: Path) -> list[Path]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    with httpx.Client(headers={"User-Agent": "sensei-dictionary-setup"}) as client:
        release = client.get(RELEASES_API, timeout=60).raise_for_status().json()
        assets = {a["name"]: a["browser_download_url"] for a in release["assets"]}
        picked = []
        for lang, pat in WANTED.items():
            name = next((n for n in assets if pat.match(n)), None)
            if name:
                picked.append(assets[name])
            else:
                print(f"  no per-language asset for {lang}")
        if len(picked) < len(WANTED):
            name = next((n for n in assets if FALLBACK_ALL.match(n)), None)
            if not name:
                sys.exit("Could not find suitable jmdict-simplified assets in latest release.")
            picked = [assets[name]]
        print(f"release {release['tag_name']}")
        return [_download_json(client, url, dest_dir) for url in picked]


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--from-dir", type=Path, help="use already-downloaded jmdict-*.json files")
    args = p.parse_args()
    settings = get_settings()
    cache = settings.data_dir / "jmdict-src"
    if args.from_dir:
        paths = sorted(args.from_dir.glob("jmdict-*.json"))
    else:
        paths = download(cache)
    if not paths:
        sys.exit("No JSON files found.")
    print(f"building {settings.dictionary_path} from {[p.name for p in paths]}")
    n = build(paths, settings.dictionary_path)
    print(f"done: {n} entries")


if __name__ == "__main__":
    main()
