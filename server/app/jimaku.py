"""Jimaku.cc client: find Japanese subtitle files for an anime episode and download them.

API docs: https://jimaku.cc/api/docs (auth: `Authorization: <api key>`).
"""

import io
import re
import zipfile
from dataclasses import dataclass

import httpx

BASE_URL = "https://jimaku.cc/api"
SUBTITLE_EXT = (".srt", ".ass", ".ssa", ".vtt")
MAX_DOWNLOAD = 25 * 1024 * 1024
# Release tags whose timing usually matches streaming sites: web rips. Free sites mostly
# re-host Crunchyroll/Netflix/Amazon encodes (SubsPlease and Erai-raws rip Crunchyroll).
# TV broadcast rips (AT-X, TOKYO MX…) are neutral, Blu-ray gets a malus (different cut).
WEB_TAGS = re.compile(
    r"\b(web|webrip|web-?dl|netflix|nf|amzn|amazon|cr|crunchyroll|b-global|hulu|abema|hidive"
    r"|disney|dsnp|subsplease|erai|erai-raws)\b",
    re.I,
)
BD_TAGS = re.compile(r"\b(bd|bdrip|bd-?rip|blu-?ray|bdmv|bdremux)\b", re.I)
# Dual-language files (_ja-en.ass, [CHS, JPN], JPSC) would import English/Chinese lines.
DUAL_TAGS = re.compile(
    r"(?:^|[^a-z])(ja[-_+]en|en[-_+]ja|jpsc|jptc|jpn?[-_+]?(?:chs|cht|sc|tc)|chs|cht|eng)(?:[^a-z]|$)",
    re.I,
)
SDH_TAGS = re.compile(r"[\[(](sdh|cc)[\])]", re.I)
_EP_PATTERNS = [
    re.compile(
        r"\b(?:s\d{1,2})?e(?:p(?:isode)?)?[ ._-]?(\d{1,4})(?:v\d)?\b", re.I
    ),  # E01, S01E03, Ep 3
    re.compile(r"(?:^|[ _\-\]\)])-[ _](\d{1,4})(?:v\d)?(?=[ _.\[(]|$)"),  # "Show - 01 [..]"
    re.compile(r"第(\d{1,4})話"),
    re.compile(
        r"(?:^|[ _])(\d{1,4})(?:v\d)?(?=[ _]*(?:\.\w+)?[ _]*$)"
    ),  # "Show 01 [..]" (tags gone)
]
_BRACKET_EP = re.compile(r"\[(\d{1,4})(?:v\d)?\]")  # "[Group] Show [01][Web]"
_RANGE = re.compile(r"(?:^|[ _\-\]])(\d{1,4})\s*[-~]\s*(\d{1,4})(?=[ _.\[(]|$)")


class JimakuError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


@dataclass
class FileInfo:
    name: str
    url: str
    size: int
    last_modified: str
    format: str  # srt | ass | ssa | vtt | zip | 7z | rar | sup | other
    supported: bool  # we can import it (text subtitle or zip of them)
    episode: int | None  # episode guessed from the name
    multi_episode: bool  # e.g. "01-04": several episodes in one file (can't import one)
    web_source: bool  # timing likely matches streaming sites
    score: int = 0
    dual_language: bool = False  # also has English/Chinese lines
    recommended: bool = False


def file_format(name: str) -> str:
    lower = name.lower()
    if lower.endswith((".sup.7z", ".sup.zip", ".sup")):
        return "sup"  # image-based subtitles: no text
    for ext in (*SUBTITLE_EXT, ".zip", ".7z", ".rar"):
        if lower.endswith(ext):
            return ext[1:]
    return "other"


def guess_episode(name: str) -> int | None:
    if (m := _BRACKET_EP.search(name)) and 0 < int(m.group(1)) < 2000:
        return int(m.group(1))
    stem = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", name)  # drop [Group] and (1080p) tags
    stem = re.sub(r"(\.sup)?\.(srt|ass|ssa|vtt|zip|7z|rar|sup)$", "", stem, flags=re.I)
    stem = re.sub(r"\b(?:\d{3,4}p|x26[45]|h\.?26[45]|10bit|v\d)\b", " ", stem, flags=re.I)
    for pat in _EP_PATTERNS:
        if m := pat.search(stem):
            n = int(m.group(1))
            if 0 < n < 2000:
                return n
    return None


