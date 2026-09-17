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
    # Fragments the benchmarks generate (bench/), included by performance.md rather than pages.
    "_generated",
]

# typedoc links to headings inside its generated pages; MyST needs anchors for them.
myst_heading_anchors = 4
myst_enable_extensions = ["colon_fence", "deflist", "fieldlist"]

pygments_style = "sphinx"
highlight_language = "ts"

html_theme = "sphinx_rtd_theme"
html_title = f"serial-broker {release}"
# The product's icon, above the search box and in the browser tab. One file for the repository.
html_logo = "../icon.svg"
html_favicon = "../icon.svg"
html_theme_options = {
    "navigation_depth": 3,
    "collapse_navigation": False,
    "sticky_navigation": True,
}
html_show_sourcelink = False

# Keeps pages from scrolling sideways; see the stylesheet for what it changes and why.
html_static_path = ["_static"]
html_css_files = ["serial-broker.css"]
# Adds the arrow back to the top of the navigation; see the file for what it does and why.
html_js_files = ["serial-broker.js"]

# Copied to the root of the built site. `serve.json` turns off the clean URLs of `npx serve`, which
# would redirect .../index/index.html - the generated reference of the `index` entry point - to its
# parent folder and break every relative link from there. Without clean URLs `serve` lists a folder
# instead of opening its index.html, so the folders a reader types in are rewritten to theirs.
html_extra_path = ["_extra"]

# `npm run docs:links` checks that the links out of this documentation still lead somewhere. The
# repository's own links are skipped: it is private, so an unauthenticated check is answered with
# 404 for every one of them - fourteen findings that say nothing about the links and would bury a
# real one. They are checked by the build instead, which fails on a path that does not exist.
linkcheck_ignore = [r"https://github\.com/tkrepo1234/serial-broker/.*"]
# One at a time, and slowly: GitHub rate-limits an unauthenticated caller, and a check that is
# throttled into failures reports the throttling rather than the links.
linkcheck_timeout = 20
linkcheck_retries = 2
