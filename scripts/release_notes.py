"""Release notes for a Sensei release from the first-parent history of master.

Usage: python3 scripts/release_notes.py <version> [<previous-tag>]
Reads `git log --first-parent` itself; prints Markdown. Kept separate from release.sh so the
formatting is unit-tested (server/tests/test_updater_scripts.py).
"""

import re
import subprocess
import sys

MERGE = re.compile(r"^Merge pull request #(\d+) from \S+")
SQUASH = re.compile(r"^(.*?)\s*\(#(\d+)\)$")


def changes(log: str) -> list[str]:
    """`log` = records of 'subject\\x1fbody' separated by \\x1e → one bullet per PR or commit."""
    out = []
    for rec in log.split("\x1e"):
        rec = rec.strip("\n")
        if not rec:
            continue
        subject, _, body = rec.partition("\x1f")
        subject = subject.strip()
        if m := MERGE.match(subject):
            title = next((ln.strip() for ln in body.splitlines() if ln.strip()), "")
            out.append(f"- {title or subject} (#{m.group(1)})")
        elif m := SQUASH.match(subject):
            out.append(f"- {m.group(1)} (#{m.group(2)})")
        elif not subject.startswith("Merge "):
            out.append(f"- {subject}")
    return out


def notes(version: str, prev: str | None, bullets: list[str], server: str) -> str:
    since = f"since {prev}" if prev else "(first release; recent changes)"
    lines = [
        f"Sensei {version}: browser extension builds plus everything merged {since}.",
        "",
        "## Update",
        "- **Laptop (Edge/Chrome):** click **Update now** in the Sensei popup. One-time setup if the "
        "button asks for it:",
        "  ```powershell",
        f"  iwr {server}/downloads/install-updater.ps1 -OutFile $env:TEMP\\i.ps1; "
        "powershell -ExecutionPolicy Bypass -File $env:TEMP\\i.ps1",
        "  ```",
        "- **Manual:** unzip `sensei-extension-*-chrome.zip` below over your extension folder, then "
        "Reload in `edge://extensions`.",
        "- **Server and web app:** already deployed on the home server.",
        "",
        "## Changes",
        *(bullets or ["- Maintenance only."]),
    ]
    return "\n".join(lines) + "\n"


def main() -> None:
    version = sys.argv[1]
    prev = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
    server = sys.argv[3] if len(sys.argv) > 3 else "http://barkhausstr64:8000"
    rng = [f"{prev}..HEAD"] if prev else ["-n", "15", "HEAD"]
    log = subprocess.run(
        ["git", "log", "--first-parent", "--format=%s%x1f%b%x1e", *rng],
        check=True, capture_output=True, text=True,
    ).stdout  # fmt: skip
    sys.stdout.write(notes(version, prev, changes(log), server))


if __name__ == "__main__":
    main()
