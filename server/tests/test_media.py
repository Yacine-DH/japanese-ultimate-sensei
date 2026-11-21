import subprocess

import pytest

from app.media import ffmpeg_available, sign

from .conftest import FIXTURES

pytestmark = pytest.mark.skipif(not ffmpeg_available(), reason="ffmpeg not installed")
TOKEN = "media-test-token-123456"


def ff(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


@pytest.fixture(scope="module")
def samples(tmp_path_factory):
    d = tmp_path_factory.mktemp("samples")
    ff("-f", "lavfi", "-i", "testsrc=size=1280x720", "-frames:v", "1", str(d / "shot.png"))
    ff(
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-c:a",
        "libopus",
        str(d / "line.webm"),
    )
    ff(
        "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=2",
        "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libvpx", "-b:v", "1M",
        "-c:a", "libopus", "-shortest", str(d / "clip.webm"),
    )  # fmt: skip
    return d


def post(c, path, kind, **extra):
    with open(path, "rb") as f:
        return c.post(
            "/media",
            data={"kind": kind, **extra},
            files={"file": (path.name, f, "application/octet-stream")},
            headers={"Authorization": f"Bearer {TOKEN}"},
        )


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height,channels",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout  # fmt: skip
    return out.strip()


def test_screenshot_audio_clip_are_compressed(make_client, samples, tmp_path):
    c = make_client(token=TOKEN)
    media_dir = c.app.state.settings.media_dir

    shot = post(c, samples / "shot.png", "screenshot")
    assert shot.status_code == 201, shot.text
    s = shot.json()
    assert (
        s["mime"] == "image/webp"
        and s["ready"]
        and s["url"] == f"/media/{s['id']}?sig={sign(TOKEN, s['id'])}"
    )
    assert s["bytes"] < (samples / "shot.png").stat().st_size

    audio = post(c, samples / "line.webm", "audio").json()
    assert audio["mime"] == "audio/ogg" and audio["ready"]

    clip = post(c, samples / "clip.webm", "clip").json()  # background task runs after response
    r = c.get(clip["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "video/webm"

    files = {p.suffix: p for p in media_dir.rglob("*") if p.is_file()}
    assert set(files) == {".webp", ".ogg", ".webm"}  # raw uploads removed
    assert probe(files[".webp"]) == "webp,640,360"
    assert probe(files[".ogg"]) == "opus,1"  # mono
    assert probe(files[".webm"]).startswith("vp9,640,360")

    health = c.get("/health").json()
    assert health["ffmpeg"] and health["media_bytes"] == sum(
        p.stat().st_size for p in files.values()
    )


def test_media_auth_and_errors(make_client, samples, tmp_path):
    c = make_client(token=TOKEN)
    m = post(c, samples / "shot.png", "screenshot").json()
    mid = m["id"]
    assert c.get(m["url"]).status_code == 200  # signed URL, no header (for <img>)
    assert c.get(f"/media/{mid}").status_code == 401
    assert c.get(f"/media/{mid}?sig=deadbeef").status_code == 401
    assert c.get(f"/media/{mid}", headers={"X-Sensei-Token": TOKEN}).status_code == 200
    assert c.get(f"/media/{mid + 1}?sig={sign(TOKEN, mid)}").status_code == 401  # sig is per id

    junk = tmp_path / "junk.png"
    junk.write_bytes(b"not an image")
    assert post(c, junk, "screenshot").status_code == 422
    assert post(c, samples / "shot.png", "screenshot", card_id="999").status_code == 404

    hdr = {"Authorization": f"Bearer {TOKEN}"}
    assert c.delete(f"/media/{mid}", headers=hdr).status_code == 204
    assert c.get(m["url"]).status_code == 404


def test_upload_then_attach_to_card(client, samples):
    from .test_cards import tabe_token

    _, line, tok = tabe_token(client)
    with open(samples / "shot.png", "rb") as f:
        shot = client.post(
            "/media", data={"kind": "screenshot"}, files={"file": ("s.png", f)}
        ).json()
    card = client.post(
        "/cards", json={"word_id": tok["word_id"], "line_id": line["id"], "media_ids": [shot["id"]]}
    ).json()
    with open(samples / "line.webm", "rb") as f:
        client.post(
            "/media",
            data={"kind": "audio", "card_id": str(card["id"])},
            files={"file": ("a.webm", f)},
        )
    media = client.get(f"/cards/{card['id']}").json()["media"]
    assert [m["kind"] for m in media] == ["screenshot", "audio"]
    assert client.get(media[1]["url"]).status_code == 200


def test_review_queue_media_urls_are_signed(make_client, samples):
    """#71: review/card payloads must carry signed URLs usable in <img>/<audio> tags."""

    c = make_client(token=TOKEN)
    hdr = {"Authorization": f"Bearer {TOKEN}"}
    with open(FIXTURES / "sample.ass", "rb") as f:
        ep = c.post(
            "/episodes", data={"anime_title": "A"}, files={"subtitle": ("s.ass", f)}, headers=hdr
        ).json()
    line = c.get(f"/episodes/{ep['id']}/lines", headers=hdr).json()[1]
    tok = next(t for t in line["tokens"] if t["is_content"])
    shot = post(c, samples / "shot.png", "screenshot").json()
    c.post(
        "/cards",
        json={"word_id": tok["word_id"], "line_id": line["id"], "media_ids": [shot["id"]]},
        headers=hdr,
    )
    media = c.get("/reviews/due", headers=hdr).json()["cards"][0]["media"]
    assert media[0]["url"] == shot["url"] and "sig=" in media[0]["url"]
    assert c.get(media[0]["url"]).status_code == 200  # no header, like an <img> tag
    assert media[0]["bytes"] > 0 and media[0]["ready"]
