from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """Server configuration. Every field can be set via env var `SENSEI_<NAME>` or server/.env."""

    model_config = SettingsConfigDict(env_prefix="SENSEI_", env_file=".env", extra="ignore")

    # Empty token = auth disabled (only acceptable on a trusted network during dev).
    api_token: str = ""
    data_dir: Path = REPO_ROOT / "data"
    # Additional allowed CORS origins (extension origins + localhost are always allowed).
    cors_origins: list[str] = []
    # Single-user for now; every user-scoped row carries this id so accounts can come later.
    default_user_id: int = 1

    @property
    def db_path(self) -> Path:
        return self.data_dir / "sensei.sqlite"

    @property
    def dictionary_path(self) -> Path:
        return self.data_dir / "jmdict.sqlite"

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"


@lru_cache
def get_settings() -> Settings:
    return Settings()
