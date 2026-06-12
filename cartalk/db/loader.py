"""Load platform definitions and decode DID values.

``load_dict`` (pure, stdlib-only) is the heart and is what the tests exercise.
``load_platform`` / ``list_platforms`` add file discovery; YAML parsing uses pyyaml
when available, with a JSON fallback so the loader works even without the optional dep.
"""

from __future__ import annotations

import json
from pathlib import Path

from .models import Platform, Module, Did, Routine

DEFINITIONS_DIR = Path(__file__).parent / "definitions"


def _as_int(value) -> int:
    """Accept ints or hex/decimal strings (YAML/JSON give us either)."""
    if isinstance(value, int):
        return value
    return int(str(value), 0)


def load_dict(data: dict) -> Platform:
    """Build a Platform from a plain dict (as parsed from YAML/JSON). Pure; no I/O."""
    modules = []
    for m in data.get("modules", []):
        dids = [
            Did(id=_as_int(d["id"]), name=d["name"],
                kind=d.get("kind", "live"), decode=d.get("decode", "hex"))
            for d in m.get("dids", [])
        ]
        routines = [
            Routine(id=_as_int(r["id"]), name=r["name"])
            for r in m.get("routines", [])
        ]
        modules.append(Module(
            id=m["id"], name=m["name"],
            request_id=_as_int(m["request_id"]),
            response_id=_as_int(m["response_id"]),
            protocol=m.get("protocol", "uds"),
            dids=dids, routines=routines,
            dtcs=dict(m.get("dtcs", {})),
        ))
    return Platform(
        platform=data["platform"], make=data["make"], model=data["model"],
        year_from=data.get("year_from"), year_to=data.get("year_to"),
        notes=data.get("notes", ""), modules=modules,
    )


def _parse(path: Path) -> dict:
    text = path.read_text()
    if path.suffix == ".json":
        return json.loads(text)
    try:
        import yaml  # optional dependency
    except ImportError as e:
        raise RuntimeError(
            f"reading {path.name} needs pyyaml (pip install pyyaml), "
            "or provide the definition as .json"
        ) from e
    return yaml.safe_load(text)


def load_platform(platform_id: str, base: Path = DEFINITIONS_DIR) -> Platform:
    """Load a platform by id, e.g. 'chrysler/pacifica_2018'."""
    for suffix in (".yaml", ".yml", ".json"):
        path = base / f"{platform_id}{suffix}"
        if path.exists():
            return load_dict(_parse(path))
    raise FileNotFoundError(f"no definition for platform {platform_id!r} under {base}")


def list_platforms(base: Path = DEFINITIONS_DIR) -> list[str]:
    """List available platform ids (relative paths without extension)."""
    if not base.exists():
        return []
    out = set()
    for path in base.rglob("*"):
        if path.suffix in (".yaml", ".yml", ".json"):
            out.add(str(path.relative_to(base).with_suffix("")))
    return sorted(out)


def decode_did_value(raw: bytes, decode: str) -> object:
    """Interpret raw DID bytes per a ``decode`` spec (see docs/database-format.md)."""
    if decode == "bool":
        return any(raw)
    if decode == "uint":
        return int.from_bytes(raw, "big") if raw else 0
    if decode == "ascii":
        return raw.decode("ascii", errors="replace").strip("\x00 ").strip()
    if decode.startswith("enum:"):
        mapping = {}
        for pair in decode[len("enum:"):].split(","):
            if "=" in pair:
                k, v = pair.split("=", 1)
                mapping[int(k.strip(), 0)] = v.strip()
        key = int.from_bytes(raw, "big") if raw else 0
        return mapping.get(key, f"unknown({key})")
    # default / unknown -> raw hex
    return raw.hex()
