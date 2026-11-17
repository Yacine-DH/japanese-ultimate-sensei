from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.dictionary import Dictionary, build

FIXTURES = Path(__file__).parent / "fixtures"


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
    (data_dir / "jmdict.sqlite").symlink_to(dict_path)
    return TestClient(create_app(Settings(data_dir=data_dir, api_token=token)))


@pytest.fixture
def client(tmp_path, dict_path) -> TestClient:
    return _make_client(tmp_path, dict_path)


@pytest.fixture
def make_client(tmp_path, dict_path):
    return lambda token="": _make_client(tmp_path, dict_path, token)
