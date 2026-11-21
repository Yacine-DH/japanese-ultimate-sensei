# API contract (v0.1.0, Phase 0)

Base URL: `http://<server-tailscale-name>:8000`. Interactive docs at `/docs`; machine-readable
spec in [`openapi.json`](openapi.json) (regenerate with `cd server && uv run python -m app.export_openapi`).

**Auth:** every endpoint except `/health` requires `Authorization: Bearer <token>` (or
`X-Sensei-Token: <token>`); `401` otherwise. The server refuses to start without a
`SENSEI_API_TOKEN` (≥ 16 chars) unless `SENSEI_ALLOW_NO_AUTH=true` (local dev only), in which
case `/health` reports `"auth": false`.
**Web app:** the server also serves `web/dist` at `/` for browser page loads (see DECISIONS.md),
so the web app talks to the API on the same origin.
**Times** are integer milliseconds. **Readings** are hiragana. **Errors** are `{"detail": "..."}`.

## Meta
### `GET /health`
`{"status":"ok","version":"0.1.0","dictionary":true,"auth":true,"ffmpeg":true,"media_bytes":123456}`. `dictionary:false` means
`/dictionary/lookup` returns 503 until the dictionary is built.

## Episodes
### `POST /episodes` (multipart/form-data) → 201 `EpisodeCreated`
Fields: `subtitle` (file: .srt/.ass/.ssa/.vtt, UTF-8/Shift-JIS/EUC-JP/UTF-16, ≤ 5 MB),
`anime_title` (str, required; anime is created if new), `episode_number` (float, optional),
`title` (optional). 422 if unparsable or no Japanese lines.

### `GET /episodes` → `EpisodeOut[]` (newest first) · `GET /episodes/{id}` → `EpisodeOut`
```json
{"id":1,"anime_id":1,"anime_title":"Frieren","number":1.0,"title":null,"source":"upload",
 "source_filename":"frieren_01.ja.ass","sub_offset_ms":0,"line_count":312,"created_at":"..."}
```
`EpisodeCreated` = `EpisodeOut` + `"understanding": Understanding`.

### `PATCH /episodes/{id}` body `{"sub_offset_ms"?: int, "title"?: str, "number"?: float}` → `EpisodeOut`
Display rule for clients: line is active when
`line.start_ms + sub_offset_ms <= video_ms < line.end_ms + sub_offset_ms`.

### `DELETE /episodes/{id}` → 204

### `GET /episodes/{id}/lines` → `LineOut[]` (ordered by `idx`)
```json
{"id":10,"idx":0,"start_ms":1000,"end_ms":3500,"text":"何か食べたい",
 "romaji":"nanika tabetai","translation_en":null,"translation_de":null,
 "tokens":[
  {"surface":"食べ","lemma":"食べる","reading":"たべ","lemma_reading":"たべる",
   "pos":"動詞","pos_detail":["一般","下一段-バ行","連用形-一般"],
   "furigana":[{"text":"食","ruby":"た"},{"text":"べ","ruby":null}],
   "romaji":"tabe","is_content":true,"is_proper_noun":false,"word_id":42,"status":"new","common":true},
  {"surface":"たい","lemma":"たい","reading":"たい","lemma_reading":"たい","pos":"助動詞",
   "pos_detail":["助動詞-タイ","終止形-一般"],"furigana":[{"text":"たい","ruby":null}],"romaji":"tai",
   "is_content":false,"is_proper_noun":false,"word_id":null,"status":null,"common":false}]}
```
- Concatenating `surface` reproduces `text` exactly (spaces included).
- `romaji` (line) = the whole line with words grouped for reading (`tabi wa owatta`,
  `furiiren-sama`). **Show this, not joined `token.romaji`** (per-token romaji splits
  inflections: `owat` + `ta`).
- `is_content` = vocabulary worth learning (not particles, numbers or names).
- `is_proper_noun` = character/place name (Sudachi 固有名詞, or katakana Sudachi doesn't know,
  e.g. フリーレン). Never highlight as unknown and render neutrally; not counted in understanding.
  Names still carry `word_id`/`status`, so they can be looked up.
- Only content words and names have `word_id`/`status`.
- `status` ∈ `new | learning | known | ignored`. For highlighting, treat `known`/`ignored` as understood.
- `common` = JMdict common word, the current priority signal for "which unknown words to highlight".

### `POST /episodes/{id}/reprocess` → `EpisodeCreated`
Re-tokenizes the stored lines with the current tokenizer + dictionary (needed after server
updates such as name detection). Line ids and word statuses are kept. CLI for all episodes:
`cd server && uv run python -m app.reprocess`.

### `GET /episodes/{id}/understanding` → `Understanding`
```json
{"episode_id":1,"total_tokens":1450,"unique_words":420,"known_tokens":300,"known_unique":60,
 "learning_tokens":40,"learning_unique":12,"token_pct":20.7,"unique_pct":14.3}
```
`token_pct` (weighted by how often words are spoken) is the headline "% understood" number.

## Dictionary
### `GET /dictionary/lookup?q=<text>&reading=<hiragana>&limit=5` → `LookupResult`
Use the token's `lemma` + `lemma_reading`. Matches kanji or kana forms. Best entry first.
```json
{"query":"食べる","reading":"たべる","entries":[{"id":"1358280","common":true,
 "kanji":["食べる","喰べる"],"kana":["たべる"],
 "senses":{"eng":[{"pos":["v1","vt"],"misc":[],"glosses":["to eat"]}],
           "ger":[{"pos":[],"misc":[],"glosses":["essen","speisen"]}]}}]}
```
`pos`/`misc` use JMdict tag codes (`v1`, `n`, `uk` = usually written in kana, …). 503 if not built.

