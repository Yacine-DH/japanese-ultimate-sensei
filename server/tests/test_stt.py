import shutil
import subprocess

import httpx
import pytest

from app.stt import STT, SttJobs

SRT = """1
00:00:01,000 --> 00:00:02,500
お腹が空いた

2
00:00:03,000 --> 00:00:04,000
フリーレン様、行きましょう
""".encode()
requests: list[httpx.Request] = []

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")


def fake_whisper(request: httpx.Request) -> httpx.Response:
    requests.append(request)
    if request.url.path == "/":
        return httpx.Response(200, text="whisper.cpp server")
    assert request.url.path == "/v1/audio/transcriptions"
    body = request.read()
    assert b'name="response_format"' in body and b"srt" in body and b'name="language"' in body
    assert b"RIFF" in body  # 16 kHz WAV, not the uploaded container
    return httpx.Response(200, content=SRT)


@pytest.fixture
def stt_client(client):
    app = client.app
    app.state.stt = STT("http://precision:8080/v1", transport=httpx.MockTransport(fake_whisper))
    app.state.stt_jobs = SttJobs(app.state.stt, app.state.stt_jobs.import_fn, synchronous=True)
    requests.clear()
    return client


@pytest.fixture
def episode_file(tmp_path):
    path = tmp_path / "Frieren - 02.mkv"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
         "-c:a", "libopus", str(path)],
        check=True,
    )  # fmt: skip
    return path


def test_status(stt_client, client):
    assert stt_client.get("/stt/status").json() == {
        "configured": True, "reachable": True, "base_url": "http://precision:8080/v1",
        "model": None, "detail": "ok",
    }  # fmt: skip


def test_transcribe_imports_an_episode(stt_client, episode_file):
    with episode_file.open("rb") as f:
        r = stt_client.post(
            "/stt/jobs",
            files={"file": (episode_file.name, f, "video/x-matroska")},
            data={"anime_title": "Frieren", "episode_number": "2"},
        )
    assert r.status_code == 202, r.text
    job = r.json()
    assert job["status"] == "done", job
    assert job["duration_ms"] == pytest.approx(5000, abs=100)
    ep = stt_client.get(f"/episodes/{job['episode_id']}").json()
    assert ep["source"] == "stt" and ep["number"] == 2.0 and ep["anime_title"] == "Frieren"
    lines = stt_client.get(f"/episodes/{job['episode_id']}/lines").json()
    assert [x["text"] for x in lines] == ["お腹が空いた", "フリーレン様、行きましょう"]
    assert lines[0]["start_ms"] == 1000
    assert stt_client.get(f"/stt/jobs/{job['id']}").json()["status"] == "done"
    assert [j["id"] for j in stt_client.get("/stt/jobs").json()] == [job["id"]]
    assert not list((stt_client.app.state.settings.data_dir / "stt-uploads").iterdir())


def test_errors(stt_client, client, tmp_path):
    bad = tmp_path / "notes.txt"
    bad.write_text("not audio")
    with bad.open("rb") as f:
        job = stt_client.post(
            "/stt/jobs", files={"file": ("notes.txt", f)}, data={"anime_title": "X"}
        ).json()
    assert job["status"] == "error" and "can't read audio" in job["error"]
    r = stt_client.post("/stt/jobs", files={"file": ("e.mkv", b"")}, data={"anime_title": "X"})
    assert r.status_code == 422
    assert stt_client.get("/stt/jobs/999").status_code == 404

    stt_client.app.state.stt = STT("")
    r = stt_client.post("/stt/jobs", files={"file": ("e.mkv", b"x")}, data={"anime_title": "X"})
    assert r.status_code == 503
    assert not stt_client.get("/stt/status").json()["configured"]
