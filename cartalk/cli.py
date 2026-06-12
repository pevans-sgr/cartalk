"""cartalk command-line interface.

    cartalk version
    cartalk db list
    cartalk db show <platform-id>
    cartalk scan --adapter elm327 --port /dev/ttyUSB0 --vehicle chrysler/pacifica_2018
    cartalk diagnose <scan.json> [--vehicle ...]

`version`, `db list`, and `db show` work with no hardware and no optional deps.
`scan` needs an adapter (and the relevant transport extra); `diagnose` needs the
`ai` extra.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import __version__
from .db import list_platforms, load_platform


def _cmd_version(args) -> int:
    print(f"cartalk {__version__}")
    return 0


def _cmd_db(args) -> int:
    if args.db_command == "list":
        ids = list_platforms()
        if not ids:
            print("no vehicle definitions found")
            return 0
        for pid in ids:
            print(pid)
        return 0
    if args.db_command == "show":
        try:
            platform = load_platform(args.platform)
        except FileNotFoundError as e:
            print(e, file=sys.stderr)
            return 1
        print(f"{platform.make} {platform.model} ({platform.platform})")
        if platform.notes:
            print(f"  note: {platform.notes.strip()}")
        for m in platform.modules:
            print(f"  [{m.id}] {m.name}  req={m.request_id:#x} resp={m.response_id:#x}")
            for did in m.dids:
                print(f"      DID {did.id:#06x} {did.name} ({did.kind}, {did.decode})")
        return 0
    print("usage: cartalk db {list|show}", file=sys.stderr)
    return 2


def _cmd_scan(args) -> int:
    from .scanner.scan import scan_platform, enrich_descriptions

    try:
        platform = load_platform(args.vehicle)
    except FileNotFoundError as e:
        print(e, file=sys.stderr)
        return 1

    transport = _build_transport(args.adapter, args.port, args.log)
    try:
        with transport:
            results = scan_platform(transport, platform, read_data=args.data)
    except Exception as e:
        print(f"scan failed: {e}", file=sys.stderr)
        return 1

    enriched = enrich_descriptions(results, platform)
    if args.json:
        json.dump({"vehicle": args.vehicle, "modules": enriched}, sys.stdout, indent=2)
        print()
        return 0

    for mod in enriched:
        status = "OK" if mod["reachable"] else "UNREACHABLE"
        print(f"\n[{mod['module_id']}] {mod['name']}  ({status})")
        if mod["error"]:
            print(f"    note: {mod['error']}")
        if not mod["dtcs"]:
            print("    no codes")
        for d in mod["dtcs"]:
            desc = f" — {d['description']}" if d.get("description") else ""
            flags = f" [{', '.join(d['flags'])}]" if d["flags"] else ""
            print(f"    {d['code']}{desc}{flags}")
    return 0


def _cmd_live(args) -> int:
    import time
    from .scanner.scan import read_live

    try:
        platform = load_platform(args.vehicle)
    except FileNotFoundError as e:
        print(e, file=sys.stderr)
        return 1

    transport = _build_transport(args.adapter, args.port, args.log)
    try:
        with transport:
            while True:
                data = read_live(transport, platform, module_id=args.module)
                if args.json:
                    json.dump(data, sys.stdout, indent=2, default=str)
                    print()
                else:
                    for mod_id, values in data.items():
                        print(f"[{mod_id}]")
                        for name, value in values.items():
                            print(f"    {name}: {value}")
                    if not data:
                        print("(no live DIDs read)")
                if not args.watch:
                    break
                time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        print(f"live read failed: {e}", file=sys.stderr)
        return 1
    return 0


def _cmd_serve(args) -> int:
    # Configure the ASGI app via environment, then run uvicorn.
    import os
    os.environ["CARTALK_ADAPTER"] = args.adapter
    if args.usb_fd is not None:
        os.environ["CARTALK_USB_FD"] = str(args.usb_fd)
    if args.tcp:
        os.environ["CARTALK_TCP"] = args.tcp
    if args.port_path:
        os.environ["CARTALK_PORT"] = args.port_path
    try:
        import uvicorn
    except ImportError:
        print("serve needs the api extra: pip install 'cartalk[api]'", file=sys.stderr)
        return 1
    print(f"cartalk serving on http://{args.host}:{args.port}  (adapter: {args.adapter})")
    print("open that URL in your phone's browser")
    uvicorn.run("cartalk.api.server:app", host=args.host, port=args.port, log_level="info")
    return 0


def _cmd_diagnose(args) -> int:
    from .ai.diagnose import diagnose

    with open(args.scan_file) as f:
        scan = json.load(f)
    # Accept either the full {"vehicle","modules"} envelope or a bare modules list.
    vehicle = args.vehicle or (scan.get("vehicle", "") if isinstance(scan, dict) else "")
    payload = scan.get("modules", scan) if isinstance(scan, dict) else scan
    try:
        print(diagnose(payload, vehicle=vehicle))
    except Exception as e:
        print(f"diagnosis failed: {e}", file=sys.stderr)
        return 1
    return 0


def _build_transport(adapter: str, port: str | None, log: str | None = None):
    if adapter == "elm327":
        if not port:
            raise SystemExit("elm327 adapter needs --port")
        from .transport.elm327 import Elm327Transport
        transport = Elm327Transport(port)
    else:
        raise SystemExit(f"unknown adapter {adapter!r}")
    if log:
        from .transport.transcript import TranscriptTransport
        transport = TranscriptTransport(transport, log)
    return transport


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="cartalk", description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("version").set_defaults(func=_cmd_version)

    db = sub.add_parser("db", help="inspect vehicle definitions")
    db_sub = db.add_subparsers(dest="db_command", required=True)
    db_sub.add_parser("list", help="list available platforms")
    show = db_sub.add_parser("show", help="show one platform's modules")
    show.add_argument("platform")
    db.set_defaults(func=_cmd_db)

    scan = sub.add_parser("scan", help="all-module fault scan")
    scan.add_argument("--vehicle", required=True, help="platform id, e.g. chrysler/pacifica_2018")
    scan.add_argument("--adapter", default="elm327", choices=["elm327"])
    scan.add_argument("--port", help="serial port, e.g. /dev/ttyUSB0")
    scan.add_argument("--data", action="store_true", help="also read named live DIDs")
    scan.add_argument("--json", action="store_true", help="emit JSON")
    scan.add_argument("--log", metavar="FILE", help="append a JSONL transcript of every exchange")
    scan.set_defaults(func=_cmd_scan)

    live = sub.add_parser("live", help="read live data (DIDs) from one or all modules")
    live.add_argument("--vehicle", required=True, help="platform id, e.g. chrysler/pacifica_2018")
    live.add_argument("--adapter", default="elm327", choices=["elm327"])
    live.add_argument("--port", help="serial port, e.g. /dev/ttyUSB0")
    live.add_argument("--module", help="limit to one module id, e.g. bcm")
    live.add_argument("--watch", action="store_true", help="repeat until interrupted")
    live.add_argument("--interval", type=float, default=1.0, help="seconds between --watch reads")
    live.add_argument("--json", action="store_true", help="emit JSON")
    live.add_argument("--log", metavar="FILE", help="append a JSONL transcript of every exchange")
    live.set_defaults(func=_cmd_live)

    serve = sub.add_parser("serve", help="run the web UI + HTTP API (for the phone browser)")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--adapter", default="loopback",
                       choices=["loopback", "android-usb", "tcp", "elm327"])
    serve.add_argument("--usb-fd", type=int, help="USB file descriptor (android-usb; set by termux-serve.sh)")
    serve.add_argument("--tcp", metavar="HOST:PORT", help="WiFi/bridge adapter address (tcp)")
    serve.add_argument("--port-path", metavar="PATH", help="serial port (elm327)")
    serve.set_defaults(func=_cmd_serve)

    diag = sub.add_parser("diagnose", help="AI-assisted diagnosis of a scan JSON file")
    diag.add_argument("scan_file")
    diag.add_argument("--vehicle", default="")
    diag.set_defaults(func=_cmd_diagnose)

    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
