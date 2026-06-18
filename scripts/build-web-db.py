#!/usr/bin/env python3
"""Convert the source YAML vehicle definitions into the camelCase JSON the web app fetches.

The browser can't parse YAML and GitHub Pages can't run Python, so the static web app
ships JSON. This regenerates web/db/<make>-<model>.json from the canonical definitions in
cartalk/db/definitions/ — run it whenever a definition changes.

    python3 scripts/build-web-db.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cartalk.db.loader import list_platforms, load_platform  # noqa: E402

OUT_DIR = ROOT / "web" / "db"


def platform_to_json(p) -> dict:
    return {
        "platform": p.platform,
        "make": p.make,
        "model": p.model,
        "yearFrom": p.year_from,
        "yearTo": p.year_to,
        "notes": p.notes,
        "modules": [
            {
                "id": m.id,
                "name": m.name,
                "requestId": m.request_id,
                "responseId": m.response_id,
                "protocol": m.protocol,
                "dids": [
                    {"id": d.id, "name": d.name, "kind": d.kind, "decode": d.decode}
                    for d in m.dids
                ],
                "dtcs": dict(m.dtcs),
            }
            for m in p.modules
        ],
    }


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ids = list_platforms()
    if not ids:
        print("no platform definitions found", file=sys.stderr)
        return 1
    manifest = []
    for pid in ids:
        p = load_platform(pid)
        data = platform_to_json(p)
        out = OUT_DIR / f"{pid.replace('/', '-')}.json"
        out.write_text(json.dumps(data, indent=2) + "\n")
        manifest.append({"id": pid, "label": f"{p.make} {p.model}"})
        print(f"wrote {out.relative_to(ROOT)}  ({len(data['modules'])} modules)")
    (OUT_DIR / "index.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {(OUT_DIR / 'index.json').relative_to(ROOT)}  ({len(manifest)} platforms)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
