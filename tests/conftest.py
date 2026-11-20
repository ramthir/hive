# Load .env so the real-PlantUML tests (they need PLANTUML_JAVA and the jar) run on a machine that has them set up
# and skip everywhere else.
from dotenv import load_dotenv

load_dotenv()
