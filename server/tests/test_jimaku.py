import io
import zipfile

import httpx
import pytest

from app.jimaku import Jimaku, guess_episode, rank

from .conftest import FIXTURES

SRT = (FIXTURES / "sample.srt").read_bytes()
ENTRY = {
    "id": 729,
    "name": "Sousou no Frieren",
    "english_name": "Frieren: Beyond Journey's End",
    "japanese_name": "葬送のフリーレン",
    "anilist_id": 154587,
    "flags": {"anime": True, "movie": False},
}


def zip_of(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


FILES = {
    "[NanakoRaws] Sousou no Frieren - 01-04 (1080p).srt": SRT,
    "葬送のフリーレン.S01E01.冒険の終わり.WEBRip.Netflix.ja[cc].srt": SRT,
    "[Moozzi2] Sousou no Frieren - 01 (BD 1920x1080 x265-10Bit FLACx2).ass": SRT,
    "[Beatrice-Raws] Sousou no Frieren 01 [BDRip 1920x1080 HEVC TrueHD].sup.7z": b"7z",
    "Frieren 01-03.zip": zip_of(
        {"a/Frieren - 01.srt": SRT, "a/Frieren - 02.srt": SRT, "x.txt": b""}
    ),
}
calls: list[httpx.Request] = []


def fake_jimaku(request: httpx.Request) -> httpx.Response:
    calls.append(request)
    assert request.headers["authorization"] == "test-key"
    path = request.url.path
    if path == "/api/entries/search":
        return httpx.Response(200, json=[ENTRY] if "frieren" in str(request.url).lower() else [])
    if path == "/api/entries/729":
        return httpx.Response(200, json=ENTRY)
    if path == "/api/entries/729/files":
        return httpx.Response(
            200,
            json=[
                {
                    "name": n,
                    "url": f"https://jimaku.cc/entry/729/download/{i}",
                    "size": len(d),
                    "last_modified": "2024-01-01T00:00:00Z",
                }
                for i, (n, d) in enumerate(FILES.items())
            ],
        )
    if path.startswith("/entry/729/download/"):
        return httpx.Response(200, content=list(FILES.values())[int(path.rsplit("/", 1)[1])])
    if path.startswith("/api/entries/1/") or path == "/api/entries/1":
        return httpx.Response(401)
    return httpx.Response(404)


@pytest.fixture
def jclient(client):
    client.app.state.jimaku = Jimaku("test-key", transport=httpx.MockTransport(fake_jimaku))
    return client


def test_guess_episode():
    cases = {
        "[SubsPlease] Sousou no Frieren - 07 (1080p) [24356E19]_ja.srt": 7,
        "葬送のフリーレン.S01E12.WEBRip.Netflix.ja[cc].srt": 12,
        "[Nekomoe kissaten] Sousou no Frieren [07][Web].JPSC.ass": 7,
        "[Beatrice-Raws] Sousou no Frieren 09 [BDRip 1920x1080 HEVC].sup.7z": 9,
        "鬼滅の刃 第3話.srt": 3,
        "Show - 12v2 [1080p].ass": 12,
        "Show 2 - 03 (1080p).srt": 3,
        "Sousou no Frieren - 特別編 (NTV 1920x1080 x264 AAC).srt": None,
    }
    assert {n: guess_episode(n) for n in cases} == cases


def test_rank_prefers_single_episode_web_text_subs():
    files = [{"name": n, "url": "u", "size": 1} for n in FILES]
    ranked = rank(files, episode=1)
    assert ranked[0].name.startswith("葬送のフリーレン.S01E01") and ranked[0].recommended
    assert sum(f.recommended for f in ranked) == 1
    by_name = {f.name: f for f in ranked}
    assert by_name["[NanakoRaws] Sousou no Frieren - 01-04 (1080p).srt"].multi_episode
    sup = by_name["[Beatrice-Raws] Sousou no Frieren 01 [BDRip 1920x1080 HEVC TrueHD].sup.7z"]
    assert sup.format == "sup" and not sup.supported and ranked[-1] is sup


def test_search_files_and_import(jclient):
    r = jclient.get("/subs/search", params={"q": "frieren"})
    assert r.status_code == 200 and r.json()[0] == {
        "id": 729, "name": "Sousou no Frieren", "english_name": "Frieren: Beyond Journey's End",
        "japanese_name": "葬送のフリーレン", "anilist_id": 154587, "movie": False,
    }  # fmt: skip
    assert jclient.get("/subs/search", params={"q": "nothing"}).json() == []
    assert jclient.get("/subs/search").status_code == 422

    files = jclient.get("/subs/729/files", params={"episode": 1}).json()
    best = files[0]
    assert best["recommended"] and best["episode"] == 1 and best["web_source"]

    r = jclient.post("/episodes/from-jimaku", json={"entry_id": 729, "file_name": best["name"]})
    assert r.status_code == 201, r.text
    ep = r.json()
    assert ep["source"] == "jimaku" and ep["number"] == 1.0
    assert ep["anime_title"] == "Frieren: Beyond Journey's End" and ep["line_count"] > 0

    # zip: picks the requested episode's file; same anime (matched by AniList id)
    r = jclient.post(
        "/episodes/from-jimaku",
        json={
            "entry_id": 729,
            "file_name": "Frieren 01-03.zip",
            "episode_number": 2,
            "anime_title": "Other",
        },
    )
    assert r.status_code == 201, r.text
    assert (
        r.json()["source_filename"] == "Frieren - 02.srt" and r.json()["anime_id"] == ep["anime_id"]
    )


def test_import_errors(jclient):
    def imp(**body):
        return jclient.post("/episodes/from-jimaku", json={"entry_id": 729, **body})

    assert (
        imp(
            file_name="[Beatrice-Raws] Sousou no Frieren 01 [BDRip 1920x1080 HEVC TrueHD].sup.7z"
        ).status_code
        == 422
    )
    assert imp(file_name="Frieren 01-03.zip").status_code == 422  # which episode? ambiguous
    assert imp(file_name="Frieren 01-03.zip", episode_number=9).status_code == 422
    calls.clear()
    assert imp(file_name="https://evil.example/x.srt").status_code == 404  # only listed files
    assert all(c.url.host == "jimaku.cc" for c in calls)
    assert jclient.get("/subs/1/files").status_code == 502  # key rejected → bad gateway


def test_missing_key_is_503(client):
    assert client.get("/subs/search", params={"q": "x"}).status_code == 503


FRIEREN_02 = [
    "Sousou no Frieren - 02 「別に魔法じゃなくたって…」 (AT-X 1280x720 x264 AAC).srt",
    "葬送のフリーレン.S01E02.別に魔法じゃなくたって….WEBRip.Amazon.ja-jp[sdh].srt",
    "葬送のフリーレン.S01E02.別に魔法じゃなくたって….WEBRip.Netflix.ja[cc].srt",
    "[Nekomoe kissaten] Sousou no Frieren [02][Web].JPSC.ass",
    "[SubsPlease] Sousou no Frieren - 02 (1080p) [E5A85899]_ja.srt",
    "[erai-raws-timed]-sousou-no-frieren-S1E02.srt",
    "[Moozzi2] Sousou no Frieren - 02 (BD 1920x1080 x265-10Bit Flac).ass",
    "[SubsPlease] Sousou no Frieren - 02 (1080p) [E5A85899]_ja-en.ass",
    "[NanakoRaws] Sousou no Frieren - 01-04 (1080p).srt",
    "[KitaujiSub] Sousou no Frieren - 01-04 TVSP [CHS, JPN].ass",
    "[Beatrice-Raws] Sousou no Frieren 02 [BDRip 1920x1080 HEVC TrueHD].sup.7z",
]


def test_rank_prefers_web_rips_real_list():
    """Real Jimaku list (#91): web rips beat the TV rip, BD and dual-language files sink."""
    ranked = rank([{"name": n, "url": "https://jimaku.cc/x"} for n in FRIEREN_02], 2)
    by_name = {i.name: i for i in ranked}
    assert ranked[0].recommended and ranked[0].name.startswith("[SubsPlease]")
    assert ranked[0].name.endswith("_ja.srt")
    at_x, bd = FRIEREN_02[0], FRIEREN_02[6]
    assert not by_name[at_x].web_source
    web = [i for i in ranked if i.web_source and not i.dual_language and i.supported]
    assert all(by_name[at_x].score < i.score for i in web)
    assert by_name[bd].score < by_name[at_x].score
    for dual in (FRIEREN_02[3], FRIEREN_02[7], FRIEREN_02[9]):
        assert by_name[dual].dual_language and by_name[dual].score < by_name[bd].score
    assert not by_name[FRIEREN_02[1]].dual_language  # ja-jp is just Japanese


def test_tags_with_underscores_and_jp_en():
    """Review of #95: `_` is a word character, so tags need non-alphanumeric boundaries."""
    ranked = rank(
        [
            {"name": n, "url": "https://jimaku.cc/x"}
            for n in ("Show_02_BDRip.srt", "Show_02_WebRip.ass")
        ],
        2,
    )
    assert ranked[0].name == "Show_02_WebRip.ass" and ranked[0].web_source
    names = ("[SubsPlease] Show - 02_jp-en.ass", "Show_02_en-jp.srt", "Show_02_jpn-en.srt")
    for n in names:
        assert rank([{"name": n, "url": "https://jimaku.cc/x"}], 2)[0].dual_language, n
    assert not rank([{"name": "Show [BD123456].srt", "url": "https://jimaku.cc/x"}])[0].score < 0


def test_auto_import(jclient):
    calls.clear()
    r = jclient.post("/episodes/auto", json={"query": "Frieren", "episode_number": 1})
    assert r.status_code == 200, r.text
    out = r.json()
    assert not out["existing"] and out["entry"]["id"] == 729
    assert out["file_name"].startswith("葬送のフリーレン.S01E01")
    ep = out["episode"]
    assert ep["number"] == 1.0 and ep["line_count"] > 0 and ep["source"] == "jimaku"

    # the same episode again: no second import, no download
    calls.clear()
    again = jclient.post("/episodes/auto", json={"query": "frieren", "episode_number": 1}).json()
    assert again["existing"] and again["episode"]["id"] == ep["id"]
    assert not any("/download/" in c.url.path for c in calls)

    # next episode by anime_id (remembered entry): no search, same anime
    calls.clear()
    r = jclient.post("/episodes/auto", json={"anime_id": ep["anime_id"], "episode_number": 2})
    assert r.status_code == 200, r.text
    ep2 = r.json()["episode"]
    assert ep2["anime_id"] == ep["anime_id"] and ep2["number"] == 2.0
    assert not any(c.url.path == "/api/entries/search" for c in calls)
    assert len(jclient.get("/anime").json()) == 1


def test_auto_import_errors(jclient):
    assert jclient.post("/episodes/auto", json={"episode_number": 1}).status_code == 422
    r = jclient.post("/episodes/auto", json={"query": "nothing", "episode_number": 1})
    assert r.status_code == 404 and "nothing" in r.json()["detail"]
    r = jclient.post("/episodes/auto", json={"anime_id": 999, "episode_number": 1})
    assert r.status_code == 404
