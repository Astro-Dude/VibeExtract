#!/usr/bin/env python3
"""Assemble the VibeExtract Claude Code PLUGIN bundle from the canonical skills.

The app ships ONE folder — a local plugin *marketplace* — under
`src-tauri/resources/plugin/`. On launch the app runs `claude plugin marketplace add`
+ `claude plugin install replicate-ui@echo` so an end user who installs only
the desktop app gets the `/replicate-ui` (+ `/replicate-ui-watch`) skills AND the
echo MCP server, with no manual `~/.claude/skills` copying or `claude mcp add`.

Layout produced:
  resources/plugin/                          <- marketplace root
    .claude-plugin/marketplace.json
    replicate-ui/                            <- the plugin
      .claude-plugin/plugin.json             <- bundles skills + MCP servers (echo on by default)
      skills/replicate-ui/      (SKILL.md + _shared)
      skills/replicate-ui-watch/(SKILL.md)

Run from anywhere: python3 desktop/app/build-plugin.py
Then validate:     claude plugin validate src-tauri/resources/plugin
"""
import json, os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "src-tauri", "resources")
# canonical skill source = the latest bundled skills (resources/<skill>)
SKILL_SRC = {"replicate-ui": os.path.join(RES, "replicate-ui"),
             "replicate-ui-watch": os.path.join(RES, "replicate-ui-watch")}
PLUGIN_NAME = "replicate-ui"
MARKETPLACE = "echo"
VERSION = "1.0.0"

out_mkt = os.path.join(RES, "plugin")
out_plugin = os.path.join(out_mkt, PLUGIN_NAME)
out_skills = os.path.join(out_plugin, "skills")

def _ignore(_dir, names):
    return [n for n in names if n in ("__pycache__", ".DS_Store") or n.endswith(".pyc")]

# fresh build
if os.path.isdir(out_mkt):
    shutil.rmtree(out_mkt)
os.makedirs(os.path.join(out_mkt, ".claude-plugin"))
os.makedirs(os.path.join(out_plugin, ".claude-plugin"))
os.makedirs(out_skills)

# copy the canonical skills into the plugin (single bundled copy lives here)
for name, src in SKILL_SRC.items():
    if not os.path.isfile(os.path.join(src, "SKILL.md")):
        sys.exit(f"ERROR: canonical skill missing: {src}/SKILL.md")
    shutil.copytree(src, os.path.join(out_skills, name), ignore=_ignore)

# plugin manifest — bundles BOTH skills + the MCP servers (echo on by default)
plugin_json = {
    "name": PLUGIN_NAME,
    "description": "Replicate a running macOS app's UI as self-verified HTML+CSS via the "
                   "VibeExtract + Playwright MCP loop. Bundles the /replicate-ui and "
                   "/replicate-ui-watch skills and the echo MCP server.",
    "version": VERSION,
    "author": {"name": "VibeExtract"},
    "keywords": ["ui", "replicate", "macos", "screenshot", "accessibility", "mcp"],
    "mcpServers": {
        "echo": {"type": "http", "url": "http://127.0.0.1:8765/mcp"},
        "playwright": {"command": "npx", "args": ["@playwright/mcp@latest", "--headless", "--isolated"]}
    }
}
with open(os.path.join(out_plugin, ".claude-plugin", "plugin.json"), "w") as f:
    json.dump(plugin_json, f, indent=2)

# local marketplace pointing at the plugin by relative path
marketplace_json = {
    "name": MARKETPLACE,
    "owner": {"name": "VibeExtract"},
    "metadata": {"description": "VibeExtract desktop app plugins"},
    "plugins": [
        {"name": PLUGIN_NAME, "source": f"./{PLUGIN_NAME}",
         "description": "Replicate a running macOS app's UI as self-verified HTML+CSS.",
         "category": "design"}
    ]
}
with open(os.path.join(out_mkt, ".claude-plugin", "marketplace.json"), "w") as f:
    json.dump(marketplace_json, f, indent=2)

print(f"built plugin marketplace at {out_mkt}")
print(f"  plugin: {PLUGIN_NAME}@{MARKETPLACE} v{VERSION}")
print(f"  skills: {', '.join(SKILL_SRC)}")
print(f"  mcp:    echo (http://127.0.0.1:8765/mcp), playwright")

# Keep the repo-local dev copy (.claude/skills/<skill>) in sync with canonical,
# so editing canonical + running this script updates ALL three copies — the
# .claude copy was hand-synced before and drifted.
repo_root = os.path.dirname(os.path.dirname(HERE))
dev_skills = os.path.join(repo_root, ".claude", "skills")
if os.path.isdir(dev_skills):
    for name, src in SKILL_SRC.items():
        dst = os.path.join(dev_skills, name)
        if os.path.isdir(src):
            if os.path.isdir(dst):
                shutil.rmtree(dst)
            shutil.copytree(src, dst, ignore=_ignore)
    print(f"  dev:    synced {', '.join(SKILL_SRC)} -> {dev_skills}")
