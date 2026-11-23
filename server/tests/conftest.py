import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.dictionary import Dictionary, build

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def _isolated_settings(monkeypatch):
    """Tests never see the real server/.env or SENSEI_* variables of the shell (#127)."""
    import os

    monkeypatch.setitem(Settings.model_config, "env_file", None)
    for name in list(os.environ):
        if name.startswith("SENSEI_"):
            monkeypatch.delenv(name)


@pytest.fixture(scope="session")
def dict_path(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("dict") / "jmdict.sqlite"
    build([FIXTURES / "jmdict-eng-test.json", FIXTURES / "jmdict-ger-test.json"], out)
    return out


@pytest.fixture
def dictionary(dict_path) -> Dictionary:
    return Dictionary(dict_path)


def _make_client(tmp_path: Path, dict_path: Path, token: str = "") -> TestClient:
    from app.main import create_app

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    try:
        (data_dir / "jmdict.sqlite").symlink_to(dict_path)
    except OSError:  # Windows without symlink privilege: a copy works the same
        shutil.copyfile(dict_path, data_dir / "jmdict.sqlite")
    return TestClient(
        create_app(Settings(data_dir=data_dir, api_token=token, allow_no_auth=not token))
    )


@pytest.fixture
def client(tmp_path, dict_path) -> TestClient:
    return _make_client(tmp_path, dict_path)


@pytest.fixture
def make_client(tmp_path, dict_path):
    return lambda token="": _make_client(tmp_path, dict_path, token)
