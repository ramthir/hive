import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from src.application.diagrams.service import (DiagramFailed, DiagramService, DiagramTooLarge, DiagramUnavailable,
                                              MAX_SOURCE_LENGTH)

FAKE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>'


class FakeRunner:
    """Stands in for `java -jar plantuml.jar`; records what it was asked to run."""

    def __init__(self, stdout=FAKE_SVG, stderr="", exc=None):
        self.calls, self.stdout, self.stderr, self.exc = [], stdout, stderr, exc

    def __call__(self, cmd, data, env, timeout):
        self.calls.append({"cmd": cmd, "source": data.decode(), "env": env, "timeout": timeout})
        if self.exc:
            raise self.exc
        return subprocess.CompletedProcess(cmd, 0, self.stdout.encode(), self.stderr.encode())


@pytest.fixture
def parts(tmp_path):
    notes = tmp_path / "notes"
    notes.mkdir()
    java = tmp_path / "java"
    java.write_text("")
    jar = tmp_path / "plantuml.jar"
    jar.write_text("")
    runner = FakeRunner()
    svc = DiagramService(str(java), jar, notes, runner=runner)
    return svc, runner, notes, tmp_path


def test_renders_through_java_in_the_sandbox(parts):
    svc, runner, _, _ = parts
    assert svc.render("@startuml\nA -> B\n@enduml") == FAKE_SVG
    call = runner.calls[0]
    assert call["cmd"][-5:] == ["-pipe", "-tsvg", "-charset", "UTF-8"][-4:] or "-pipe" in call["cmd"]
    assert "-pipe" in call["cmd"] and "-tsvg" in call["cmd"]
    assert call["env"]["PLANTUML_SECURITY_PROFILE"] == "SANDBOX"  # the renderer itself may not read files or fetch URLs
    assert call["timeout"] == 30.0


def test_identical_source_is_cached(parts):
    svc, runner, _, _ = parts
    for _ in range(3):
        svc.render("@startuml\nA -> B\n@enduml")
    assert len(runner.calls) == 1
    svc.render("@startuml\nA -> C\n@enduml")
    assert len(runner.calls) == 2
    assert svc.metrics.counters["diagram_cache_hits"] == 2


def test_cache_is_bounded(parts):
    svc, runner, notes, tmp = parts
    small = DiagramService(svc.java, svc.jar, notes, runner=runner, cache_size=2)
    for name in "abc":
        small.render(f"@startuml\n{name} -> z\n@enduml")
    small.render("@startuml\na -> z\n@enduml")  # evicted by now: renders again
    assert len(runner.calls) == 4


def test_include_of_a_notes_folder_file_is_inlined(parts):
    svc, runner, notes, _ = parts
    (notes / "dark.puml").write_text("skinparam backgroundColor #2d2a2e")
    svc.render("@startuml\n!include dark.puml\nA -> B\n@enduml")
    assert "skinparam backgroundColor #2d2a2e" in runner.calls[0]["source"]
    assert "!include" not in runner.calls[0]["source"]


def test_the_bundled_monokai_theme_wins_over_a_copy_in_the_notes_folder(parts):
    """Same rule as Pandora: `!include monokai-theme.puml` always means the bundled theme, so a stale copy can't shadow it."""
    svc, runner, notes, _ = parts
    (notes / "monokai-theme.puml").write_text("' STALE COPY")
    svc.render("@startuml\n!include monokai-theme.puml\nA -> B\n@enduml")
    src = runner.calls[0]["source"]
    assert "STALE COPY" not in src and "Monokai Theme Configuration" in src


def test_nested_includes_resolve_and_cycles_do_not_loop(parts):
    svc, runner, notes, _ = parts
    (notes / "a.puml").write_text("' in a\n!include b.puml")
    (notes / "b.puml").write_text("' in b\n!include a.puml")  # cycle
    svc.render("@startuml\n!include a.puml\n@enduml")
    src = runner.calls[0]["source"]
    assert "' in a" in src and "' in b" in src and src.count("' in a") == 1


