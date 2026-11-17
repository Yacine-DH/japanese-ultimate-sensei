"""Write the OpenAPI contract to docs/openapi.json.  Usage: uv run python -m app.export_openapi"""

import json
import tempfile
from pathlib import Path

from app.config import REPO_ROOT, Settings
from app.main import create_app

if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        spec = create_app(Settings(data_dir=Path(tmp))).openapi()
    out = REPO_ROOT / "docs" / "openapi.json"
    out.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {out}")
