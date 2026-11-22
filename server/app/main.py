"""FastAPI app factory.

Run (from server/):  uv run uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
"""

import hmac
import json
import logging
import re
import tempfile
from dataclasses import asdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Literal
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

from app import __version__, anki_export, anki_import, srs
from app import activity as act
from app import media as media_lib
from app import sync as sync_lib
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
from app.llm import LLM, LLMError, explain_line
from app.models import (
    Anime,
    Card,
    Episode,
    LineNote,
    Media,
    MediaKind,
    ReviewLog,
    SubtitleLine,
    UserWord,
    WatchDay,
    Word,
    WordStatus,
)
from app.nlp.frequency import fill_zipf, usefulness
from app.nlp.tokenizer import line_romaji
from app.schemas import (
    ActivityOut,
    AnimeOut,
    AnimeProgress,
    AnkiCardsImport,
    AnkiConnectNote,
    AnkiMediaFile,
    AnkiModel,
    AnkiNotePayload,
    AutoImport,
    AutoImportOut,
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
    ExampleLine,
    Health,
    ImportReport,
    JimakuEntry,
    JimakuFile,
    JimakuImport,
    LineExplanation,
    LineOut,
    LLMStatus,
    LookupResult,
    MediaOut,
    MissedWord,
    ProgressPoint,
    ReviewCard,
    ReviewIn,
    ReviewOut,
    ReviewQueue,
    SyncOut,
    TokenOut,
    TranslationJob,
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
from app.translate_jobs import Translator
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
    app.state.llm = LLM(
        settings.llm_base_url.strip(),
        settings.llm_model.strip(),
        settings.llm_api_key.strip(),
        settings.llm_timeout_s,
    )
    app.state.translator = Translator(app.state.engine, app.state.llm)

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
        words = (
            {
                w.id: w
                for w in session.exec(select(Word).where(Word.id.in_(list(word_ids)))).all()  # type: ignore[union-attr]
            }
            if word_ids
            else {}
        )
        if fill_zipf(session, words.values()):
            session.commit()
        out = []
        for line, toks in zip(lines, parsed, strict=True):
            tokens = [
                TokenOut(
                    **{
                        k: t[k]
                        for k in TokenOut.model_fields
                        if k in t and k not in ("status", "common", "zipf", "is_proper_noun")
                    },
                    is_proper_noun=token_is_proper(t),
                    status=(
                        statuses.get(t["word_id"], WordStatus.new) if t.get("word_id") else None
                    ),
                    common=bool(w := words.get(t.get("word_id"))) and w.common,
                    zipf=w.zipf if w else None,
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
        jimaku_entry_id: int | None = None,
    ) -> dict:
        try:
            lines = parse_bytes(raw)
        except Exception as e:  # pysubs2 raises several types on bad input
            raise HTTPException(422, f"could not parse subtitle file: {e}") from e
        if not lines:
            raise HTTPException(422, "no Japanese dialogue lines found in subtitle file")

        anime = None
        if jimaku_entry_id is not None:
            anime = session.exec(
                select(Anime).where(Anime.jimaku_entry_id == jimaku_entry_id)
            ).first()
        if anime is None and anilist_id is not None:
            anime = session.exec(select(Anime).where(Anime.anilist_id == anilist_id)).first()
        if anime is None:
            anime = session.exec(select(Anime).where(Anime.title == anime_title.strip())).first()
        if anime is None:
            anime = Anime(title=anime_title.strip())
        anime.anilist_id = anime.anilist_id or anilist_id
        anime.title_jp = anime.title_jp or title_jp
        anime.jimaku_entry_id = anime.jimaku_entry_id or jimaku_entry_id
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

    @app.post(
        "/episodes/{episode_id}/sync", response_model=SyncOut, dependencies=auth, tags=["episodes"]
    )
    def sync_episode(
        episode_id: int,
        file: UploadFile = File(description="Audio (or video) recorded from the stream, 30–90 s"),
        video_start_ms: int = Form(description="Video time when the recording started"),
        apply: bool = Form(True, description="Set sub_offset_ms when the result is confident"),
        search_ms: int = Form(
            120_000, ge=10_000, le=600_000, description="Search ± this around the current offset"
        ),
        session: Session = Depends(get_session),
    ):
        """Find the subtitle offset from the episode's audio: voice activity in the sample is
        matched against when lines are on screen. Takes about a second per minute of audio."""
        if not media_lib.ffmpeg_available():
            raise HTTPException(503, "ffmpeg is not installed on the server")
        ep = get_episode(session, episode_id)
        limit = media_lib.MAX_BYTES[MediaKind.audio]
        raw = file.file.read(limit + 1)
        if len(raw) > limit:
            raise HTTPException(413, f"sample too large (max {limit // 1024 // 1024} MB)")
        if not raw:
            raise HTTPException(422, "empty file")
        lines = [
            (s, e)
            for s, e in session.exec(
                select(SubtitleLine.start_ms, SubtitleLine.end_ms).where(
                    SubtitleLine.episode_id == episode_id
                )
            ).all()
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample"
            path.write_bytes(raw)
            try:
                r = sync_lib.sync_file(path, lines, video_start_ms, search_ms, ep.sub_offset_ms)
            except sync_lib.SyncError as e:
                raise HTTPException(422, str(e)) from e
        previous = ep.sub_offset_ms
        applied = apply and r.confident
        if applied:
            ep.sub_offset_ms = r.offset_ms
            session.add(ep)
            session.commit()
        log.info("sync episode %s: %s (applied=%s)", episode_id, r, applied)
        return SyncOut(previous_offset_ms=previous, applied=applied, **asdict(r))

    @app.delete("/episodes/{episode_id}", status_code=204, dependencies=auth, tags=["episodes"])
    def delete_episode(episode_id: int, session: Session = Depends(get_session)):
        """Delete an episode and its lines. Cards saved from it are kept (their sentence text
        stays; they just lose the link to the line). Watch time for it is removed."""
        ep = get_episode(session, episode_id)
        line_ids = select(SubtitleLine.id).where(SubtitleLine.episode_id == episode_id)
        for card in session.exec(select(Card).where(Card.line_id.in_(line_ids))).all():  # type: ignore[union-attr]
            card.line_id = None
            session.add(card)
        session.exec(delete(WatchDay).where(WatchDay.episode_id == episode_id))
        session.exec(delete(LineNote).where(LineNote.line_id.in_(line_ids)))  # type: ignore[attr-defined]
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
        q: str,
        reading: str | None = None,
        limit: int = 5,
        word_id: int | None = Query(
            None, description="Token's word_id: its linked entry comes first (exact homophone)"
        ),
        d: Dictionary = Depends(dictionary_dep),
        session: Session = Depends(get_session),
    ):
        word = session.get(Word, word_id) if word_id else None
        first = word.jmdict_id if word else None
        return LookupResult(
            query=q, reading=reading, entries=d.lookup(q, reading, min(limit, 20), first)
        )

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
        sort: Literal["auto", "frequency"] = Query(
            "auto",
            description="auto: by occurrences with anime/episode, else newest; frequency: zipf",
        ),
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
        if sort == "frequency":
            if fill_zipf(session, [r[0] for r in rows]):
                session.commit()
            rows = sorted(rows, key=lambda r: (-(r[0].zipf or 0), r[0].id))
        elif counts is not None:
            rows = sorted(rows, key=lambda r: (-counts.get(r[0].id, 0), r[0].id))
        else:
            rows = sorted(rows, key=lambda r: -(r[0].id or 0))
        page = rows[offset : offset + limit]
        if fill_zipf(session, [w for w, _ in page]):
            session.commit()
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
            media=[media_out(m) for m in media],
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
        format: Literal["mp3"] | None = Query(None, description="audio only: MP3 copy (for Anki)"),
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
        mime = m.mime
        if format == "mp3":
            if m.kind != MediaKind.audio or is_raw(m):
                raise HTTPException(422, "mp3 is only available for finished audio")
            try:
                path, mime = media_lib.ensure_mp3(path), "audio/mpeg"
            except media_lib.MediaError as e:
                raise HTTPException(500, str(e)) from e
        return FileResponse(path, media_type=mime, headers={"Cache-Control": cache})

    @app.delete("/media/{media_id}", status_code=204, dependencies=auth, tags=["media"])
    def delete_media(media_id: int, session: Session = Depends(get_session)):
        m = session.get(Media, media_id)
        if not m:
            raise HTTPException(404, "media not found")
        (media_dir / m.path).unlink(missing_ok=True)
        (media_dir / m.path).with_suffix(".mp3").unlink(missing_ok=True)
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
            jimaku_entry_id=entry["id"],
        )

    def library_anime_for(session: Session, entry: dict) -> Anime | None:
        anime = session.exec(select(Anime).where(Anime.jimaku_entry_id == entry["id"])).first()
        if anime is None and entry.get("anilist_id") is not None:
            anime = session.exec(
                select(Anime).where(Anime.anilist_id == entry["anilist_id"])
            ).first()
        return anime

    @app.post(
        "/episodes/auto", response_model=AutoImportOut, dependencies=auth, tags=["episodes", "subs"]
    )
    def episode_auto(body: AutoImport, session: Session = Depends(get_session)):
        """One step from "I'm watching X episode N" to an episode: finds the anime on Jimaku
        (or reuses the library anime's entry), returns the episode if it's already imported,
        else imports the recommended Japanese subtitle file."""
        jm = app.state.jimaku
        entry = None
        if body.anime_id is not None:
            anime = session.get(Anime, body.anime_id)
            if anime is None:
                raise HTTPException(404, "anime not found")
            if anime.jimaku_entry_id is not None:
                entry = jimaku_call(jm.entry, anime.jimaku_entry_id)
            elif anime.anilist_id is not None:
                found = jimaku_call(jm.search, "", anime.anilist_id)
                entry = found[0] if found else None
            if entry is None:
                found = jimaku_call(jm.search, anime.title)
                entry = found[0] if found else None
        elif body.query and body.query.strip():
            found = jimaku_call(jm.search, body.query.strip())
            entry = found[0] if found else None
        else:
            raise HTTPException(422, "pass query or anime_id")
        if entry is None:
            raise HTTPException(404, f"no anime matching {body.query or 'that title'!r} on Jimaku")

        number = body.episode_number
        anime = library_anime_for(session, entry)
        if anime is not None:
            ep = session.exec(
                select(Episode).where(Episode.anime_id == anime.id, Episode.number == number)
            ).first()
            if ep is not None:
                if anime.jimaku_entry_id is None:
                    anime.jimaku_entry_id = entry["id"]
                    session.add(anime)
                    session.commit()
                created = {
                    **episode_out(session, ep),
                    "understanding": understanding(session, uid, ep.id),
                }
                return AutoImportOut(episode=created, existing=True, entry=entry_out(entry))

        files = rank(jimaku_call(jm.files, entry["id"], int(number)), int(number))
        pick = next((f for f in files if f.recommended), None)
        if pick is None:
            raise HTTPException(
                404,
                f"no Japanese subtitles for episode {number:g} of {entry.get('name')} on Jimaku",
            )
        data = jimaku_call(jm.download, entry["id"], pick.name)
        name, raw = jimaku_call(extract_subtitle, pick.name, data, int(number))
        title = (anime.title if anime else None) or entry.get("english_name") or entry.get("name")
        created = import_episode(
            session, raw, name, title or "Unknown", number, None, source="jimaku",
            anilist_id=entry.get("anilist_id"), title_jp=entry.get("japanese_name"),
            jimaku_entry_id=entry["id"],
        )  # fmt: skip
        return AutoImportOut(
            episode=created, existing=False, entry=entry_out(entry), file_name=pick.name
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

    # ---- Anki export (S-5) ----------------------------------------------------------------

    @app.get(
        "/export/anki.apkg",
        dependencies=auth,
        tags=["anki"],
        response_class=Response,
        responses={200: {"content": {"application/apkg": {}}, "description": "Anki package"}},
    )
    def export_apkg(
        since: datetime | None = Query(None, description="Only cards created at/after (ISO)"),
        deck: str = Query("Sensei", min_length=1, max_length=100),
        session: Session = Depends(get_session),
    ):
        """All cards (or those created since a date) as an .apkg with screenshot, MP3 audio
        and clip. Re-importing a newer export updates existing notes."""
        stmt = select(Card).where(Card.user_id == uid).order_by(Card.id)  # type: ignore[arg-type]
        if since is not None:
            stmt = stmt.where(Card.created_at >= since.astimezone(UTC))
        cards = list(session.exec(stmt).all())
        if not cards:
            raise HTTPException(404, "no cards to export")
        data = anki_export.build_apkg(session, cards, deck, app.state.dictionary, media_dir)
        name = f"sensei-{datetime.now():%Y%m%d}.apkg"
        return Response(
            data,
            media_type="application/apkg",
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )

    @app.get("/anki/model", response_model=AnkiModel, dependencies=auth, tags=["anki"])
    def anki_model():
        """AnkiConnect `createModel` params for the 'Sensei Japanese' note type."""
        return anki_export.create_model_params()

    @app.get(
        "/cards/{card_id}/anki-note",
        response_model=AnkiNotePayload,
        dependencies=auth,
        tags=["anki"],
    )
    def anki_note(
        card_id: int,
        request: Request,
        deck: str = Query("Sensei", min_length=1, max_length=100),
        session: Session = Depends(get_session),
    ):
        """AnkiConnect payload for one card: `storeMediaFile` each `media` item, then
        `addNote` with `note`. Media URLs are absolute (this server's address as the client
        reached it) and signed, so Anki on the laptop can download them."""
        card = get_card(session, card_id)
        media = anki_export.card_media(session, card)
        base = str(request.base_url).rstrip("/")
        files = []
        for m in media.values():
            url = base + media_out(m).url
            if m.kind == MediaKind.audio:
                url += ("&" if "?" in url else "?") + "format=mp3"
            files.append(AnkiMediaFile(filename=anki_export.media_filename(m), url=url))
        return AnkiNotePayload(
            note=AnkiConnectNote(
                deckName=deck,
                modelName=anki_export.MODEL_NAME,
                fields=anki_export.note_fields(session, card, app.state.dictionary, media),
                tags=anki_export.tags_for(session, card),
            ),
            media=files,
        )

    # ---- missed words (S-8) ---------------------------------------------------------------

    def short_gloss(entry: dict | None, lang: str) -> str | None:
        senses = (entry or {}).get("senses", {}).get(lang) or []
        return "; ".join(senses[0]["glosses"][:3]) if senses and senses[0].get("glosses") else None

    @app.get(
        "/episodes/{episode_id}/missed",
        response_model=list[MissedWord],
        dependencies=auth,
        tags=["episodes"],
    )
    def missed_words(
        episode_id: int,
        limit: int = Query(30, ge=1, le=200),
        include_learning: bool = Query(False, description="Also list words you're learning"),
        session: Session = Depends(get_session),
    ):
        """After an episode: the unknown words most worth learning, best first (general
        frequency + how often this episode and anime use them). Names are excluded."""
        ep = get_episode(session, episode_id)
        lines = episode_lines(session, episode_id)
        counts = word_counts(session, [episode_id])
        anime_counts = (
            word_counts(session, act.anime_episode_ids(session, ep.anime_id))
            if ep.anime_id
            else counts
        )
        statuses = status_map(session, uid, counts)
        skip = {WordStatus.known, WordStatus.ignored}
        if not include_learning:
            skip.add(WordStatus.learning)
        candidates = [w for w in counts if statuses.get(w, WordStatus.new) not in skip]
        words = {
            w.id: w
            for w in session.exec(select(Word).where(Word.id.in_(candidates))).all()  # type: ignore[union-attr]
        }
        if fill_zipf(session, words.values()):
            session.commit()
        ranked = sorted(
            words.values(),
            key=lambda w: (-usefulness(w.zipf, counts[w.id], anime_counts.get(w.id, 0)), w.id),
        )[:limit]

        first_line: dict[int, SubtitleLine] = {}
        wanted = {w.id for w in ranked}
        for line in lines:
            for t in json.loads(line.tokens_json):
                wid = t.get("word_id")
                if wid in wanted and wid not in first_line:
                    first_line[wid] = line
        d = app.state.dictionary
        out = []
        for w in ranked:
            entry = d.entry(w.jmdict_id) if d is not None and w.jmdict_id else None
            line = first_line.get(w.id)
            out.append(
                MissedWord(
                    word=WordListItem(
                        **w.model_dump(),
                        status=statuses.get(w.id, WordStatus.new),
                        occurrences=counts[w.id],
                    ),
                    score=usefulness(w.zipf, counts[w.id], anime_counts.get(w.id, 0)),
                    anime_occurrences=anime_counts.get(w.id, 0),
                    example=ExampleLine(line_id=line.id, text=line.text, start_ms=line.start_ms)
                    if line
                    else None,
                    gloss_en=short_gloss(entry, "eng"),
                    gloss_de=short_gloss(entry, "ger"),
                )
            )
        return out

    # ---- LLM translations + grammar notes (S-9) -------------------------------------------

    @app.get("/llm/status", response_model=LLMStatus, dependencies=auth, tags=["llm"])
    def llm_status():
        llm = app.state.llm
        reachable, detail = llm.status()
        return LLMStatus(
            configured=llm.configured,
            reachable=reachable,
            model=llm.model or None,
            base_url=llm.base_url or None,
            detail=detail,
        )

    def job_out(session: Session, episode_id: int) -> TranslationJob:
        total = session.exec(
            select(func.count())
            .select_from(SubtitleLine)
            .where(SubtitleLine.episode_id == episode_id)
        ).one()
        done = session.exec(
            select(func.count())
            .select_from(SubtitleLine)
            .where(SubtitleLine.episode_id == episode_id, SubtitleLine.translation_en.is_not(None))  # type: ignore[union-attr]
        ).one()
        job = app.state.translator.jobs.get(episode_id)
        return TranslationJob(
            episode_id=episode_id,
            total_lines=total,
            translated_lines=done,
            queued=bool(job and job.queued),
            running=bool(job and job.running),
            error=job.error if job else None,
            failed_lines=job.failed_lines if job else 0,
        )

    @app.post(
        "/episodes/{episode_id}/translate",
        response_model=TranslationJob,
        status_code=202,
        dependencies=auth,
        tags=["llm"],
    )
    def start_translation(episode_id: int, session: Session = Depends(get_session)):
        """Translate every untranslated line (EN + DE) in the background; results land in
        `LineOut.translation_en/de`. Poll `GET` on the same path for progress. On a small
        local model this takes a while (run it before watching / overnight)."""
        get_episode(session, episode_id)
        if not app.state.llm.configured:
            raise HTTPException(503, "LLM not configured (SENSEI_LLM_BASE_URL + SENSEI_LLM_MODEL)")
        app.state.translator.enqueue(episode_id)
        return job_out(session, episode_id)

    @app.get(
        "/episodes/{episode_id}/translate",
        response_model=TranslationJob,
        dependencies=auth,
        tags=["llm"],
    )
    def translation_progress(episode_id: int, session: Session = Depends(get_session)):
        get_episode(session, episode_id)
        return job_out(session, episode_id)

    @app.post(
        "/lines/{line_id}/explain",
        response_model=LineExplanation,
        dependencies=auth,
        tags=["llm"],
    )
    def explain(
        line_id: int,
        lang: Literal["en", "de"] = "en",
        refresh: bool = False,
        session: Session = Depends(get_session),
    ):
        """Grammar note for one line (translation, word breakdown, grammar points), cached.
        Slow on a small local model (tens of seconds): show a spinner."""
        line = session.get(SubtitleLine, line_id)
        if not line:
            raise HTTPException(404, "line not found")
        note = session.get(LineNote, (line_id, lang))
        if note and not refresh:
            return LineExplanation(
                line_id=line_id, lang=lang, text=note.text, model=note.model, cached=True
            )
        neighbours = episode_lines(session, line.episode_id)
        pos = next(i for i, x in enumerate(neighbours) if x.id == line_id)
        before = [x.text for x in neighbours[max(0, pos - 2) : pos]]
        after = [x.text for x in neighbours[pos + 1 : pos + 2]]
        try:
            text = explain_line(
                app.state.llm, line.text, before, after, lang, json.loads(line.tokens_json)
            )
        except LLMError as e:
            raise HTTPException(e.status, str(e)) from e
        note = note or LineNote(line_id=line_id, lang=lang, text="", model="")
        note.text, note.model, note.created_at = text, app.state.llm.model, datetime.now(UTC)
        session.add(note)
        session.commit()
        return LineExplanation(
            line_id=line_id, lang=lang, text=text, model=note.model, cached=False
        )

    return app