def test_includes_cannot_escape_the_notes_folder_or_read_other_file_types(parts):
    svc, runner, notes, tmp = parts
    (tmp / "outside.puml").write_text("' SECRET")
    (notes / "note.md").write_text("# private note")
    (notes / "link.puml").symlink_to(tmp / "outside.puml")
    for target in ["../outside.puml", str(tmp / "outside.puml"), "link.puml", "note.md", "http://example.com/x.puml", "<aws/ec2>"]:
        svc.render(f"@startuml\n!include {target}\nA -> B\n@enduml")
        src = runner.calls[-1]["source"]
        assert "SECRET" not in src and "private note" not in src, target
        assert f"!include {target}" in src  # left as written; the sandboxed renderer will not read it either


def test_bundled_monokai_theme(parts):
    svc, runner, _, _ = parts
    svc.render("@startuml\n!theme monokai-pro\nA -> B\n@enduml")
    assert "!theme" not in runner.calls[0]["source"] and "skinparam" in runner.calls[0]["source"]
    svc.render("@startuml\n!theme cerulean\nA -> B\n@enduml")  # any other theme is PlantUML's own
    assert "!theme cerulean" in runner.calls[1]["source"]


def test_limits_and_failures(parts):
    svc, runner, notes, tmp = parts
    with pytest.raises(DiagramFailed):
        svc.render("   ")
    with pytest.raises(DiagramTooLarge):
        svc.render("x" * (MAX_SOURCE_LENGTH + 1))
    assert runner.calls == []
    with pytest.raises(DiagramFailed, match="no image"):
        DiagramService(svc.java, svc.jar, notes, runner=FakeRunner(stdout="", stderr="boom")).render("@startuml\n@enduml")
    with pytest.raises(DiagramFailed, match="longer than"):
        DiagramService(svc.java, svc.jar, notes, runner=FakeRunner(exc=subprocess.TimeoutExpired("java", 30))).render("@startuml\n@enduml")
    with pytest.raises(DiagramUnavailable):
        DiagramService(svc.java, svc.jar, notes, runner=FakeRunner(exc=OSError("no such file"))).render("@startuml\n@enduml")


def test_unavailable_without_java_or_the_jar(tmp_path):
    notes = tmp_path
    no_java = DiagramService(None, tmp_path / "x.jar", notes, runner=FakeRunner())
    assert no_java.status()["available"] is False and "Java" in no_java.status()["reason"]
    java = tmp_path / "java"
    java.write_text("")
    no_jar = DiagramService(str(java), tmp_path / "missing.jar", notes, runner=FakeRunner())
    assert "plantuml.jar" in no_jar.status()["reason"]
    with pytest.raises(DiagramUnavailable):
        no_jar.render("@startuml\nA -> B\n@enduml")


# --- the real thing: runs only where a JRE and plantuml.jar are installed --------------------------------------------

REAL_JAVA = os.environ.get("PLANTUML_JAVA")
REAL_JAR = os.path.expanduser(os.environ.get("PLANTUML_JAR", "~/.local/share/hive/plantuml/plantuml.jar"))
needs_java = pytest.mark.skipif(not (REAL_JAVA and Path(REAL_JAVA).is_file() and Path(REAL_JAR).is_file()),
                                reason="needs PLANTUML_JAVA and plantuml.jar")


@needs_java
@pytest.mark.parametrize("source,expected", [
    ("@startuml\nAlice -> Bob: hello\n@enduml", "Alice"),
    ("@startmindmap\n* root\n** child\n@endmindmap", "child"),
    ("@startuml\nclass Order\nclass Line\nOrder --> Line\n@enduml", "Order"),  # no Graphviz needed
])
def test_real_plantuml_renders_the_diagram_kinds_in_the_vault(tmp_path, source, expected):
    svc = DiagramService(REAL_JAVA, REAL_JAR, tmp_path)
    svg = svc.render(source)
    assert svg.startswith("<svg") and expected in svg


@needs_java
def test_real_plantuml_inlines_a_theme_include_and_reports_syntax_errors_as_an_image(tmp_path):
    (tmp_path / "dark.puml").write_text("skinparam backgroundColor #112233")
    svc = DiagramService(REAL_JAVA, REAL_JAR, tmp_path)
    assert "#112233" in svc.render("@startuml\n!include dark.puml\nA -> B\n@enduml").lower() or "112233" in svc.render("@startuml\n!include dark.puml\nA -> B\n@enduml")
    bad = svc.render("@startuml\nthis is not valid ((( \n@enduml")
    assert bad.startswith("<svg")  # PlantUML draws its own syntax-error image


