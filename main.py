"""Entry point for Hive Notes: serves the app on port 80 (override with PORT / HOST)."""
import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "src.api.main:create_app",
        factory=True,
        # No authentication yet, so default to this machine only. Set HOST=0.0.0.0 to expose it on the network.
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "80")),
        proxy_headers=False,
        # Force-close lingering client connections after 5s so shutdown finishes promptly.
        timeout_graceful_shutdown=5,
    )
