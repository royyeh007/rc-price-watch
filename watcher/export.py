#!/usr/bin/env python3
"""
Export the dashboard's data as static JSON files (what GitHub Pages serves).

    python export.py <output dir>        writes <output dir>/data/summary.json and data/series/*.json

The React dashboard detects data/summary.json next to it and switches to static mode,
reading these files instead of the local server's API.
"""

import json
import os
import shutil
import sys
from pathlib import Path

from store import build_summary, read_history, series_file, series_for


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "../site").resolve()
    rows = read_history()
    summary = build_summary(rows)
    summary["repo"] = os.environ.get("GITHUB_REPOSITORY", "")
    summary["branch"] = os.environ.get("GITHUB_REF_NAME", "main")

    data = out / "data"
    series_dir = data / "series"
    if series_dir.exists():
        shutil.rmtree(series_dir)
    series_dir.mkdir(parents=True)
    (data / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
    for key in summary["products"]:
        (series_dir / series_file(key)).write_text(json.dumps({"key": key, "series": series_for(rows, key)}),
                                                   encoding="utf-8")
    print(f"exported {len(summary['products'])} products from {len(rows)} checks to {data}")


if __name__ == "__main__":
    main()
