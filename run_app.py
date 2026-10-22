"""Launch the InfraScan dashboard with one command."""

from __future__ import annotations

import argparse
import os
import threading
import webbrowser
from pathlib import Path

import uvicorn

from infrascan.config import PROJECT_ROOT

BANNER = r"""
  ___        __             ____
 |_ _|_ _   / _|_ __ ___   / ___|  ___ __ _ _ __
  | || ' \ |  _| '__/ _ \  \___ \ / __/ _` | '_ \
  | || |_) || | | | |  __/   ___) | (_| (_| | | | |
 |___| .__/ |_| |_|  \___|  |____/ \___\__,_|_| |_|
     |_|
"""


def _open_browser(url: str) -> None:
    try:
        webbrowser.open(url)
    except Exception:
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the InfraScan road-inspection dashboard.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Interface to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind (default: 8000)")
    parser.add_argument(
        "--weights",
        default=None,
        help="Path to a compatible checkpoint (default: weights/best.pt)",
    )
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser window")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    args = parser.parse_args(argv)

    os.chdir(PROJECT_ROOT)
    if args.weights:
        os.environ["INFRASCAN_WEIGHTS"] = str(Path(args.weights).expanduser().resolve())

    display_host = "localhost" if args.host in {"127.0.0.1", "0.0.0.0"} else args.host
    url = f"http://{display_host}:{args.port}"

    print(BANNER)
    print("  InfraScan · Road Intelligence Dashboard")
    print(f"  Dashboard : {url}")
    print(f"  API docs  : {url}/api/docs")
    print("  Press Ctrl+C to stop.\n")

    if not args.no_browser:
        threading.Timer(1.5, _open_browser, args=(url,)).start()

    uvicorn.run(
        "app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
