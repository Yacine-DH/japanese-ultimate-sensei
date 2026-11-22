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

### `POST /episodes/{id}/sync` (multipart) → `SyncOut`
Automatic subtitle offset from the episode's audio. Form: `file` (audio or video recorded from
the stream, 30–90 s recommended, ≤ 15 MB; webm/opus from `MediaRecorder` is fine), `video_start_ms`
(video time when recording **actually started**, e.g. at `MediaRecorder` `onstart`), `apply`
(default `true`: set `sub_offset_ms` when confident), `search_ms` (default 120000: search ± this
around the current offset). Playback must run at 1× without seeking or pausing while recording.
Pick a part with dialogue (not the opening song).
```json
{"offset_ms":3140,"previous_offset_ms":0,"applied":true,"confident":true,"confidence":7.8,"runner_up":3.1,
 "correlation":0.23,"speech_ms":24310,"sample_ms":60000,"lines_in_window":21,"detail":"ok"}
```
Not confident → `applied:false`, `offset_ms` is the best guess, `detail` says why (too little
speech, too few lines nearby, no clear match). 422 = unreadable audio. ~1 s per minute of audio.

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
- `zipf` = general word frequency (wordfreq, Zipf 0–8: 5+ everyday, 3–4 less common, <3 rare,
  0 unknown). **Rank which unknown words to highlight by `zipf`, highest first.** `common` =
  JMdict common flag (secondary).

### `POST /episodes/{id}/reprocess` → `EpisodeCreated`
Re-tokenizes the stored lines with the current tokenizer + dictionary (needed after server
updates such as name detection). Line ids and word statuses are kept. Stored text gets the
current subtitle cleanup too: lines that are only a sound cue (（足音）) are dropped unless a
card uses them, so `line_count` can go down. CLI for all episodes (also re-links words):
`cd server && uv run python -m app.reprocess`.

### `GET /episodes/{id}/missed?limit=30&include_learning=false` → `MissedWord[]`
After an episode: unknown words most worth learning, best first. `score` = `zipf` +
1.5·log2(1 + times in this episode) + 0.5·log2(1 + times in the anime). Names excluded;
`learning` words only with `include_learning=true`.
```json
[{"word":{...WordListItem, "occurrences":30, "zipf":6.76},"score":16.67,"anime_occurrences":30,
  "example":{"line_id":812,"text":"何をするの？","start_ms":61230},
  "gloss_en":"to do; to carry out; to perform","gloss_de":"tun; machen; verrichten"}]
```
Typical UI: list with checkboxes → `POST /words/bulk-status` (known) or `POST /cards` (save).

### `GET /episodes/{id}/understanding` → `Understanding`
```json
{"episode_id":1,"total_tokens":1450,"unique_words":420,"known_tokens":300,"known_unique":60,
 "learning_tokens":40,"learning_unique":12,"token_pct":20.7,"unique_pct":14.3}
```
`token_pct` (weighted by how often words are spoken) is the headline "% understood" number.

## Dictionary
### `GET /dictionary/lookup?q=<text>&reading=<hiragana>&word_id=<id>&limit=5` → `LookupResult`
Use the token's `lemma` + `lemma_reading` **and `word_id`**: the entry the server linked to that
word (via Sudachi's kanji form, e.g. いる → 居る, こと → 事) comes first, which is the only way
to get kana homophones right. Matches kanji or kana forms. Best entry first.
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
- `sort=frequency`: by general frequency (`zipf`), highest first. Items carry `zipf`.
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

## Subtitle search (Jimaku)
Needs `SENSEI_JIMAKU_API_KEY` on the server (503 otherwise; 502 if jimaku.cc rejects it or is down).

### `GET /subs/search?q=<title>` (or `?anilist_id=`) → `JimakuEntry[]`
`[{"id":729,"name":"Sousou no Frieren","english_name":"Frieren: Beyond Journey's End","japanese_name":"葬送のフリーレン","anilist_id":154587,"movie":false}]`

### `GET /subs/{entry_id}/files?episode=<n>` → `JimakuFile[]` (best first)
```json
[{"name":"[SubsPlease] Sousou no Frieren - 01 (1080p) [F02B9CEE]_ja.srt","size":23195,
  "last_modified":"2024-03-03T14:43:52Z","format":"srt","supported":true,"episode":1,
  "multi_episode":false,"web_source":true,"dual_language":false,"recommended":true}]
```
Ranking: importable single-episode text subs from web releases first (Crunchyroll/SubsPlease,
Netflix, Amazon…: free streaming sites re-host these, so timing matches), then TV rips (AT-X),
then Blu-ray; dual-language files (`_ja-en`, `[CHS, JPN]`, `dual_language:true`: they would
import English/Chinese lines) are never recommended; multi-episode bundles (`01-04`), image subs (`.sup`) and
`.7z`/`.rar` last with `supported:false` or `multi_episode:true`. At most one `recommended`.
Omit `episode` to list every file of the entry.

### `POST /episodes/from-jimaku` body `{"entry_id":729,"file_name":"<JimakuFile.name>","episode_number"?:1,"anime_title"?:str}` → 201 `EpisodeCreated`
Downloads the file (only files listed for that entry), unpacks `.zip` (picks the file for
`episode_number`), and imports it like `POST /episodes`. Defaults: `episode_number` guessed from
the file name, `anime_title` = English title (else romaji). The anime is matched by AniList id,
so episodes from Jimaku and manual uploads with the same title end up together.
422: unsupported format / ambiguous zip / no Japanese lines.

## Activity + progress (heatmap, streak, "% understood" trend)
Days are the server's local date (the owner's day).

