# Design sources

Pictures that are maintained by hand and do not belong to any one chapter. Nothing here is
referenced from the documentation or the README yet.

## `at-a-glance.svg`

One page for a developer who has the problem this library solves — a serial device that several
tabs of one application need — and wants to see, without reading a chapter, whether it is the
answer. It is a **draft awaiting assessment**; do not link it from the documentation or the README
until that has happened.

It shows, from top to bottom:

1. **One port, many tabs** — the same three tabs and one device twice: refused by Web Serial alone,
   and shared with serial-broker, with a message bus between the tabs.
2. **Where it fits** — the tabs of one origin, each running the application and serial-broker; the
   optional debugging surface beside them; the message bus; the browser APIs underneath (Web
   Serial, Web Locks, `localStorage`); and the devices below the browser. The orange line is the
   one tab that holds the port, from the tab down to the device.
3. **What happens when things move** — four cards in the same visual language: several tabs on one
   device, the tab holding the port closing or crashing, the device being unplugged, and a tab
   limit that gives one tab exclusive use.
4. **Seeing what is happening** — errors, logging, `serial-broker/diagnostics` and the debugging
   surface.
5. **The same calls in every tab** — the setup and subscribe calls, and what the library needs.

### Palette and typography

Both come from the documentation's Read the Docs theme
(`docs/.venv/.../sphinx_rtd_theme/static/css/theme.css`) and its Pygments style, so the picture and
a documentation page read as one.

| Colour                        | Role in the picture                             | Where it comes from             |
| ----------------------------- | ----------------------------------------------- | ------------------------------- |
| `#2980b9`                     | Header band, accents, links in the theme        | Theme navigation and link blue  |
| `#6ab0de` / `#e7f2fa`         | The message bus, and anything it touches        | Theme note admonition           |
| `#f0b37e` / `#ffedcc`         | The tab that holds the port, and Web Locks      | Theme warning admonition        |
| `#f29f97` / `#fdf3f2`         | Web Serial alone: the problem                   | Theme danger admonition         |
| `#1abc9c` / `#dbfaf4`         | With serial-broker: the answer                  | Theme tip admonition            |
| `#9b59b6` / `#f4ecf7`         | Diagnostics and the debugging surface           | Theme visited-link violet       |
| `#e74c3c`                     | The cross on a route that does not exist        | Theme inline-code red           |
| `#404040` / `#555555`         | Text, secondary text                            | Theme body text                 |
| `#e1e4e5` / `#f3f6f6`         | Borders, quiet fills                            | Theme borders and table stripes |
| `#fcfcfc`                     | The page behind everything                      | Theme content background        |
| `#007020` `#4070a0` `#208050` | Keywords, strings and numbers in the code block | Pygments `sphinx` style         |

Two colours are darkened versions of theme colours, because theme values meant for backgrounds do
not carry enough contrast as small text: `#a8640a` and `#7a4a08` for text on the warning orange,
`#7d3c98` for the violet.

Typography is the theme's: Lato for prose, Roboto Slab for headings, a monospace stack for code and
status names. Neither web font is loaded — the picture has no external resources — so a machine
without them falls back to Arial and Georgia. The layout was measured in both cases and has room
for the wider fallback.

### Rules the file keeps

- A `viewBox` of `0 0 760 1792` and a matching `width`/`height`. 760 units wide means the picture is
  still legible when the documentation's 800 px content column scales it down, and it renders at its
  own size in a GitHub README.
- Real `<text>`, no text as paths, nothing below 12 px in those 760 units.
- `<title>` and `<desc>`, referenced by `aria-labelledby`, so screen readers get the whole picture.
- No external resources at all: no web fonts, no images, no scripts.
- Groups are positioned with `transform="translate(…)"` and everything inside them uses local
  coordinates, so a section can be moved without recomputing it.

### Checking a change

Check that it is well-formed XML, and look at it:

```powershell
([xml](Get-Content design/at-a-glance.svg -Raw)).DocumentElement.Name

# Headless Edge screenshots a page, not an SVG file, so wrap the file in one line of HTML first.
'<!doctype html><meta charset="utf-8"><style>html,body{margin:0}</style>' +
  (Get-Content design/at-a-glance.svg -Raw) | Set-Content -Encoding utf8 render.html
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu `
  --window-size=760,1800 --screenshot=at-a-glance.png render.html
```

Render it at 696 px as well — the width the documentation gives it — by putting `svg{width:696px}`
in that style attribute, and read the small labels there. Labels that outgrow their box are easier
to find by measuring than by looking: in the same wrapper page, `getBoundingClientRect()` over every
`<text>` reports what is too wide, with `--dump-dom` to get the numbers back out. Do not commit any
of this: neither the PNG nor the wrapper.

### Embedding it, once it has been assessed

In the README, where GitHub renders the file directly:

```md
![What serial-broker does: one port, shared by every tab of an origin](design/at-a-glance.svg)
```

In the documentation, copy it to `docs/site/_static/at-a-glance.svg` — Sphinx copies what is under
the site directory, not what is beside it — and reference it from a chapter:

```md
![What serial-broker does: one port, shared by every tab of an origin](_static/at-a-glance.svg)
```

The alternative text has to say what the picture claims, because the picture's own `<desc>` is not
read by every reader.