## Words
### `GET /words?status=&anime_id=&episode_id=&q=&limit=50&offset=0` → `WordPage`
```json
{"total":420,"items":[{"id":42,"lemma":"食べる","reading":"たべる","pos":"動詞",
 "jmdict_id":"1358280","common":true,"status":"new","occurrences":7}]}
```
- `status=new` includes words with no decision yet. `q` = substring of lemma or reading.
- With `anime_id` and/or `episode_id`: only words spoken there, **most frequent first**, and
  `occurrences` = times spoken there (names excluded). Without them: newest first, `occurrences: null`.
- `limit` 1–500. `total` = matches before paging.

### `POST /words/bulk-status` body `{"word_ids":[1,2,3],"status":"known"}` → `{"updated":3,"missing":[]}`
1–5000 ids; ids that don't exist are reported in `missing` and skipped.

### `GET /words/{id}` → `WordOut`
`{"id":42,"lemma":"食べる","reading":"たべる","pos":"動詞","jmdict_id":"1358280","common":true,"status":"new"}`
### `POST /words/{id}/status` body `{"status":"known"}` → `WordOut`

## Cards + reviews (FSRS)
One card per word (recognition: Japanese → meaning). Scheduling is FSRS (py-fsrs defaults:
90 % retention, 1 m / 10 m learning steps). A word becomes `known` automatically once its card
is in review with stability ≥ 21 days, and drops back to `learning` on a lapse (Again).

### `POST /cards` body `{"word_id":42,"line_id":10,"media_ids":[3,4],"sentence"?:str}` → 201 `CardCreated`
Marks the word `learning` (unless it's already `known`/`ignored`). `sentence` defaults to the
line's text. If the word already has a card: **200** with that card (`"created": false`), and
the new `media_ids` are attached to it. 404 unknown word/line, 422 unknown media ids.
```json
{"id":7,"word_id":42,"line_id":10,"sentence":"何か食べたい","state":"learning",
 "due":"2026-11-19T08:00:00Z","stability":null,"difficulty":null,"reps":0,
 "created_at":"...","created":true}
```
`state` ∈ `learning | review | relearning`.

### `GET /reviews/due?limit=20` → `ReviewQueue` (most overdue first)
```json
{"due_total":12,"cards":[{
  "card":{...CardOut},
  "word":{...WordOut},
  "line":{...LineOut with tokens, furigana, romaji},
  "episode":{"id":1,"anime_title":"Frieren","number":1.0},
  "entry":{...DictEntry with senses.eng / senses.ger},
  "media":[{"id":3,"kind":"screenshot","mime":"image/webp","url":"/media/3"}],
  "next_due":{"1":"...+1m","2":"...+6m","3":"...+10m","4":"...+7d"}}]}
```
`next_due` = when the card would come back for each rating: use it for button labels.
`media[].url` is relative to the server base URL and pre-signed (see Media).
`line`/`episode` are null for cards saved without a line.

### `POST /reviews` body `{"card_id":7,"rating":3,"duration_ms":4200}` → `ReviewOut`
`rating`: 1 Again · 2 Hard · 3 Good · 4 Easy.
`{"card":{...CardOut},"word_status":"learning","graduated":false}`. `graduated: true` = this
review made the word `known` (good moment for a small celebration).

### `GET /cards/{id}` → `ReviewCard` · `DELETE /cards/{id}` → 204
Delete removes the card + its review history; the word keeps its status.

## Media (scene screenshot / line audio / clip)
### `POST /media` (multipart/form-data) → 201 `MediaOut`
Fields: `file`, `kind` = `screenshot | audio | clip`, `card_id` (optional, attach right away).
Send whatever the browser produces (PNG/JPEG canvas blob; `MediaRecorder` webm). The server
compresses it:

| kind | input max | stored as | typical size |
|---|---|---|---|
| screenshot | 10 MB | WebP ≤ 640 px wide, q70 | ~40 KB |
| audio | 15 MB (≤ 30 s used) | Opus 32 kbps mono (`audio/ogg`) | ~20 KB |
| clip | 80 MB (≤ 20 s used) | VP9 WebM ≤ 360 p, 12 fps, **no audio** | ~150–300 KB |

Screenshot/audio are transcoded before the response. Clips are transcoded in the background:
the response has `"ready": false` and `url` serves the original until it's done.
```json
{"id":3,"kind":"screenshot","mime":"image/webp","url":"/media/3?sig=9f2c…","bytes":38211,"ready":true}
```
413 too large · 422 not a readable image/audio/video · 404 unknown `card_id` · 503 no ffmpeg.
Typical Save flow: upload media first → `POST /cards` with `media_ids` (or upload with `card_id`).

### `GET /media/{id}?sig=…` → the file
`MediaOut.url` is **pre-signed**: use it as-is in `<img>`, `<audio>`, `<video>` (prefix the server
base URL). No auth header needed with `sig`; the normal token header also works. Final files are
cacheable forever (`immutable`).

### `DELETE /media/{id}` → 204

## Coming in Phase 1 (not implemented yet; see TASKS.md)
`/subs/search`, `/episodes/from-jimaku` (#13), `/activity` (#18), known-word import, Anki export.
