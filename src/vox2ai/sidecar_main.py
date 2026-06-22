"""Standalone entrypoint for the vox2ai backend server.

Prints a machine-readable ``server_ready`` JSON event to stdout once the
WebSocket server is listening, then runs until terminated.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json

from vox2ai.config import load_config


def main() -> None:
    parser = argparse.ArgumentParser(description="vox2ai backend sidecar")
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind address (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="Port number (0 = random free port, default: 0)",
    )
    args = parser.parse_args()

    config = load_config()
    config.backend_service.host = args.host
    config.backend_service.port = args.port

    async def _run() -> None:
        from vox2ai.desktop_server import DesktopServer

        server = DesktopServer(config)
        await server.start()

        # Retrieve the actual bound port (the OS-assigned port when port=0).
        bound_port: int = 0
        if server._server is not None:
            sockets = server._server.sockets
            if sockets:
                sockname = sockets[0].getsockname()
                bound_port = sockname[1]

        ready = {
            "type": "server_ready",
            "host": args.host,
            "port": bound_port,
        }
        # Write to stdout so the service manager can read it.
        print(json.dumps(ready), flush=True)

        await asyncio.Future()  # run forever

    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(_run())


if __name__ == "__main__":
    main()
