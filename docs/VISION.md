# Vision

## The problem
The owner is learning Japanese (≈A1.1: some kana, anime phrases; uses Anki + Duolingo) and watches
a lot of anime with English subtitles on free streaming sites. Goal: **one day understand anime
and Japanese people without subtitles.** Watching with English subs is fun but teaches almost
nothing; classic flashcards are effective but disconnected from the stories you care about.

## The idea
Turn every episode into a lesson without making it stop feeling like watching anime.

1. **Japanese subtitles over the anime** in the browser, with furigana over kanji (hidden
   automatically on words you know) and an optional romaji line.
2. **Hover any word** → the video pauses → meaning (EN + DE), reading, part of speech.
3. **One click saves the word** with the *exact scene*: a screenshot, the character saying the
   line (audio), and a small compressed clip. Remembering *where* you heard a word is what makes it
   stick (photographic/episodic memory).
4. **After the episode**: a "words you missed" list ranked by usefulness, to add in bulk.
5. **Review** with a built-in spaced-repetition system (FSRS) that shows the scene on each card.
   Cards can also be pushed to Anki (AnkiConnect / .apkg) for people who live in Anki.
6. **Progress you can feel**: a GitHub-style activity heatmap and a "% of this episode you
   understand" meter that climbs as you learn. You can see your progress in your favourite shows.

## Principles
- **Personal tool first.** Built for one user and used daily as soon as possible. Accounts,
  hosting, subscriptions and mobile apps come later.
- **Don't fight the beginner.** At A1.1 almost every word is unknown, so highlight only the few
  most useful unknown words per line and let the rest be.
- **Kana over romaji.** Romaji is a toggle and a crutch, not the default.
- **Heavy work on the home server, overnight if needed.** The laptop only overlays and captures.
- **Local first.** Offline dictionary; local LLM for translations; cloud only as an optional add-on.

## Decisions (kickoff, 2026-11-17)
| Topic | Decision |
|---|---|
| Reading aid | Japanese + furigana by default; romaji toggle; furigana auto-hides on known words |
| Gloss languages | English + German (JMdict has both) |
| Where they watch | Free streaming sites → **browser extension** (Edge/Chromium first, Firefox port) |
| Heavy lifting | Home server (subs, NLP, dictionary, LLM, STT later, storage) |
| Transcript source | Japanese subtitle files first (Jimaku API + manual upload); STT fallback later |
| Access | Tailscale + API token |
| Translation | JMdict for words; LLM (local via Ollama, OpenAI-compatible, can point at laptop) for sentences/grammar |
| Anki | Built-in FSRS + AnkiConnect push + .apkg export; import Anki deck as known words |
| Mining | Hover-pause + one-click save **and** post-episode "missed words" list |
| Card content | Screenshot + line audio + compressed short clip + sentence/furigana/meaning |
| Gamification | Activity heatmap + "% understood". No leagues/XP |
| v0.1 scope | Core loop end to end (see TASKS.md Phase 1) |
| Team | Claude Code leads (server, docs); Antigravity builds extension + web app |

## The v0.1 core loop
Pick an episode on the streaming site → the extension finds/uses the Japanese subs → overlay with
furigana and hover meanings → save a few words with screenshot and audio → review them in the web
app the next day → see "% understood" go up for that anime.

## Later
STT for anime without Japanese subs, automatic subtitle sync from audio, LLM sentence
translations and grammar notes, built-in player for downloaded files, accounts and hosting, mobile apps.