def _connector_paths(svg: str) -> list[list[tuple[float, float]]]:
    out = []
    for d in re.findall(r'<path[^>]* d="([^"]+)"', svg):
        nums = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", d)]
        out.append(list(zip(nums[0::2], nums[1::2])))
    return out


@needs_java
def test_real_class_diagram_connectors_are_boxed_when_the_theme_asks_for_ortho(tmp_path):
    """The Monokai theme sets `LineType ortho`. Only Graphviz honours it; without `dot` PlantUML falls back to a
    layout that draws diagonal connectors, so a missing Graphviz must fail loudly rather than quietly look wrong."""
    assert shutil.which("dot") or os.environ.get("GRAPHVIZ_DOT"), (
        "Graphviz is not installed, so the theme's boxed (ortho) connectors cannot be drawn. "
        "Install it (apt-get install graphviz) or set GRAPHVIZ_DOT.")
    svc = DiagramService(REAL_JAVA, REAL_JAR, tmp_path)
    svg = svc.render("@startuml\n!include monokai-theme.puml\nclass Customer\nclass Order\nclass Line\n"
                     "Customer --> Order\nCustomer --> Line\nOrder *-- Line\n@enduml")
    connectors = [p for p in _connector_paths(svg) if len(p) >= 4]
    assert len(connectors) >= 3
    for path in connectors:
        for (x1, y1), (x2, y2) in zip(path, path[1:]):
            assert abs(x1 - x2) < 0.5 or abs(y1 - y2) < 0.5, f"diagonal segment {(x1, y1)} -> {(x2, y2)}"


def _png(width, height):
    return b"\x89PNG\r\n\x1a\n" + b"\0\0\0\rIHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\0\0\0"


def png_parts(tmp_path, natural):
    notes = tmp_path / "notes"
    notes.mkdir(exist_ok=True)
    (tmp_path / "java").write_text("")
    (tmp_path / "plantuml.jar").write_text("")
    runner = FakeRunner()
    svc = DiagramService(str(tmp_path / "java"), tmp_path / "plantuml.jar", notes, runner=runner)
    runner.png = natural
    original = runner.__call__

    def call(cmd, data, env, timeout):
        original(cmd, data, env, timeout)
        return subprocess.CompletedProcess(cmd, 0, runner.png, b"")

    svc._runner = call
    return svc, runner


def test_png_is_rendered_again_at_300_dpi_when_it_fits(tmp_path):
    svc, runner = png_parts(tmp_path, _png(400, 300))
    assert svc.render_png("@startuml\nA -> B\n@enduml").startswith(b"\x89PNG")
    assert [c["cmd"][-4:-1] for c in runner.calls] == [["-pipe", "-tpng", "-charset"]] * 2
    assert "skinparam dpi 300" in runner.calls[1]["source"] and "skinparam dpi" not in runner.calls[0]["source"]
    assert "DiagramBorderColor transparent" in runner.calls[0]["source"]


def test_png_dpi_is_lowered_so_a_large_diagram_is_not_cut_off(tmp_path):
    svc, runner = png_parts(tmp_path, _png(2000, 500))  # 300 dpi would be 6250 px wide
    svc.render_png("@startuml\nA -> B\n@enduml")
    assert "skinparam dpi 192" in runner.calls[1]["source"]
    svc, runner = png_parts(tmp_path, _png(4200, 500))  # already past the limit at the default dpi
    svc.render_png("@startuml\nA -> B\n@enduml")
    assert len(runner.calls) == 1


def test_png_keeps_a_dpi_the_author_chose_and_light_theme_defines_the_light_palette(tmp_path):
    svc, runner = png_parts(tmp_path, _png(400, 300))
    svc.render_png("@startuml\nskinparam dpi 150\nA -> B\n@enduml", theme="light")
    assert len(runner.calls) == 1
    src = runner.calls[0]["source"]
    assert src.index("!define THEME_LIGHT") < src.index("skinparam dpi 150")


def test_png_failures(tmp_path):
    svc, runner = png_parts(tmp_path, b"not an image")
    with pytest.raises(DiagramFailed):
        svc.render_png("@startuml\nA -> B\n@enduml")
    with pytest.raises(DiagramFailed):
        svc.render_png("  ")
    with pytest.raises(DiagramUnavailable):
        DiagramService(None, None, tmp_path).render_png("@startuml\nA\n@enduml")
