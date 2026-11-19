from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

NAV = {"Sec-Fetch-Mode": "navigate", "Accept": "text/html"}


def make(tmp_path, with_dist=True):
    dist = tmp_path / "dist"
    if with_dist:
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><div id=root></div>")
        (dist / "assets" / "app.js").write_text("console.log(1)")
        (dist / "favicon.svg").write_text("<svg/>")
    data = tmp_path / "data"
    data.mkdir()
    return TestClient(create_app(Settings(data_dir=data, web_dist=dist, allow_no_auth=True)))


def test_page_loads_get_the_spa_and_fetches_get_the_api(tmp_path):
    c = make(tmp_path)
    for path in ("/", "/words", "/episodes/3", "/review"):
        r = c.get(path, headers=NAV)
        assert r.status_code == 200 and "id=root" in r.text, path
    assert c.get("/words", headers={"Sec-Fetch-Mode": "cors"}).json()["total"] == 0
    assert c.get("/words").json()["total"] == 0  # plain API client
    assert c.get("/assets/app.js").text == "console.log(1)"
    assert c.get("/favicon.svg").text == "<svg/>"
    assert "swagger" in c.get("/docs", headers=NAV).text.lower()
    assert "id=root" in c.get("/%2e%2e/secret", headers=NAV).text


def test_without_build_api_is_unchanged(tmp_path):
    c = make(tmp_path, with_dist=False)
    assert not c.app.state.web
    assert c.get("/", headers=NAV).status_code == 404
