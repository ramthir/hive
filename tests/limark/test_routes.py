import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.localhost import LocalhostOnly
from src.api.routes.limark import usage_routes
from tests.limark.test_aws_report import snapshot as aws_snapshot
from tests.limark.test_openai_report import snapshot as openai_snapshot


def test_billing_routes_read_private_snapshots(tmp_path):
    app = FastAPI()
    app.add_middleware(LocalhostOnly)
    app.include_router(usage_routes(tmp_path), prefix="/api/limark")
    client = TestClient(app)
    assert client.get("/api/limark/openai?month=2026-09").json()["status"] == "unavailable"

    (tmp_path / "openai.json").write_text(json.dumps(openai_snapshot()))
    (tmp_path / "aws.json").write_text(json.dumps(aws_snapshot()))
    openai = client.get("/api/limark/openai?month=2026-09")
    aws = client.get("/api/limark/aws?month=2026-10")
    assert openai.json()["models"][0]["input_tokens"] == 100
    assert aws.json()["totals"] == [{"currency": "USD", "amount": "25"}]
    assert openai.headers["Cache-Control"] == aws.headers["Cache-Control"] == "no-store"
    assert client.get("/api/limark/aws?month=2026-13").status_code == 422
    assert client.get("/api/limark/openai", headers={"Host": "example.com"}).status_code == 403
