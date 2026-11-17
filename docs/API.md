# API contract (v0.1.0, Phase 0)

Base URL: `http://<server-tailscale-name>:8000`. Interactive docs at `/docs`; machine-readable
spec in [`openapi.json`](openapi.json) (regenerate with `cd server && uv run python -m app.export_openapi`).

**Auth:** every endpoint except `/health` requires `Authorization: Bearer <token>` (or
`X-Sensei-Token: <token>`) when the server has `SENSEI_API_TOKEN` set. `401` otherwise.
**Times** are integer milliseconds. **Readings** are hiragana. **Errors** are `{"detail": "..."}`.

## Meta
### `GET /health`
`{"status":"ok","version":"0.1.0","dictionary":true,"auth":true}`. `dictionary:false` means
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
 "translation_en":null,"translation_de":null,
 "tokens":[
  {"surface":"食べ","lemma":"食べる","reading":"たべ","lemma_reading":"たべる",
   "pos":"動詞","pos_detail":["一般","下一段-バ行","連用形-一般"],
   "furigana":[{"text":"食","ruby":"た"},{"text":"べ","ruby":null}],
   "romaji":"tabe","is_content":true,"word_id":42,"status":"new","common":true},
  {"surface":"たい","lemma":"たい","reading":"たい","lemma_reading":"たい","pos":"助動詞",
   "pos_detail":["助動詞-タイ","終止形-一般"],"furigana":[{"text":"たい","ruby":null}],"romaji":"tai",
   "is_content":false,"word_id":null,"status":null,"common":false}]}
```
- Concatenating `surface` reproduces `text` exactly (spaces included).
- `is_content` = vocabulary worth learning; only those have `word_id`/`status`.
- `status` ∈ `new | learning | known | ignored`. For highlighting, treat `known`/`ignored` as understood.
- `common` = JMdict common word, the current priority signal for "which unknown words to highlight".

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
### `GET /words/{id}` → `WordOut`
`{"id":42,"lemma":"食べる","reading":"たべる","pos":"動詞","jmdict_id":"1358280","common":true,"status":"new"}`
### `POST /words/{id}/status` body `{"status":"known"}` → `WordOut`

## Coming in Phase 1 (not implemented yet; see TASKS.md)
`/subs/search`, `/episodes/from-jimaku`, `/media`, `/cards`, `/reviews/due`, `/reviews`,
`/activity`, known-word import, Anki export.
