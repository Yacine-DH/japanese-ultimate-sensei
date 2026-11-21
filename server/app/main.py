"""FastAPI app factory.

Run (from server/):  uv run uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
"""

import hmac
import json
import logging
import re
from datetime import UTC, date, datetime, timedelta
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

from app import __version__, anki_import, srs
from app import activity as act
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
from app.jimaku import Jimaku, JimakuError, extract_subtitle, guess_episode, rank
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
    ActivityOut,
    AnimeOut,
    AnimeProgress,
    AnkiCardsImport,
    BulkStatusIn,
    BulkStatusOut,
    CardCreate,
    CardCreated,
    CardOut,
    EpisodeCreated,
    EpisodeOut,
    EpisodePatch,
    EpisodeProgress,
    EpisodeRef,
    Health,
    ImportReport,
    JimakuEntry,
    JimakuFile,
    JimakuImport,
    LineOut,
    LookupResult,
    MediaOut,
    ProgressPoint,
    ReviewCard,
    ReviewIn,
    ReviewOut,
    ReviewQueue,
    TokenOut,
    Understanding,
    WatchIn,
    WatchOut,
    WordListImport,
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
    app.state.jimaku = Jimaku(settings.jimaku_api_key.strip())

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

    def import_episode(
        session: Session,
        raw: bytes,
        filename: str | None,
        anime_title: str,
        number: float | None,
        title: str | None,
        source: str,
        anilist_id: int | None = None,
        title_jp: str | None = None,
    ) -> dict:
        try:
            lines = parse_bytes(raw)
        except Exception as e:  # pysubs2 raises several types on bad input
            raise HTTPException(422, f"could not parse subtitle file: {e}") from e
        if not lines:
            raise HTTPException(422, "no Japanese dialogue lines found in subtitle file")

        anime = None
        if anilist_id is not None:
            anime = session.exec(select(Anime).where(Anime.anilist_id == anilist_id)).first()
        if anime is None:
            anime = session.exec(select(Anime).where(Anime.title == anime_title.strip())).first()
        if anime is None:
            anime = Anime(title=anime_title.strip())
        anime.anilist_id = anime.anilist_id or anilist_id
        anime.title_jp = anime.title_jp or title_jp
        session.add(anime)
        session.flush()
        ep = Episode(
            anime_id=anime.id,
            number=number,
            title=title,
            source=source,
            source_filename=filename,
        )
        session.add(ep)
        session.flush()
        ingest_lines(session, ep, lines, app.state.dictionary)
        session.flush()
        act.snapshot(session, uid, anime.id)  # first point of the "% understood" trend
        session.commit()
        session.refresh(ep)
        return {**episode_out(session, ep), "understanding": understanding(session, uid, ep.id)}

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
        return import_episode(
            session, raw, subtitle.filename, anime_title, episode_number, title, source="upload"
        )

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
        if status == WordStatus.known:
            newly = sum(1 for w in word_ids if w not in existing or existing[w].status != status)
            if newly:
                srs.bump_activity(session, uid, words_known=newly)
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

    # ---- Jimaku subtitle search (S-1) -----------------------------------------------------

    def jimaku_call(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except JimakuError as e:
            raise HTTPException(e.status, str(e)) from e

    def entry_out(e: dict) -> JimakuEntry:
        return JimakuEntry(
            id=e["id"],
            name=e.get("name") or "",
            english_name=e.get("english_name"),
            japanese_name=e.get("japanese_name"),
            anilist_id=e.get("anilist_id"),
            movie=bool((e.get("flags") or {}).get("movie")),
        )

    @app.get("/subs/search", response_model=list[JimakuEntry], dependencies=auth, tags=["subs"])
    def subs_search(
        q: str | None = Query(None, min_length=1, description="Anime title (romaji/EN/JP)"),
        anilist_id: int | None = None,
    ):
        """Find the anime on jimaku.cc (Japanese subtitles)."""
        if not q and anilist_id is None:
            raise HTTPException(422, "pass q or anilist_id")
        found = jimaku_call(app.state.jimaku.search, q or "", anilist_id)
        return [entry_out(e) for e in found[:25]]

    @app.get(
        "/subs/{entry_id}/files", response_model=list[JimakuFile], dependencies=auth, tags=["subs"]
    )
    def subs_files(entry_id: int, episode: int | None = Query(None, ge=0)):
        """Subtitle files of an entry, best first: single-episode text subtitles from web/TV
        releases rank highest; bundles (01-04), image subs and 7z/rar sink to the bottom."""
        files = jimaku_call(app.state.jimaku.files, entry_id, episode)
        return [
            JimakuFile(**{k: v for k, v in vars(f).items() if k in JimakuFile.model_fields})
            for f in rank(files, episode)
        ]

    @app.post(
        "/episodes/from-jimaku",
        response_model=EpisodeCreated,
        status_code=201,
        dependencies=auth,
        tags=["episodes", "subs"],
    )
    def episode_from_jimaku(body: JimakuImport, session: Session = Depends(get_session)):
        """Download a Jimaku file (zip archives are unpacked) and import it as an episode."""
        jm = app.state.jimaku
        entry = jimaku_call(jm.entry, body.entry_id)
        number = body.episode_number
        if number is None and (guessed := guess_episode(body.file_name)) is not None:
            number = float(guessed)
        data = jimaku_call(jm.download, body.entry_id, body.file_name)
        name, raw = jimaku_call(
            extract_subtitle, body.file_name, data, int(number) if number is not None else None
        )
        title = body.anime_title or entry.get("english_name") or entry.get("name") or "Unknown"
        return import_episode(
            session,
            raw,
            name,
            title,
            number,
            None,
            source="jimaku",
            anilist_id=entry.get("anilist_id"),
            title_jp=entry.get("japanese_name"),
        )

    # ---- activity + progress (S-6) --------------------------------------------------------

    @app.post("/activity/watch", response_model=WatchOut, dependencies=auth, tags=["activity"])
    def watch_heartbeat(body: WatchIn, session: Session = Depends(get_session)):
        """Heartbeat from the extension while a video plays with the overlay attached
        (e.g. every 30 s with the seconds since the last one)."""
        ep = get_episode(session, body.episode_id)
        total = act.add_watch(session, uid, ep.id, body.seconds)
        if ep.anime_id:
            act.snapshot_if_missing(session, uid, ep.anime_id)
        session.commit()
        return WatchOut(day=act.today(), seconds_today=total)

    @app.get("/activity", response_model=ActivityOut, dependencies=auth, tags=["activity"])
    def read_activity(
        from_: date | None = Query(None, alias="from", description="Default: 364 days before `to`"),
        to: date | None = Query(None, description="Default: today (server-local)"),
        session: Session = Depends(get_session),
    ):
        """Heatmap data: one row per active day + streaks and totals for the range."""
        end = to or act.today()
        start = from_ or end - timedelta(days=364)
        if start > end or (end - start).days > 3 * 366:
            raise HTTPException(422, "from must be ≤ to and the range ≤ 3 years")
        return act.activity(session, uid, start, end)

    def anime_out(session: Session, anime: Anime, stats: dict | None = None) -> AnimeOut:
        ids = act.anime_episode_ids(session, anime.id)
        stats = stats or act.understanding_of(session, uid, ids)
        return AnimeOut(
            id=anime.id,
            title=anime.title,
            title_jp=anime.title_jp,
            anilist_id=anime.anilist_id,
            episode_count=len(ids),
            **{k: stats[k] for k in ("unique_words", "known_unique", "token_pct", "unique_pct")},
        )

    @app.get("/anime", response_model=list[AnimeOut], dependencies=auth, tags=["activity"])
    def list_anime(session: Session = Depends(get_session)):
        animes = session.exec(select(Anime).order_by(Anime.title)).all()
        return [anime_out(session, a) for a in animes]

    @app.get(
        "/anime/{anime_id}/progress",
        response_model=AnimeProgress,
        dependencies=auth,
        tags=["activity"],
    )
    def anime_progress(anime_id: int, session: Session = Depends(get_session)):
        """'% understood' over time for one anime, plus where each episode stands now."""
        anime = session.get(Anime, anime_id)
        if not anime:
            raise HTTPException(404, "anime not found")
        stats = act.snapshot(session, uid, anime_id)  # refresh today's point
        session.commit()
        eps = session.exec(select(Episode).where(Episode.anime_id == anime_id)).all()
        secs = act.watch_seconds_by_episode(session, uid, [e.id for e in eps])
        episodes = []
        for e in sorted(eps, key=lambda e: (e.number is None, e.number or 0, e.id)):
            u = understanding(session, uid, e.id)
            episodes.append(
                EpisodeProgress(
                    episode_id=e.id,
                    number=e.number,
                    title=e.title,
                    token_pct=u["token_pct"],
                    unique_pct=u["unique_pct"],
                    minutes_watched=round(secs.get(e.id, 0) / 60),
                )
            )
        return AnimeProgress(
            anime=anime_out(session, anime, stats),
            series=[
                ProgressPoint(**p.model_dump(include=set(ProgressPoint.model_fields)))
                for p in act.series(session, uid, anime_id)
            ],
            episodes=episodes,
        )

    # ---- known-word import (S-4) ----------------------------------------------------------

    MAX_APKG_BYTES = 300 * 1024 * 1024

    def report_out(r: anki_import.ImportReport) -> ImportReport:
        return ImportReport(**vars(r))

    @app.post("/import/words", response_model=ImportReport, dependencies=auth, tags=["import"])
    def import_words(body: WordListImport, session: Session = Depends(get_session)):
        """Mark a plain list of words (one per line) as known or learning."""
        items = [(line, body.status) for line in body.text.splitlines() if line.strip()]
        r = anki_import.apply_words(session, uid, items, app.state.dictionary, body.dry_run)
        return report_out(r)

    @app.post("/import/anki", response_model=ImportReport, dependencies=auth, tags=["import"])
    def import_anki(
        file: UploadFile = File(description="Anki deck export (.apkg), any Anki version"),
        field: str | None = Form(
            None, description="Field holding the Japanese word (auto if empty)"
        ),
        deck: str | None = Form(None, description="Only this deck (and its subdecks)"),
        mature_days: int = Form(anki_import.MATURE_DAYS, ge=1, le=365),
        dry_run: bool = Form(False, description="Preview the report without saving"),
        session: Session = Depends(get_session),
    ):
        """Import an Anki deck: mature cards (interval ≥ `mature_days`) → known, studied
        younger cards → learning, never-studied cards are skipped. Run with `dry_run` first to
        check `note_types[].field_used`, then re-run with `field` if the wrong field was picked."""
        raw = file.file.read(MAX_APKG_BYTES + 1)
        if len(raw) > MAX_APKG_BYTES:
            raise HTTPException(413, "deck too large (max 300 MB; export without media)")
        try:
            apkg = anki_import.read_apkg(raw)
        except anki_import.AnkiFormatError as e:
            raise HTTPException(422, str(e)) from e
        report = anki_import.ImportReport()
        items = anki_import.apkg_items(apkg, field, deck, mature_days, report)
        r = anki_import.apply_words(session, uid, items, app.state.dictionary, dry_run, report)
        return report_out(r)

    @app.post("/import/anki/cards", response_model=ImportReport, dependencies=auth, tags=["import"])
    def import_anki_cards(body: AnkiCardsImport, session: Session = Depends(get_session)):
        """Same as /import/anki but from AnkiConnect data the extension read on the laptop
        (`findCards` + `cardsInfo`: the word field's value + `interval`)."""
        report = anki_import.ImportReport()
        items = []
        for c in body.cards:
            if not c.studied:
                report.skipped_new += 1
                continue
            status = (
                WordStatus.known if c.interval_days >= body.mature_days else WordStatus.learning
            )
            items.append((c.expression, status))
        r = anki_import.apply_words(session, uid, items, app.state.dictionary, body.dry_run, report)
        return report_out(r)

    return app