def describe(f: dict, episode: int | None = None) -> FileInfo:
    name = f["name"]
    fmt = file_format(name)
    stem = re.sub(r"\[[^\]]*\]", " ", name)
    multi = bool(_RANGE.search(re.sub(r"\([^)]*\)", " ", stem)))
    info = FileInfo(
        name=name,
        url=f["url"],
        size=int(f.get("size") or 0),
        last_modified=f.get("last_modified", ""),
        format=fmt,
        supported=fmt in {"srt", "ass", "ssa", "vtt", "zip"},
        episode=None if multi else guess_episode(name),
        multi_episode=multi,
        web_source=bool(WEB_TAGS.search(name)),
        dual_language=bool(DUAL_TAGS.search(name)),
    )
    info.score = (
        (10 if info.supported else -100)
        + (5 if not multi else -20)
        + (3 if info.web_source else 0)
        - (4 if BD_TAGS.search(name) else 0)
        - (15 if info.dual_language else 0)
        - (1 if SDH_TAGS.search(name) else 0)  # needs SDH stripping; plain subs are cleaner
        + (2 if fmt == "srt" else 1 if fmt == "ass" else 0)  # srt: no styling noise
        + (4 if episode is not None and info.episode == episode else 0)
    )
    return info


def rank(files: list[dict], episode: int | None = None) -> list[FileInfo]:
    out = sorted((describe(f, episode) for f in files), key=lambda i: (-i.score, i.name))
    if out and out[0].supported and not out[0].multi_episode and not out[0].dual_language:
        out[0].recommended = True
    return out


def extract_subtitle(name: str, data: bytes, episode: int | None) -> tuple[str, bytes]:
    """Return (file name, bytes) of the subtitle to import; unpacks zip archives."""
    fmt = file_format(name)
    if fmt in {"srt", "ass", "ssa", "vtt"}:
        return name, data
    if fmt != "zip":
        raise JimakuError(f"can't import .{fmt} files; pick an .srt/.ass file or a .zip", 422)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise JimakuError("broken zip archive", 422) from e
    members = [
        i
        for i in zf.infolist()
        if i.filename.lower().endswith(SUBTITLE_EXT)
        and not i.is_dir()
        and i.file_size < MAX_DOWNLOAD
    ]
    if episode is not None and len(members) > 1:
        members = [i for i in members if guess_episode(i.filename.rsplit("/", 1)[-1]) == episode]
    if len(members) != 1:
        found = "no subtitle files" if not members else f"{len(members)} candidate files"
        raise JimakuError(f"zip has {found} for this episode; pick a single-episode file", 422)
    return members[0].filename.rsplit("/", 1)[-1], zf.read(members[0])


class Jimaku:
    def __init__(self, api_key: str, transport: httpx.BaseTransport | None = None):
        self.api_key = api_key
        self.http = httpx.Client(
            base_url=BASE_URL,
            headers={"Authorization": api_key, "User-Agent": "sensei-jimaku-client"},
            timeout=20,
            follow_redirects=True,
            transport=transport,
        )

    def _get(self, path: str, **params) -> httpx.Response:
        if not self.api_key:
            raise JimakuError("Jimaku API key not set (SENSEI_JIMAKU_API_KEY in server/.env)", 503)
        try:
            r = self.http.get(path, params={k: v for k, v in params.items() if v is not None})
        except httpx.HTTPError as e:
            raise JimakuError(f"can't reach jimaku.cc: {e}") from e
        if r.status_code in (401, 403):
            raise JimakuError("jimaku.cc rejected the API key")
        if r.status_code == 404:
            raise JimakuError("not found on jimaku.cc", 404)
        if r.status_code == 429:
            raise JimakuError("jimaku.cc rate limit, try again in a minute", 429)
        if r.status_code >= 400:
            raise JimakuError(f"jimaku.cc error {r.status_code}")
        return r

    def search(self, query: str, anilist_id: int | None = None) -> list[dict]:
        if anilist_id is not None:
            return self._get("/entries/search", anilist_id=anilist_id, anime="true").json()
        return self._get("/entries/search", query=query, anime="true").json()

    def entry(self, entry_id: int) -> dict:
        return self._get(f"/entries/{entry_id}").json()

    def files(self, entry_id: int, episode: int | None = None) -> list[dict]:
        return self._get(f"/entries/{entry_id}/files", episode=episode).json()

    def download(self, entry_id: int, file_name: str) -> bytes:
        """Download a file *listed for this entry* (never an arbitrary URL)."""
        listed = {f["name"]: f for f in self.files(entry_id)}
        f = listed.get(file_name)
        if f is None:
            raise JimakuError("file not found in this Jimaku entry", 404)
        if int(f.get("size") or 0) > MAX_DOWNLOAD:
            raise JimakuError("file too large", 413)
        if not str(f["url"]).startswith("https://jimaku.cc/"):
            raise JimakuError("unexpected download host")
        try:
            with self.http.stream("GET", f["url"]) as r:
                if r.status_code >= 400:
                    raise JimakuError(f"download failed ({r.status_code})")
                data = bytearray()
                for chunk in r.iter_bytes():
                    data += chunk
                    if len(data) > MAX_DOWNLOAD:
                        raise JimakuError("file too large", 413)
        except httpx.HTTPError as e:
            raise JimakuError(f"download failed: {e}") from e
        return bytes(data)
