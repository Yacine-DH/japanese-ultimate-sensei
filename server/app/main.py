"""FastAPI app factory.

Run (from server/):  uv run uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
"""

import hmac
import json
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, delete, func, or_, select

from app import __version__
from app.config import Settings, check_auth_settings, get_settings
from app.db import get_session, make_engine
from app.dictionary import Dictionary, load_dictionary
from app.ingest import (
    episode_lines,
    ingest_lines,
    reprocess_episode,
    status_map,
    token_is_proper,
    understanding,
    word_counts,
)
from app.models import Anime, Episode, SubtitleLine, UserWord, Word, WordStatus
from app.nlp.tokenizer import line_romaji
from app.schemas import (
    BulkStatusIn,
    BulkStatusOut,
    EpisodeCreated,
    EpisodeOut,
    EpisodePatch,
    Health,
    LineOut,
    LookupResult,
    TokenOut,
    Understanding,
    WordListItem,
    WordOut,
    WordPage,
    WordStatusIn,
)
from app.subtitles import parse_bytes

MAX_SUBTITLE_BYTES = 5 * 1024 * 1024
EXTENSION_ORIGINS = (
    r"^(chrome-extension|moz-extension|extension)://.*$|^http://(localhost|127\.0\.0\.1)(:\d+)?$"
)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    check_auth_settings(settings)
    app = FastAPI(title="Japanese Ultimate Sensei", version=__version__)
    app.state.settings = settings
    app.state.engine = make_engine(settings.db_path)
    app.state.dictionary = load_dictionary(settings.dictionary_path)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=EXTENSION_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---- dependencies -------------------------------------------------------------------

    def require_token(request: Request) -> None:
        expected = settings.api_token.strip()
        if not expected:  # only reachable with SENSEI_ALLOW_NO_AUTH=true
            return
        header = request.headers.get("authorization", "")
        given = header.removeprefix("Bearer ").strip() or request.headers.get("x-sensei-token", "")
        if not hmac.compare_digest(given, expected):
            raise HTTPException(401, "invalid or missing API token")

    def dictionary_dep() -> Dictionary:
        d = app.state.dictionary
        if d is None:
            raise HTTPException(
                503, "dictionary not built — run: uv run python -m app.dictionary_setup"
            )
        return d

    uid = settings.default_user_id
    auth = [Depends(require_token)]

    # ---- helpers ------------------------------------------------------------------------

    def episode_out(session: Session, ep: Episode) -> dict:
        anime = session.get(Anime, ep.anime_id) if ep.anime_id else None
        count = session.exec(
            select(func.count()).select_from(SubtitleLine).where(SubtitleLine.episode_id == ep.id)
        ).one()
        return {
            **ep.model_dump(),
            "anime_title": anime.title if anime else None,
            "line_count": count,
        }

    def get_episode(session: Session, episode_id: int) -> Episode:
        ep = session.get(Episode, episode_id)
        if not ep:
            raise HTTPException(404, "episode not found")
        return ep

    # ---- routes -------------------------------------------------------------------------

    @app.get("/health", response_model=Health, tags=["meta"])
    def health():
        return Health(
            version=__version__,
            dictionary=app.state.dictionary is not None,
            auth=bool(settings.api_token),
        )

    @app.post(
        "/episodes",
        response_model=EpisodeCreated,
        status_code=201,
        dependencies=auth,
        tags=["episodes"],
    )
    async def create_episode(
        subtitle: UploadFile = File(description="Japanese .srt/.ass/.ssa/.vtt file"),
        anime_title: str = Form(),
        episode_number: float | None = Form(None),
        title: str | None = Form(None),
        session: Session = Depends(get_session),
    ):
        raw = await subtitle.read(MAX_SUBTITLE_BYTES + 1)
        if len(raw) > MAX_SUBTITLE_BYTES:
            raise HTTPException(413, "subtitle file too large")
        try:
            lines = parse_bytes(raw)
        except Exception as e:  # pysubs2 raises several types on bad input
            raise HTTPException(422, f"could not parse subtitle file: {e}") from e
        if not lines:
            raise HTTPException(422, "no Japanese dialogue lines found in subtitle file")

        anime = session.exec(select(Anime).where(Anime.title == anime_title.strip())).first()
        if not anime:
            anime = Anime(title=anime_title.strip())
            session.add(anime)
            session.flush()
        ep = Episode(
            anime_id=anime.id,
            number=episode_number,
            title=title,
            source="upload",
            source_filename=subtitle.filename,
        )
        session.add(ep)
        session.flush()
        ingest_lines(session, ep, lines, app.state.dictionary)
        session.commit()
        session.refresh(ep)
        return {**episode_out(session, ep), "understanding": understanding(session, uid, ep.id)}

    @app.get("/episodes", response_model=list[EpisodeOut], dependencies=auth, tags=["episodes"])
    def list_episodes(session: Session = Depends(get_session)):
        eps = session.exec(select(Episode).order_by(Episode.created_at.desc())).all()  # type: ignore[attr-defined]
        return [episode_out(session, e) for e in eps]

    @app.get(
        "/episodes/{episode_id}", response_model=EpisodeOut, dependencies=auth, tags=["episodes"]
    )
    def read_episode(episode_id: int, session: Session = Depends(get_session)):
        return episode_out(session, get_episode(session, episode_id))

    @app.patch(
        "/episodes/{episode_id}", response_model=EpisodeOut, dependencies=auth, tags=["episodes"]
    )
    def patch_episode(episode_id: int, body: EpisodePatch, session: Session = Depends(get_session)):
        ep = get_episode(session, episode_id)
        for k, v in body.model_dump(exclude_unset=True).items():
            setattr(ep, k, v)
        session.add(ep)
        session.commit()
        session.refresh(ep)
        return episode_out(session, ep)

    @app.delete("/episodes/{episode_id}", status_code=204, dependencies=auth, tags=["episodes"])
    def delete_episode(episode_id: int, session: Session = Depends(get_session)):
        ep = get_episode(session, episode_id)
        session.exec(delete(SubtitleLine).where(SubtitleLine.episode_id == episode_id))
        session.delete(ep)
        session.commit()

    @app.get(
        "/episodes/{episode_id}/lines",
        response_model=list[LineOut],
        dependencies=auth,
        tags=["episodes"],
    )
    def read_lines(episode_id: int, session: Session = Depends(get_session)):
        get_episode(session, episode_id)
        lines = episode_lines(session, episode_id)
        parsed = [json.loads(line.tokens_json) for line in lines]
        word_ids = {t["word_id"] for toks in parsed for t in toks if t.get("word_id")}
        statuses = status_map(session, uid, word_ids)
        common = (
            {
                w.id: w.common
                for w in session.exec(select(Word).where(Word.id.in_(list(word_ids)))).all()  # type: ignore[union-attr]
            }
            if word_ids
            else {}
        )
        out = []
        for line, toks in zip(lines, parsed, strict=True):
            tokens = [
                TokenOut(
                    **{
                        k: t[k]
                        for k in TokenOut.model_fields
                        if k in t and k not in ("status", "common", "is_proper_noun")
                    },
                    is_proper_noun=token_is_proper(t),
                    status=(
                        statuses.get(t["word_id"], WordStatus.new) if t.get("word_id") else None
                    ),
                    common=common.get(t.get("word_id"), False),
                )
                for t in toks
            ]
            out.append(
                LineOut(
                    id=line.id,
                    idx=line.idx,
                    start_ms=line.start_ms,
                    end_ms=line.end_ms,
                    text=line.text,
                    tokens=tokens,
                    romaji=line_romaji(toks),
                    translation_en=line.translation_en,
                    translation_de=line.translation_de,
                )
            )
        return out

    @app.post(
        "/episodes/{episode_id}/reprocess",
        response_model=EpisodeCreated,
        dependencies=auth,
        tags=["episodes"],
        summary="Re-tokenize stored lines (after tokenizer or dictionary updates)",
    )
    def reprocess(episode_id: int, session: Session = Depends(get_session)):
        ep = get_episode(session, episode_id)
        reprocess_episode(session, episode_id, app.state.dictionary)
        session.commit()
        return {**episode_out(session, ep), "understanding": understanding(session, uid, ep.id)}

    @app.get(
        "/episodes/{episode_id}/understanding",
        response_model=Understanding,
        dependencies=auth,
        tags=["episodes"],
    )
    def read_understanding(episode_id: int, session: Session = Depends(get_session)):
        get_episode(session, episode_id)
        return understanding(session, uid, episode_id)

    @app.get(
        "/dictionary/lookup", response_model=LookupResult, dependencies=auth, tags=["dictionary"]
    )
    def lookup(
        q: str, reading: str | None = None, limit: int = 5, d: Dictionary = Depends(dictionary_dep)
    ):
        return LookupResult(query=q, reading=reading, entries=d.lookup(q, reading, min(limit, 20)))

    def word_out(session: Session, w: Word) -> WordOut:
        st = status_map(session, uid, [w.id]).get(w.id, WordStatus.new)
        return WordOut(**w.model_dump(), status=st)

    def set_statuses(session: Session, word_ids: list[int], status: WordStatus) -> None:
        existing = {
            uw.word_id: uw
            for uw in session.exec(
                select(UserWord).where(UserWord.user_id == uid, UserWord.word_id.in_(word_ids))  # type: ignore[attr-defined]
            ).all()
        }
        now = datetime.now(UTC)
        for wid in word_ids:
            uw = existing.get(wid) or UserWord(user_id=uid, word_id=wid)
            uw.status = status
            uw.updated_at = now
            session.add(uw)

    @app.get("/words", response_model=WordPage, dependencies=auth, tags=["words"])
    def list_words(
        status: WordStatus | None = None,
        anime_id: int | None = None,
        episode_id: int | None = None,
        q: str | None = Query(None, description="Substring of lemma or reading"),
        limit: int = Query(50, ge=1, le=500),
        offset: int = Query(0, ge=0),
        session: Session = Depends(get_session),
    ):
        """Vocabulary table. With `anime_id`/`episode_id`: only words spoken there, most
        frequent first, with `occurrences`. Otherwise newest first."""
        stmt = select(Word, UserWord.status).join(
            UserWord,
            (UserWord.word_id == Word.id) & (UserWord.user_id == uid),  # type: ignore[arg-type]
            isouter=True,
        )
        counts: dict[int, int] | None = None
        if anime_id is not None or episode_id is not None:
            ep_stmt = select(Episode.id)
            if anime_id is not None:
                ep_stmt = ep_stmt.where(Episode.anime_id == anime_id)
            if episode_id is not None:
                ep_stmt = ep_stmt.where(Episode.id == episode_id)
            counts = word_counts(session, [e for e in session.exec(ep_stmt).all() if e])
            stmt = stmt.where(Word.id.in_(list(counts)))  # type: ignore[union-attr]
        if status == WordStatus.new:
            stmt = stmt.where(or_(UserWord.status.is_(None), UserWord.status == WordStatus.new))  # type: ignore[union-attr]
        elif status is not None:
            stmt = stmt.where(UserWord.status == status)
        if q:
            stmt = stmt.where(or_(Word.lemma.contains(q), Word.reading.contains(q)))  # type: ignore[attr-defined]
        rows = session.exec(stmt).all()
        if counts is not None:
            rows = sorted(rows, key=lambda r: (-counts.get(r[0].id, 0), r[0].id))
        else:
            rows = sorted(rows, key=lambda r: -(r[0].id or 0))
        page = rows[offset : offset + limit]
        return WordPage(
            total=len(rows),
            items=[
                WordListItem(
                    **w.model_dump(),
                    status=st or WordStatus.new,
                    occurrences=counts.get(w.id, 0) if counts is not None else None,
                )
                for w, st in page
            ],
        )

    @app.post("/words/bulk-status", response_model=BulkStatusOut, dependencies=auth, tags=["words"])
    def bulk_status(body: BulkStatusIn, session: Session = Depends(get_session)):
        ids = list(dict.fromkeys(body.word_ids))
        found = set(session.exec(select(Word.id).where(Word.id.in_(ids))).all())  # type: ignore[union-attr]
        set_statuses(session, [i for i in ids if i in found], body.status)
        session.commit()
        return BulkStatusOut(updated=len(found), missing=[i for i in ids if i not in found])

    @app.get("/words/{word_id}", response_model=WordOut, dependencies=auth, tags=["words"])
    def read_word(word_id: int, session: Session = Depends(get_session)):
        w = session.get(Word, word_id)
        if not w:
            raise HTTPException(404, "word not found")
        return word_out(session, w)

    @app.post("/words/{word_id}/status", response_model=WordOut, dependencies=auth, tags=["words"])
    def set_word_status(word_id: int, body: WordStatusIn, session: Session = Depends(get_session)):
        w = session.get(Word, word_id)
        if not w:
            raise HTTPException(404, "word not found")
        set_statuses(session, [word_id], body.status)
        session.commit()
        return word_out(session, w)

    return app
