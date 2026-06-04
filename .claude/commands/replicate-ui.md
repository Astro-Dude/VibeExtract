---
description: Replicate a running macOS app's UI as self-verified HTML+CSS via the VibeExtract + Playwright MCP loop.
---

Use the **replicate-ui** skill to clone a desktop UI into plain HTML+CSS, driving
the perceive → generate → render → visual-diff loop until it matches.

Target / options (optional): $ARGUMENTS
- A target app or window title (e.g. `Calculator`, `System Settings`). If omitted,
  use the frontmost app (`frontmost_app`).
- An output directory for the generated HTML + screenshots (default: ask, or use
  the VibeExtract captures dir).
- A pass threshold override (default 0.92).

Before starting, verify both MCP servers are connected (`vibe-extract` and
`playwright`). If `vibe-extract` is absent, instruct the user to open the
VibeExtract app → **Start MCP server** → copy the `claude mcp add` command.

Then follow the skill's loop exactly, reporting the final visual-match score per
component and for the composed window.
