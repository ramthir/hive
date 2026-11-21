import json
import subprocess

import pytest
from fastapi.testclient import TestClient

from src.api.main import create_app


class FakeRunner:
    def __init__(self):
        self.prompts, self.sessions = [], []

    def run(self, prompt, session=None):
        self.prompts.append(prompt)
        self.sessions.append(session)
        yield {"type": "step", "id": "1", "tool": "read_note", "label": "Reading alpha", "write": False, "status": "running"}
        yield {"type": "message", "text": "It says **first**."}
        yield {"type": "done", "usage": {}}


@pytest.fixture
def runner():
    return FakeRunner()


@pytest.fixture
def client(tmp_path, runner):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        subprocess.run(["git", "-C", str(tmp_path), *a], check=True, capture_output=True)
    with TestClient(create_app(tmp_path, watch=False, chat_runner=runner)) as c:
        yield c


def events(response):
    return [json.loads(l[6:]) for l in response.text.splitlines() if l.startswith("data: ")]


def test_status_says_codex_is_available(client):
    assert client.get("/api/chat/status").json() == {"available": True, "reason": None}


def test_status_without_codex(tmp_path, monkeypatch):
    for a in (["init", "-q", "-b", "main"],):
        subprocess.run(["git", "-C", str(tmp_path), *a], check=True, capture_output=True)
    monkeypatch.setattr("src.api.main.codex_program", lambda configured=None: None)
    body = TestClient(create_app(tmp_path, watch=False)).get("/api/chat/status").json()
    assert body["available"] is False and "Codex" in body["reason"]


def test_a_question_streams_steps_the_answer_and_the_end(client, runner):
    r = client.post("/api/chat", json={"messages": [{"role": "user", "content": "what does alpha say?"}]})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    assert [e["type"] for e in events(r)] == ["step", "message", "done"]
    assert "what does alpha say?" in runner.prompts[0]


def test_earlier_turns_are_sent_back_by_the_page(client, runner):
    client.post("/api/chat", json={"messages": [{"role": "user", "content": "first q"}, {"role": "assistant", "content": "first a"}, {"role": "user", "content": "and then?"}]})
    assert "User: first q" in runner.prompts[0] and "Assistant: first a" in runner.prompts[0]


def test_nothing_is_stored(client, tmp_path):
    client.post("/api/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert [p.name for p in tmp_path.iterdir()] == [".git"]


def test_a_bad_body_is_refused(client):
    assert client.post("/api/chat", json={"messages": []}).status_code == 422
    assert client.post("/api/chat", json={"messages": [{"role": "system", "content": "x"}]}).status_code == 422


def test_the_chat_page_is_served(client):
    assert client.get("/chat").status_code == 200


SESSION = "01a1fe57-662c-77f0-bf0c-d522d9b8d05b"


def test_the_session_comes_back_with_the_next_question_and_only_the_question_is_sent(client, runner):
    client.post("/api/chat", json={"messages": [{"role": "user", "content": "first q"}, {"role": "assistant", "content": "first a"}, {"role": "user", "content": "and then?"}], "session": SESSION})
    assert runner.sessions == [SESSION]
    assert "and then?" in runner.prompts[0] and "first q" not in runner.prompts[0] and "search_notes" not in runner.prompts[0]


def test_a_session_that_is_not_an_id_is_refused(client, runner):
    for bad in ("--last", "x", SESSION + " --dangerously-bypass-approvals-and-sandbox"):
        assert client.post("/api/chat", json={"messages": [{"role": "user", "content": "hi"}], "session": bad}).status_code == 422
    assert runner.prompts == []
