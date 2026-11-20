import subprocess

import pytest

from src.domain.notes.errors import GitError
from src.infrastructure.git.client import GitClient


@pytest.fixture
def client(tmp_path):
    for a in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.com"]):
        subprocess.run(["git", "-C", str(tmp_path), *a], check=True)
    return GitClient(tmp_path)


def test_is_repo(client, tmp_path_factory):
    assert client.is_repo()
    assert not GitClient(tmp_path_factory.mktemp("plain")).is_repo()


def test_commit_paths_returns_sha_then_none(client):
    (client.root / "a.md").write_text("1")
    sha = client.commit_paths(["a.md"], "first")
    assert sha and len(sha) == 40
    assert client.commit_paths(["a.md"], "again") is None


def test_error_is_wrapped(client):
    with pytest.raises(GitError):
        client.show("deadbeef", "a.md")
