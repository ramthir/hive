"""Localhost-only guard: Hive has no login, so a request is served only when it was addressed to this machine.

The check is on the ``Host`` header (and ``Origin`` when a browser sends one), not on the client IP: in a container the
client of a published port is the Docker gateway, never 127.0.0.1. Publish the port on the host's loopback
(``-p 127.0.0.1:80:80``) so nothing else can connect; this guard then refuses any other name or address
(``http://192.168.1.5/``, a DNS name pointing at the machine, a DNS-rebinding page) even if the port is reachable.
"""
from __future__ import annotations

import os
from urllib.parse import urlsplit

LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def allowed_hosts(extra: str | None = None) -> frozenset[str]:
    """localhost, 127.0.0.1 and ::1, plus the comma-separated names in HIVE_ALLOWED_HOSTS (an explicit opt-in)."""
    extra = os.environ.get("HIVE_ALLOWED_HOSTS", "") if extra is None else extra
    return LOCAL_HOSTS | {h.strip().lower() for h in extra.split(",") if h.strip()}


def hostname(value: str) -> str:
    """The host of a ``Host`` header value (``localhost:80``, ``[::1]:80``); empty when it cannot be read."""
    try:
        return (urlsplit("//" + value.strip()).hostname or "").lower()
    except ValueError:
        return ""


class LocalhostOnly:
    """ASGI middleware answering 403 to http/websocket requests whose Host (or Origin) is not an allowed name."""

    def __init__(self, app, hosts: frozenset[str] | None = None):
        self.app = app
        self.hosts = hosts if hosts is not None else allowed_hosts()

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        origin = headers.get("origin")
        ok = hostname(headers.get("host", "")) in self.hosts and (origin is None or hostname(origin.split("://", 1)[-1]) in self.hosts)
        if ok:
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 1008})
        body = b'{"detail":"Hive only answers on localhost"}'
        await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
