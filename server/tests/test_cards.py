from datetime import UTC, datetime, timedelta

from sqlmodel import Session, select

from app import srs
from app.models import ActivityDay, Media, MediaKind

from .test_api import upload


def tabe_token(client):
    ep = upload(client).json()
    lines = client.get(f"/episodes/{ep['id']}/lines").json()
    line = lines[1]
    tok = next(t for t in line["tokens"] if t["surface"] == "食べ")
    return ep, line, tok


def add_media(client, kind=MediaKind.screenshot) -> int:
    with Session(client.app.state.engine) as s:
        m = Media(kind=kind, path="x.webp", mime="image/webp")
        s.add(m)
        s.commit()
        return m.id


def test_create_card_review_flow(client):
    ep, line, tok = tabe_token(client)
    shot = add_media(client)
    r = client.post(
        "/cards", json={"word_id": tok["word_id"], "line_id": line["id"], "media_ids": [shot]}
    )
    assert r.status_code == 201, r.text
    card = r.json()
    assert card["created"] and card["sentence"] == line["text"] and card["state"] == "learning"
    assert client.get(f"/words/{tok['word_id']}").json()["status"] == "learning"

    # saving the same word again returns the existing card
    again = client.post("/cards", json={"word_id": tok["word_id"]})
    assert again.status_code == 200 and again.json()["id"] == card["id"]
    assert not again.json()["created"]

    q = client.get("/reviews/due").json()
    assert q["due_total"] == 1
    rc = q["cards"][0]
    assert rc["word"]["lemma"] == "食べる"
    assert rc["line"]["text"] == line["text"] and rc["line"]["romaji"]
    assert rc["episode"] == {"id": ep["id"], "anime_title": "Test Anime", "number": 1.0}
    assert rc["entry"]["senses"]["ger"]
    assert rc["media"] == [
        {"id": shot, "kind": "screenshot", "mime": "image/webp", "url": f"/media/{shot}"}
    ]
    assert set(rc["next_due"]) == {"1", "2", "3", "4"}

    r = client.post("/reviews", json={"card_id": card["id"], "rating": 3, "duration_ms": 4200})
    assert r.status_code == 200
    out = r.json()
    assert out["card"]["reps"] == 1 and out["word_status"] == "learning" and not out["graduated"]
    assert client.get("/reviews/due").json()["due_total"] == 0  # next step is minutes away

    with Session(client.app.state.engine) as s:
        day = s.exec(select(ActivityDay)).one()
        assert (day.reviews, day.words_added) == (1, 1)


def test_graduates_to_known_and_lapses_back(client, monkeypatch):
    _, line, tok = tabe_token(client)
    card = client.post("/cards", json={"word_id": tok["word_id"], "line_id": line["id"]}).json()

    clock = [datetime.now(UTC)]
    monkeypatch.setattr(srs, "utcnow", lambda: clock[0])
    graduated = None
    for _ in range(8):
        out = client.post("/reviews", json={"card_id": card["id"], "rating": 3}).json()
        if out["graduated"]:
            graduated = out
            break
        clock[0] = datetime.fromisoformat(out["card"]["due"]) + timedelta(minutes=1)
    assert graduated and graduated["word_status"] == "known"
    assert graduated["card"]["stability"] >= srs.GRADUATE_STABILITY_DAYS
    assert client.get(f"/words/{tok['word_id']}").json()["status"] == "known"

    clock[0] = datetime.fromisoformat(graduated["card"]["due"])
    lapse = client.post("/reviews", json={"card_id": card["id"], "rating": 1}).json()
    assert lapse["card"]["state"] == "relearning" and lapse["word_status"] == "learning"


def test_card_validation_and_delete(client):
    _, line, tok = tabe_token(client)
    assert client.post("/cards", json={"word_id": 99999}).status_code == 404
    assert (
        client.post("/cards", json={"word_id": tok["word_id"], "line_id": 99999}).status_code == 404
    )
    assert (
        client.post("/cards", json={"word_id": tok["word_id"], "media_ids": [424242]}).status_code
        == 422
    )
    assert client.post("/reviews", json={"card_id": 1, "rating": 5}).status_code == 422
    assert client.post("/reviews", json={"card_id": 99999, "rating": 3}).status_code == 404

    # known words keep their status when saved
    client.post(f"/words/{tok['word_id']}/status", json={"status": "known"})
    card = client.post("/cards", json={"word_id": tok["word_id"]}).json()
    assert client.get(f"/words/{tok['word_id']}").json()["status"] == "known"
    assert client.get(f"/cards/{card['id']}").json()["line"] is None

    client.post("/reviews", json={"card_id": card["id"], "rating": 4})
    assert client.delete(f"/cards/{card['id']}").status_code == 204
    assert client.get(f"/cards/{card['id']}").status_code == 404
