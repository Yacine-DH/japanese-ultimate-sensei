"""Write the OpenAPI contract to docs/openapi.json.  Usage: uv run python -m app.export_openapi"""

import json
import tempfile
from pathlib import Path

from app.config import REPO_ROOT, Settings
from app.main import create_app

if __name__ == "__main__":
    # ignore_cleanup_errors: on Windows the app's SQLite file is still open at this point
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        spec = create_app(Settings(data_dir=Path(tmp), allow_no_auth=True)).openapi()
    out = REPO_ROOT / "docs" / "openapi.json"
    text = json.dumps(spec, indent=2, ensure_ascii=False) + "\n"
    out.write_text(text, encoding="utf-8", newline="\n")  # same bytes on Windows and Linux
    print(f"wrote {out}")
