"""Entry point for Hive Notes: serves the app on port 80 (override with PORT / HOST)."""
import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "src.api.main:create_app",
        factory=True,
        # Listens on all interfaces (needed inside Docker, where a published port arrives from the gateway). There is
        # no authentication, so the app itself only answers requests addressed to localhost (src/api/localhost.py);
        # publish the port on the host's loopback (-p 127.0.0.1:80:80). HOST=127.0.0.1 also closes the socket.
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "80")),
        proxy_headers=False,
        # Force-close lingering client connections after 5s so shutdown finishes promptly.
        timeout_graceful_shutdown=5,
    )
