"""Sphinx configuration for the serial-broker developer documentation.

Modelled on the open62541 1.3 documentation: the Read the Docs theme, hand-written chapters, and
an API reference generated from the source comments. Chapters are Markdown (MyST); the API
reference is produced by typedoc into api/reference/ before Sphinx runs. See ADR-0020.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

project = "serial-broker"
author = "serial-broker contributors"
copyright = "2026, serial-broker contributors"
version = PACKAGE["version"]
release = PACKAGE["version"]

extensions = ["myst_parser"]

source_suffix = {".md": "markdown"}
root_doc = "index"
exclude_patterns = [
    "_build",
    "README.md",
    "examples/code",
    # TypeDoc's list of both entry points. The site presents them in separate sections instead.
    "api/reference/index.md",
]

# typedoc links to headings inside its generated pages; MyST needs anchors for them.
myst_heading_anchors = 4
myst_enable_extensions = ["colon_fence", "deflist", "fieldlist"]

pygments_style = "sphinx"
highlight_language = "ts"

html_theme = "sphinx_rtd_theme"
html_title = f"serial-broker {release}"
html_theme_options = {
    "navigation_depth": 3,
    "collapse_navigation": False,
    "sticky_navigation": True,
}
html_show_sourcelink = False

# Keeps pages from scrolling sideways; see the stylesheet for what it changes and why.
html_static_path = ["_static"]
html_css_files = ["serial-broker.css"]
