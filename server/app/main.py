"""FastAPI app factory.

Run (from server/):  uv run uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
"""

import hmac
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlmodel import Session, delete, func, or_, select

from app import __version__, srs
from app import media as media_lib
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
from app.models import (
    Anime,
    Card,
    Episode,
    Media,
    MediaKind,
    ReviewLog,
    SubtitleLine,
    UserWord,
    Word,
    WordStatus,
)
from app.nlp.tokenizer import line_romaji
from app.schemas import (
    BulkStatusIn,
    BulkStatusOut,
    CardCreate,
    CardCreated,
    CardOut,
    EpisodeCreated,
    EpisodeOut,
    EpisodePatch,
    EpisodeRef,
    Health,
    LineOut,
    LookupResult,
    MediaOut,
    ReviewCard,
    ReviewIn,
    ReviewOut,
    ReviewQueue,
    TokenOut,
    Understanding,
    WordListItem,
    WordOut,
    WordPage,
    WordStatusIn,
)
from app.subtitles import parse_bytes
from app.webapp import mount_web

log = logging.getLogger("sensei")
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

    app.state.web = mount_web(app, settings.web_dist)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=EXTENSION_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---- dependencies -------------------------------------------------------------------

    def token_ok(request: Request) -> bool:
        expected = settings.api_token.strip()
        if not expected:  # only reachable with SENSEI_ALLOW_NO_AUTH=true
            return True
        header = request.headers.get("authorization", "")
        given = header.removeprefix("Bearer ").strip() or request.headers.get("x-sensei-token", "")
        return hmac.compare_digest(given, expected)

    def require_token(request: Request) -> None:
        if not token_ok(request):
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

    def build_lines(session: Session, lines: list[SubtitleLine]) -> list[LineOut]:
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

    def get_episode(session: Session, episode_id: int) -> Episode:
        ep = session.get(Episode, episode_id)
        if not ep:
            raise HTTPException(404, "episode not found")
        return ep

    # ---- routes -------------------------------------------------------------------------

    @app.get("/health", response_model=Health, tags=["meta"])
    def health():
        with Session(app.state.engine) as session:
            media_bytes = session.exec(select(func.coalesce(func.sum(Media.bytes), 0))).one()
        return Health(
            version=__version__,
            dictionary=app.state.dictionary is not None,
            auth=bool(settings.api_token.strip()),
            ffmpeg=media_lib.ffmpeg_available(),
            media_bytes=media_bytes,
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
        return build_lines(session, episode_lines(session, episode_id))

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

    # ---- cards + reviews (S-3) ------------------------------------------------------------

    def get_card(session: Session, card_id: int) -> Card:
        card = session.get(Card, card_id)
        if not card or card.user_id != uid:
            raise HTTPException(404, "card not found")
        return card

    def card_out(session: Session, card: Card) -> CardOut:
        return CardOut(**srs.card_info(session, card))

    def review_card(session: Session, card: Card) -> ReviewCard:
        word = session.get(Word, card.word_id)
        line = session.get(SubtitleLine, card.line_id) if card.line_id else None
        ep = session.get(Episode, line.episode_id) if line else None
        anime = session.get(Anime, ep.anime_id) if ep and ep.anime_id else None
        d = app.state.dictionary
        entry = d.entry(word.jmdict_id) if d is not None and word.jmdict_id else None
        media = session.exec(select(Media).where(Media.card_id == card.id)).all()
        return ReviewCard(
            card=card_out(session, card),
            word=word_out(session, word),
            line=build_lines(session, [line])[0] if line else None,
            episode=EpisodeRef(
                id=ep.id, anime_title=anime.title if anime else None, number=ep.number
            )
            if ep
            else None,
            entry=entry,
            media=[
                MediaOut(id=m.id, kind=m.kind, mime=m.mime, url=f"/media/{m.id}") for m in media
            ],
            next_due=srs.preview(card),
        )

    @app.post(
        "/cards",
        response_model=CardCreated,
        status_code=201,
        dependencies=auth,
        tags=["cards"],
        responses={200: {"description": "The word already had a card; it is returned"}},
    )
    def create_card(body: CardCreate, response: Response, session: Session = Depends(get_session)):
        """Save a word for review. Marks it `learning`. One card per word: saving again
        returns the existing card (200) and attaches any new media to it."""
        if not session.get(Word, body.word_id):
            raise HTTPException(404, "word not found")
        line = session.get(SubtitleLine, body.line_id) if body.line_id else None
        if body.line_id and not line:
            raise HTTPException(404, "line not found")
        media = [session.get(Media, mid) for mid in dict.fromkeys(body.media_ids)]
        if missing := [
            mid for mid, m in zip(dict.fromkeys(body.media_ids), media, strict=True) if not m
        ]:
            raise HTTPException(422, f"unknown media ids: {missing}")

        card = session.exec(
            select(Card).where(Card.user_id == uid, Card.word_id == body.word_id)
        ).first()
        created = card is None
        if card is None:
            card = Card(
                user_id=uid,
                word_id=body.word_id,
                line_id=line.id if line else None,
                sentence=body.sentence or (line.text if line else ""),
            )
            srs.store_fsrs(card, srs.fsrs_of(card))
            session.add(card)
            session.flush()
            if srs.word_status(session, uid, body.word_id) not in (
                WordStatus.known,
                WordStatus.ignored,
            ):
                srs.set_word_status(session, uid, body.word_id, WordStatus.learning)
            srs.bump_activity(session, uid, words_added=1)
        for m in media:
            m.card_id = card.id
            session.add(m)
        session.commit()
        session.refresh(card)
        if not created:
            response.status_code = 200
        return CardCreated(**card_out(session, card).model_dump(), created=created)

    @app.get("/cards/{card_id}", response_model=ReviewCard, dependencies=auth, tags=["cards"])
    def read_card(card_id: int, session: Session = Depends(get_session)):
        return review_card(session, get_card(session, card_id))

    @app.delete("/cards/{card_id}", status_code=204, dependencies=auth, tags=["cards"])
    def delete_card(card_id: int, session: Session = Depends(get_session)):
        """Delete a card and its review history. Media rows are detached, not deleted; the
        word keeps its status."""
        card = get_card(session, card_id)
        session.exec(delete(ReviewLog).where(ReviewLog.card_id == card_id))
        for m in session.exec(select(Media).where(Media.card_id == card_id)).all():
            m.card_id = None
            session.add(m)
        session.delete(card)
        session.commit()

    @app.get("/reviews/due", response_model=ReviewQueue, dependencies=auth, tags=["reviews"])
    def reviews_due(limit: int = Query(20, ge=1, le=200), session: Session = Depends(get_session)):
        """Cards due now, most overdue first, with everything the review screen shows."""
        now = srs.utcnow()
        due = (Card.user_id == uid) & (Card.due <= now)  # type: ignore[operator]
        total = session.exec(select(func.count()).select_from(Card).where(due)).one()
        cards = session.exec(select(Card).where(due).order_by(Card.due).limit(limit)).all()  # type: ignore[arg-type]
        return ReviewQueue(due_total=total, cards=[review_card(session, c) for c in cards])

    @app.post("/reviews", response_model=ReviewOut, dependencies=auth, tags=["reviews"])
    def post_review(body: ReviewIn, session: Session = Depends(get_session)):
        card = get_card(session, body.card_id)
        status, graduated = srs.review(session, uid, card, body.rating, body.duration_ms)
        session.commit()
        session.refresh(card)
        return ReviewOut(card=card_out(session, card), word_status=status, graduated=graduated)

    # ---- media (S-2) ----------------------------------------------------------------------

    media_dir = settings.media_dir

    def media_out(m: Media) -> MediaOut:
        token = settings.api_token.strip()
        url = f"/media/{m.id}" + (f"?sig={media_lib.sign(token, m.id)}" if token else "")
        return MediaOut(
            id=m.id, kind=m.kind, mime=m.mime, url=url, bytes=m.bytes, ready=not is_raw(m)
        )

    def is_raw(m: Media) -> bool:
        return m.path.startswith("raw/")

    def finish_media(session: Session, m: Media) -> None:
        """Transcode the raw upload into its final format and replace it."""
        src = media_dir / m.path
        stem = media_dir / m.created_at.strftime("%Y/%m") / f"{m.id}-{m.kind.value}"
        dst, mime = media_lib.transcode(m.kind, src, stem)
        m.path, m.mime, m.bytes = dst.relative_to(media_dir).as_posix(), mime, dst.stat().st_size
        session.add(m)
        session.commit()
        src.unlink(missing_ok=True)

    def finish_media_later(media_id: int) -> None:
        with Session(app.state.engine) as session:
            m = session.get(Media, media_id)
            if m is None or not is_raw(m):
                return
            try:
                finish_media(session, m)
            except media_lib.MediaError:
                log.exception("clip %s: transcoding failed; keeping the original", media_id)

    @app.post("/media", response_model=MediaOut, status_code=201, dependencies=auth, tags=["media"])
    def upload_media(
        background: BackgroundTasks,
        file: UploadFile = File(
            description="PNG/JPEG/WebP image, or audio/video (webm, ogg, mp4…)"
        ),
        kind: MediaKind = Form(),
        card_id: int | None = Form(None, description="Attach to an existing card right away"),
        session: Session = Depends(get_session),
    ):
        """Store and compress scene media. Screenshots and audio are transcoded before the
        response; clips are transcoded in the background (`ready: false` until done)."""
        if not media_lib.ffmpeg_available():
            raise HTTPException(503, "ffmpeg is not installed on the server")
        if card_id is not None:
            get_card(session, card_id)
        limit = media_lib.MAX_BYTES[kind]
        raw = file.file.read(limit + 1)
        if len(raw) > limit:
            raise HTTPException(413, f"{kind.value} too large (max {limit // 1024 // 1024} MB)")
        if not raw:
            raise HTTPException(422, "empty file")
        suffix = Path(file.filename or "").suffix
        suffix = suffix if re.fullmatch(r"\.[A-Za-z0-9]{1,6}", suffix) else ""
        raw_rel = f"raw/{uuid4().hex}{suffix}"
        raw_path = media_dir / raw_rel
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        raw_path.write_bytes(raw)
        try:
            media_lib.probe(raw_path)
        except media_lib.MediaError as e:
            raw_path.unlink(missing_ok=True)
            raise HTTPException(422, str(e)) from e

        m = Media(
            card_id=card_id,
            kind=kind,
            path=raw_rel,
            mime=file.content_type or "application/octet-stream",
            bytes=len(raw),
        )
        session.add(m)
        session.commit()
        session.refresh(m)
        if kind == MediaKind.clip:
            background.add_task(finish_media_later, m.id)
            return media_out(m)
        try:
            finish_media(session, m)
        except media_lib.MediaError as e:
            raw_path.unlink(missing_ok=True)
            session.delete(m)
            session.commit()
            raise HTTPException(422, str(e)) from e
        return media_out(m)

    @app.get(
        "/media/{media_id}",
        tags=["media"],
        response_class=FileResponse,
        responses={200: {"description": "The media file"}},
    )
    def read_media(
        media_id: int,
        request: Request,
        sig: str | None = Query(None, description="Signature from MediaOut.url"),
        session: Session = Depends(get_session),
    ):
        """Serve a media file. Auth: the usual token header, or the `sig` in `MediaOut.url`."""
        token = settings.api_token.strip()
        if not (token_ok(request) or media_lib.check_sig(token, media_id, sig)):
            raise HTTPException(401, "invalid or missing API token / signature")
        m = session.get(Media, media_id)
        path = media_dir / m.path if m else None
        if not m or not path or not path.is_file():
            raise HTTPException(404, "media not found")
        cache = "no-cache" if is_raw(m) else "private, max-age=31536000, immutable"
        return FileResponse(path, media_type=m.mime, headers={"Cache-Control": cache})

    @app.delete("/media/{media_id}", status_code=204, dependencies=auth, tags=["media"])
    def delete_media(media_id: int, session: Session = Depends(get_session)):
        m = session.get(Media, media_id)
        if not m:
            raise HTTPException(404, "media not found")
        (media_dir / m.path).unlink(missing_ok=True)
        session.delete(m)
        session.commit()

    return app
