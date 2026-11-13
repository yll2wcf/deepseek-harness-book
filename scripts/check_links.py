#!/usr/bin/env python3
"""Check local publication links and optionally pinned upstream source targets."""
import argparse
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-checkout", type=Path)
    args = parser.parse_args()
    errors, source_targets = [], set()
    count = 0
    for file in sorted(ROOT.rglob("*.md")):
        if set(file.relative_to(ROOT).parts) & {".git", ".venv", "dist", "build"}:
            continue
        content = file.read_text()
        for match in re.finditer(r"!?\[[^\]]*\]\(([^)]+)\)", content):
            target = match[1].strip().strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme:
                source = re.match(r"https://github.com/deepseek-ai/deepseek-harness/(?:blob|tree)/([a-f0-9]{40})/(.+)", target.split("#")[0])
                if source:
                    source_targets.add((source[1], unquote(source[2])))
                continue
            if not parsed.path:
                continue
            actual = (file.parent / unquote(parsed.path)).resolve()
            count += 1
            if not actual.exists():
                errors.append(f"{file.relative_to(ROOT)}: missing {target}")
            elif not actual.is_relative_to(ROOT):
                errors.append(f"{file.relative_to(ROOT)}: outside public repository {target}")
    if args.source_checkout:
        for commit, name in sorted(source_targets):
            result = subprocess.run(["git", "cat-file", "-e", f"{commit}:{name}"], cwd=args.source_checkout, capture_output=True)
            if result.returncode:
                errors.append(f"Missing pinned upstream target: {commit}:{name}")
    print(json.dumps({"local_links": count, "unique_source_targets": len(source_targets),
        "source_objects_checked": bool(args.source_checkout), "errors": errors}, ensure_ascii=False, indent=2))
    raise SystemExit(bool(errors))


if __name__ == "__main__":
    main()
