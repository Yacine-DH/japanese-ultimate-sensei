"""Activity heatmap data (watch time, reviews, words) and per-anime understanding trend."""

from datetime import date, datetime, timedelta

from sqlmodel import Session, func, select

from app.ingest import understanding_of
from app.models import ActivityDay, Episode, UnderstandingSnapshot, WatchDay


def today() -> date:
    """The owner's day (server-local time), same as srs.bump_activity."""
    return datetime.now().astimezone().date()


def add_watch(session: Session, user_id: int, episode_id: int, seconds: int) -> int:
    """Record a heartbeat; returns seconds watched today across all episodes."""
    day = today()
    row = session.get(WatchDay, (user_id, day, episode_id)) or WatchDay(
        user_id=user_id, day=day, episode_id=episode_id
    )
    row.seconds += seconds
    session.add(row)
    session.flush()
    return session.exec(
        select(func.coalesce(func.sum(WatchDay.seconds), 0)).where(
            WatchDay.user_id == user_id, WatchDay.day == day
        )
    ).one()


def is_active(d: dict) -> bool:
    return d["minutes"] > 0 or d["reviews"] > 0 or d["words_added"] > 0 or d["words_known"] > 0


def days(session: Session, user_id: int, start: date, end: date) -> list[dict]:
    """Sparse per-day rows (only days with activity), oldest first."""
    out: dict[date, dict] = {}

    def row(d: date) -> dict:
        return out.setdefault(
            d, {"day": d, "minutes": 0, "reviews": 0, "words_added": 0, "words_known": 0}
        )

    for a in session.exec(
        select(ActivityDay).where(
            ActivityDay.user_id == user_id, ActivityDay.day >= start, ActivityDay.day <= end
        )
    ).all():
        r = row(a.day)
        r["reviews"], r["words_added"], r["words_known"] = a.reviews, a.words_added, a.words_known
    secs = session.exec(
        select(WatchDay.day, func.sum(WatchDay.seconds))
        .where(WatchDay.user_id == user_id, WatchDay.day >= start, WatchDay.day <= end)
        .group_by(WatchDay.day)
    ).all()
    for d, s in secs:
        row(d)["minutes"] = round(s / 60)
    return [r for _, r in sorted(out.items()) if is_active(r)]


def streaks(active: set[date], until: date) -> tuple[int, int]:
    """(current, longest). The current streak survives until the end of today: if today has
    no activity yet, it counts back from yesterday."""
    longest = run = 0
    prev = None
    for d in sorted(active):
        run = run + 1 if prev is not None and d - prev == timedelta(days=1) else 1
        longest = max(longest, run)
        prev = d
    current = 0
    d = until if until in active else until - timedelta(days=1)
    while d in active:
        current += 1
        d -= timedelta(days=1)
    return current, longest


def activity(session: Session, user_id: int, start: date, end: date) -> dict:
    rows = days(session, user_id, start, end)
    # streaks look at all history so a range starting mid-streak still reports it right
    all_active = {r["day"] for r in days(session, user_id, date(2000, 1, 1), today())}
    current, longest = streaks(all_active, today())
    totals = {
        k: sum(r[k] for r in rows) for k in ("minutes", "reviews", "words_added", "words_known")
    }
    return {
        "from_day": start,
        "to_day": end,
        "days": rows,
        "active_days": len(rows),
        "current_streak": current,
        "longest_streak": longest,
        "totals": totals,
    }


def anime_episode_ids(session: Session, anime_id: int) -> list[int]:
    return [
        e for e in session.exec(select(Episode.id).where(Episode.anime_id == anime_id)).all() if e
    ]


def snapshot(session: Session, user_id: int, anime_id: int) -> dict:
    """Compute the anime's understanding now and store it as today's point."""
    stats = understanding_of(session, user_id, anime_episode_ids(session, anime_id))
    day = today()
    snap = session.get(UnderstandingSnapshot, (user_id, anime_id, day)) or UnderstandingSnapshot(
        user_id=user_id, anime_id=anime_id, day=day
    )
    snap.token_pct, snap.unique_pct = stats["token_pct"], stats["unique_pct"]
    snap.unique_words, snap.known_unique = stats["unique_words"], stats["known_unique"]
    session.add(snap)
    return stats


def snapshot_if_missing(session: Session, user_id: int, anime_id: int) -> None:
    if session.get(UnderstandingSnapshot, (user_id, anime_id, today())) is None:
        snapshot(session, user_id, anime_id)


def series(session: Session, user_id: int, anime_id: int) -> list[UnderstandingSnapshot]:
    return list(
        session.exec(
            select(UnderstandingSnapshot)
            .where(
                UnderstandingSnapshot.user_id == user_id, UnderstandingSnapshot.anime_id == anime_id
            )
            .order_by(UnderstandingSnapshot.day)  # type: ignore[arg-type]
        ).all()
    )


def watch_seconds_by_episode(
    session: Session, user_id: int, episode_ids: list[int]
) -> dict[int, int]:
    if not episode_ids:
        return {}
    rows = session.exec(
        select(WatchDay.episode_id, func.sum(WatchDay.seconds))
        .where(WatchDay.user_id == user_id, WatchDay.episode_id.in_(episode_ids))  # type: ignore[attr-defined]
        .group_by(WatchDay.episode_id)
    ).all()
    return dict(rows)