### `POST /activity/watch` body `{"episode_id":1,"seconds":30}` → `{"day":"2026-11-21","seconds_today":1830}`
Extension heartbeat while the video **plays** with the overlay attached: send the seconds since
the last heartbeat (1–600), e.g. every 30 s and once on pause/tab close. Not while paused.

### `GET /activity?from=YYYY-MM-DD&to=YYYY-MM-DD` → `ActivityOut`
Defaults: `to` = today, `from` = 364 days before (a year heatmap).
```json
{"from_day":"2025-11-22","to_day":"2026-11-21","active_days":3,"current_streak":2,"longest_streak":2,
 "totals":{"minutes":12,"reviews":5,"words_added":1,"words_known":3},
 "days":[{"day":"2026-11-21","minutes":2,"reviews":0,"words_added":1,"words_known":3}]}
```
`days` lists **only active days** (fill the gaps with 0 in the heatmap). A day is active with any
minutes, reviews, cards added or words known. `minutes` = watched with the overlay;
`words_added` = cards created; `words_known` = words that became known (marked Known, bulk, or
graduated by reviews). `current_streak` stays alive until today ends.

### `GET /anime` → `AnimeOut[]`
`[{"id":1,"title":"Frieren: Beyond Journey's End","title_jp":"葬送のフリーレン","anilist_id":154587,
"episode_count":3,"unique_words":980,"known_unique":120,"token_pct":34.2,"unique_pct":12.2}]`
(stats over all its episodes' words combined).

### `GET /anime/{id}/progress` → `AnimeProgress`
`{"anime":{...AnimeOut},"series":[{"day":"2026-11-20","token_pct":20.1,"unique_pct":8.0,"unique_words":980,"known_unique":78}, …],
"episodes":[{"episode_id":1,"number":1.0,"title":null,"token_pct":40.5,"unique_pct":18.0,"minutes_watched":24}]}`
`series` = one point per day the anime was touched (import, watching, or opening this page),
oldest first: the "% understood over time" line. Episodes are ordered by number.

## LLM: line translations + grammar notes
Any OpenAI-compatible endpoint, set on the server: `SENSEI_LLM_BASE_URL` (e.g. Ollama
`http://localhost:11434/v1`, or the laptop over Tailscale) + `SENSEI_LLM_MODEL`. Unset → 503. To choose a model, `cd server && uv run python -m app.llm_bench
--models a,b --jimaku "<anime>" --episode N` translates real lines with each model (same prompts and
batches) and writes `llm-bench.md`: speed, estimated time per episode, side-by-side EN/DE, one explanation.

### `GET /llm/status` → `{"configured":true,"reachable":true,"model":"qwen2.5:3b","base_url":"…","detail":"ok"}`

### `POST /episodes/{id}/translate` → 202 `TranslationJob` · `GET /episodes/{id}/translate` → `TranslationJob`
Background job (one episode at a time) translating every untranslated line to EN + DE in
batches of 12 with 2 lines of context; results appear in `LineOut.translation_en/de`. Poll GET.
`{"episode_id":1,"total_lines":255,"translated_lines":120,"queued":false,"running":true,"error":null,"failed_lines":0}`
Slow on a small local model: start it before watching. Re-running only does missing lines.

### `POST /lines/{id}/explain?lang=en|de&refresh=false` → `LineExplanation`
`{"line_id":812,"lang":"de","text":"**Übersetzung:** …","model":"qwen2.5:3b","cached":false}`. Markdown
with translation, word breakdown and grammar points; cached per line + language. Can take tens
of seconds uncached: show a spinner.

## Known-word import (Anki / word lists)
All three return `ImportReport`; all accept `dry_run` (preview, nothing saved).
```json
{"total":1840,"matched":1712,"updated":1650,"already":62,"unmatched_count":128,
 "unmatched":["ありがとうございます", "…first 200…"],"skipped_new":310,"dry_run":false,
 "note_types":[{"name":"Japanese vocab","fields":["Meaning","Vocab","Reading"],"field_used":"Vocab","notes":2150}],
 "decks":["Default","Japanese::Core"]}
```
Rules: words are matched like subtitle words (dictionary form), so they're recognised in every
episode. Statuses only go up (new → learning → known); `ignored` is never touched. Phrases and
grammar entries that aren't one word end up in `unmatched`. Imports don't count in the heatmap.

### `POST /import/anki` (multipart) fields `file` (.apkg, ≤ 300 MB), `field`?, `deck`?, `mature_days`? (21), `dry_run`?
Any Anki version (`collection.anki21b` zstd, `anki21`, `anki2`). Studied cards with interval ≥
`mature_days` → `known`, younger studied cards → `learning`, never-studied → skipped
(`skipped_new`). `field` = which note field holds the Japanese word; auto-picked by name
(Vocab/Expression/Word/Front/単語…, else the first field). Suggested UI: dry run → show
`note_types[].fields` with `field_used` preselected + `decks` → confirm.

### `POST /import/anki/cards` body `{"cards":[{"expression":"食べる","interval_days":40,"studied":true}],"mature_days":21,"dry_run":false}`
The same from AnkiConnect on the laptop (`findCards` + `cardsInfo`: word field value, `interval`,
`type != 0` → studied).

### `POST /import/words` body `{"text":"食べる\n海賊\n…","status":"known","dry_run":false}`
One word per line (HTML / `食[た]べる` furigana are cleaned). `status` = `known` or `learning`.

## Anki export
Note type **"Sensei Japanese"**, fields: `Word, Reading, MeaningEN, MeaningDE, Sentence` (Anki
furigana syntax `漢字[かんじ]`, the word in `<b>`), `SentenceRomaji, Screenshot` (`<img>`),
`Audio` (`[sound:…mp3]`), `Clip` (`<video autoplay loop muted>`), `Source` ("Anime · Ep 1 · 3:21"),
`SenseiId`. One "Recognition" card (front: screenshot, word, sentence without furigana).
Media files are named `sensei-<media id>.<ext>`; audio is converted to MP3 for Anki.
Note GUIDs come from the card id: **re-importing a newer export updates notes**, no duplicates.

### `GET /export/anki.apkg?since=<ISO datetime>&deck=Sensei` → `.apkg` file
All cards (or created since). 404 if none. Needs the auth header: in the web app, `fetch` it
and save the blob (`Content-Disposition` has a filename).

### `GET /cards/{id}/anki-note?deck=Sensei` → `AnkiNotePayload` (for AnkiConnect, E-6)
```json
{"note":{"deckName":"Sensei","modelName":"Sensei Japanese","fields":{"Word":"食べる","…":"…"},
  "tags":["sensei","sensei::Frieren"],"options":{"allowDuplicate":false,"duplicateScope":"deck"}},
 "media":[{"filename":"sensei-3.webp","url":"http://<server>:8000/media/3?sig=…"},
          {"filename":"sensei-4.mp3","url":"http://<server>:8000/media/4?sig=…&format=mp3"}]}
```
AnkiConnect sequence on the laptop: `modelNames` → if "Sensei Japanese" is missing,
`createModel` with `GET /anki/model`; `createDeck {deck}`; `storeMediaFile {filename, url}`
for each `media`; `addNote {note}`. A duplicate error from `addNote` means the card is already in Anki.

### `GET /anki/model` → AnkiConnect `createModel` params
`{"modelName":"Sensei Japanese","inOrderFields":[…],"css":"…","isCloze":false,"cardTemplates":[{"Name":"Recognition","Front":"…","Back":"…"}]}`

### `GET /media/{id}?sig=…&format=mp3`
Audio only: MP3 copy (cached), used by the Anki export.
