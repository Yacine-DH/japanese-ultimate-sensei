"""Checks for the laptop updater scripts and the release notes (scripts/, run on deploy)."""

import base64
import hashlib
import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def extension_id(public_key_b64: str) -> str:
    """Chromium extension ID: first 32 hex chars of sha256(DER key), mapped 0-f → a-p."""
    digest = hashlib.sha256(base64.b64decode(public_key_b64)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def test_installer_allows_exactly_the_sensei_extension():
    key = re.search(
        r"CHROME_MANIFEST_PUBLIC_KEY =\s*'([^']+)'", (ROOT / "extension/wxt.config.ts").read_text()
    ).group(1)
    installer = (ROOT / "scripts/install-updater.ps1").read_text()
    assert f'$ExtensionId = "{extension_id(key)}"' in installer
    assert "chrome-extension://$ExtensionId/" in installer


def test_host_wrapper_is_crlf_and_runs_the_host_script():
    cmd = (ROOT / "scripts/sensei-updater/sensei-updater.cmd").read_bytes()
    assert b"\r\n" in cmd and b"sensei-updater.ps1" in cmd
    host = (ROOT / "scripts/sensei-updater/sensei-updater.ps1").read_text()
    # stdout carries the native messaging protocol only
    code = [ln for ln in host.splitlines() if not ln.lstrip().startswith("#")]
    assert not [ln for ln in code if re.search(r"\bWrite-(Host|Output)\b", ln)]


def load_notes():
    spec = importlib.util.spec_from_file_location(
        "release_notes", ROOT / "scripts/release_notes.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_release_notes_list_prs_and_commits():
    rn = load_notes()
    log = "\x1e".join(
        [
            "Merge pull request #126 from Yacine-DH/claude/readme-showcase\x1fdocs: README showcase\n",
            "E-14: Extension icon (#125)\x1f",
            "Merge branch 'master' into live\x1f",
            "docs: fix a typo\x1f",
            "",
        ]
    )
    assert rn.changes(log) == [
        "- docs: README showcase (#126)",
        "- E-14: Extension icon (#125)",
        "- docs: fix a typo",
    ]
    text = rn.notes("0.1.33", "v0.1.32", rn.changes(log), "http://server:8000")
    assert "since v0.1.32" in text and "install-updater.ps1" in text and "(#125)" in text
    assert "Maintenance only" in rn.notes("0.1.33", None, [], "http://s")


def test_updater_never_prunes_outside_its_own_file_list():
    host = (ROOT / "scripts/sensei-updater/sensei-updater.ps1").read_text()
    installer = (ROOT / "scripts/install-updater.ps1").read_text()
    # refuses personal folders (Documents, Desktop, OneDrive, ...) and mixed folders
    assert "Get-UnsafeReason" in host and "Get-ForeignEntries" in host
    assert "MyDocuments" in host and "MyDocuments" in installer
    # deletion candidates come only from .sensei-files.txt, never from listing the folder
    assert "foreach ($rel in $previous)" in host
    assert "Get-ChildItem -LiteralPath $folder -Recurse" not in host
    assert ".sensei-files.txt" in installer
