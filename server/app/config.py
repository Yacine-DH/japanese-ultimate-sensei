from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """Server configuration. Every field can be set via env var `SENSEI_<NAME>` or server/.env."""

    model_config = SettingsConfigDict(env_prefix="SENSEI_", env_file=".env", extra="ignore")

    # Required: the server refuses to start without one (generate: openssl rand -hex 24).
    api_token: str = ""
    # jimaku.cc API key for subtitle search/import (free account → API key).
    jimaku_api_key: str = ""
    # LLM (OpenAI-compatible: Ollama → http://localhost:11434/v1, LM Studio, llama.cpp…).
    # Empty = translations/explanations disabled.
    llm_base_url: str = ""
    llm_model: str = ""
    llm_api_key: str = ""
    llm_timeout_s: float = 900
    # "Explain this line" has someone waiting (the video is paused): give up much earlier.
    llm_explain_timeout_s: float = 120
    # Lines per translation request. Smaller = "Explain line" waits less behind a batch, a bit
    # slower overall (each request repeats the context and names).
    llm_translate_batch: int = 8
    # Translate every imported episode in the background (and resume at startup) when an LLM
    # is configured; the button on the episode page still works when this is off.
    llm_auto_translate: bool = True
    # Speech-to-text (S-10): OpenAI-compatible /v1/audio/transcriptions, e.g. whisper.cpp's
    # whisper-server on the Precision: http://precision:8080/v1
    stt_base_url: str = ""
    stt_model: str = ""
    stt_timeout_s: float = 3600
    # Auto-sync by speech recognition (#147): CPU threads for the ReazonSpeech model in
    # <data_dir>/models/ (python -m app.asr_setup). Missing model → voice activity only.
    asr_threads: int = 2
    # Escape hatch for local development / tests only: run with auth disabled.
    allow_no_auth: bool = False
    data_dir: Path = REPO_ROOT / "data"
    # Additional allowed CORS origins (extension origins + localhost are always allowed).
    cors_origins: list[str] = []
    # Built web app (cd web && pnpm build) served at / ; ignored when the folder is missing.
    web_dist: Path = REPO_ROOT / "web" / "dist"
    # Single-user for now; every user-scoped row carries this id so accounts can come later.
    default_user_id: int = 1

    @property
    def db_path(self) -> Path:
        return self.data_dir / "sensei.sqlite"

    @property
    def dictionary_path(self) -> Path:
        return self.data_dir / "jmdict.sqlite"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"


MIN_TOKEN_LENGTH = 16


def check_auth_settings(settings: Settings) -> None:
    """Fail fast instead of silently serving the vocabulary DB to anyone on the network."""
    token = settings.api_token.strip()
    if not token:
        if settings.allow_no_auth:
            return
        raise RuntimeError(
            "SENSEI_API_TOKEN is not set. Generate one with `openssl rand -hex 24`, put "
            "SENSEI_API_TOKEN=<token> in server/.env and paste the same token into the "
            "extension/web settings. (Local dev only: SENSEI_ALLOW_NO_AUTH=true disables auth.)"
        )
    if len(token) < MIN_TOKEN_LENGTH:
        raise RuntimeError(
            f"SENSEI_API_TOKEN is too short ({len(token)} chars, need ≥ {MIN_TOKEN_LENGTH}). "
            "Generate one with `openssl rand -hex 24`."
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
