"""Runs the Node unit tests in tests/js so one `pytest` covers the frontend modules too."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_node_unit_tests_pass():
    proc = subprocess.run(["node", "--test", "tests/js/"], cwd=ROOT, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout[-3000:] + proc.stderr[-1500:]
