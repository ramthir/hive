# Load .env so the real-PlantUML tests (they need PLANTUML_JAVA and the jar) run on a machine that has them set up
# and skip everywhere else.
from dotenv import load_dotenv

load_dotenv()

# Starlette's TestClient talks to the host "testserver"; Hive only answers on localhost names (src/api/localhost.py).
import os

os.environ["HIVE_ALLOWED_HOSTS"] = "testserver"

# A developer's .env may pick an agent for the chat and the commit messages; tests must never start a real one.
# (Set, not removed: load_dotenv inside create_app does not override a variable that exists.)
os.environ["HIVE_CHAT_AGENT"] = ""
os.environ["HIVE_COMMIT_MESSAGES"] = ""

# Never touch the real ~/.local/state/hive (Codex session ids, agent reports) from a test.
import tempfile

os.environ["HIVE_STATE_DIR"] = tempfile.mkdtemp(prefix="hive-test-state-")
