"""Serve the built web app (web/dist) from the API server, on the same origin.

The SPA's routes (/words, /episodes/3, …) overlap API paths, so we decide per request:
browser page loads (`Sec-Fetch-Mode: navigate`, or `Accept: text/html` for old clients) get
index.html; fetch() calls from the app get the API. Real files in dist (assets, favicon)
are served directly. API-only pages (/docs, /redoc, /openapi.json) keep working.
"""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

API_PAGES = ("/docs", "/redoc", "/openapi.json")


def is_page_load(request: Request) -> bool:
    if request.method != "GET":
        return False
    mode = request.headers.get("sec-fetch-mode")
    if mode is not None:
        return mode == "navigate"
    return "text/html" in request.headers.get("accept", "")


def mount_web(app: FastAPI, dist: Path) -> bool:
    index = dist / "index.html"
    if not index.is_file():
        return False
    root = dist.resolve()
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="web-assets")

    @app.middleware("http")
    async def spa(request: Request, call_next):
        path = request.url.path
        if request.method == "GET" and not path.startswith(API_PAGES):
            candidate = (dist / path.lstrip("/")).resolve()
            if path != "/" and candidate.is_file() and candidate.is_relative_to(root):
                return FileResponse(candidate)
            if is_page_load(request):
                return FileResponse(index, headers={"Cache-Control": "no-cache"})
        return await call_next(request)

    return True
