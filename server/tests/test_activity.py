from datetime import date, timedelta

from sqlmodel import Session

from app import activity as act
from app.models import ActivityDay, UnderstandingSnapshot, WatchDay

from .test_api import upload


def test_streaks():
    d = date(2026, 11, 21)
    days = {d - timedelta(days=i) for i in (0, 1, 2, 5, 6, 7, 8)}
    assert act.streaks(days, d) == (3, 4)
    assert act.streaks(days - {d}, d) == (2, 4)  # today not active yet: streak still alive
    assert act.streaks(days - {d, d - timedelta(days=1)}, d) == (0, 4)
    assert act.streaks(set(), d) == (0, 0)


def test_watch_heartbeats_and_activity(client):
    ep = upload(client).json()
    for _ in range(3):
        r = client.post("/activity/watch", json={"episode_id": ep["id"], "seconds": 40})
    assert r.status_code == 200 and r.json()["seconds_today"] == 120
    assert (
        client.post("/activity/watch", json={"episode_id": ep["id"], "seconds": 0}).status_code
        == 422
    )
    assert (
        client.post("/activity/watch", json={"episode_id": 999, "seconds": 30}).status_code == 404
    )

    # words that become known count once (single + bulk), re-marking doesn't
    lines = client.get(f"/episodes/{ep['id']}/lines").json()
    wids = sorted({t["word_id"] for line in lines for t in line["tokens"] if t["is_content"]})
    client.post(f"/words/{wids[0]}/status", json={"status": "known"})
    client.post("/words/bulk-status", json={"word_ids": wids[:3], "status": "known"})
    client.post("/words/bulk-status", json={"word_ids": wids[3:5], "status": "ignored"})

    # older activity for streaks: yesterday + 3 days ago
    today = act.today()
    with Session(client.app.state.engine) as s:
        s.add(ActivityDay(user_id=1, day=today - timedelta(days=1), reviews=5))
        s.add(WatchDay(user_id=1, day=today - timedelta(days=3), episode_id=ep["id"], seconds=600))
        s.commit()

    a = client.get("/activity").json()
    by_day = {d["day"]: d for d in a["days"]}
    assert by_day[today.isoformat()] == {
        "day": today.isoformat(), "minutes": 2, "reviews": 0, "words_added": 0, "words_known": 3,
    }  # fmt: skip
    assert by_day[(today - timedelta(days=3)).isoformat()]["minutes"] == 10
    assert a["current_streak"] == 2 and a["longest_streak"] == 2 and a["active_days"] == 3
    assert a["totals"] == {"minutes": 12, "reviews": 5, "words_added": 0, "words_known": 3}

    narrow = client.get("/activity", params={"from": today.isoformat()}).json()
    assert len(narrow["days"]) == 1 and narrow["current_streak"] == 2  # streak sees all history
    assert (
        client.get("/activity", params={"from": "2026-12-01", "to": "2026-01-01"}).status_code
        == 422
    )


def test_anime_list_and_progress(client):
    ep1 = upload(client).json()
    ep2 = upload(client, name="sample.srt", episode_number="2").json()
    animes = client.get("/anime").json()
    assert len(animes) == 1 and animes[0]["episode_count"] == 2 and animes[0]["token_pct"] == 0.0
    aid = animes[0]["id"]

    # yesterday's point (as if imported then), today we learn a word
    with Session(client.app.state.engine) as s:
        s.add(UnderstandingSnapshot(user_id=1, anime_id=aid, day=act.today() - timedelta(days=1)))
        s.commit()
    lines = client.get(f"/episodes/{ep1['id']}/lines").json()
    tabe = next(t for line in lines for t in line["tokens"] if t["surface"] == "食べ")
    client.post(f"/words/{tabe['word_id']}/status", json={"status": "known"})
    client.post("/activity/watch", json={"episode_id": ep2["id"], "seconds": 90})

    p = client.get(f"/anime/{aid}/progress").json()
    assert [pt["token_pct"] > 0 for pt in p["series"]] == [False, True]  # trend goes up today
    assert p["anime"]["known_unique"] == 1
    assert [e["number"] for e in p["episodes"]] == [1.0, 2.0]
    assert p["episodes"][1]["minutes_watched"] == 2
    assert client.get("/anime/999/progress").status_code == 404


def test_delete_episode_with_watch_time_and_cards(client):
    """#72: deleting an episode with heartbeats and saved cards must not hit FK errors."""
    ep = upload(client).json()
    line = client.get(f"/episodes/{ep['id']}/lines").json()[1]
    tok = next(t for t in line["tokens"] if t["is_content"])
    card = client.post("/cards", json={"word_id": tok["word_id"], "line_id": line["id"]}).json()
    client.post("/activity/watch", json={"episode_id": ep["id"], "seconds": 60})
    assert client.delete(f"/episodes/{ep['id']}").status_code == 204
    kept = client.get(f"/cards/{card['id']}").json()
    assert kept["card"]["line_id"] is None and kept["card"]["sentence"] == line["text"]
