# Third-party fonts in this directory

These are **test fixtures only**. Nothing here ships in the extension — the extension
contains no bundled fonts at all; it links or fetches whatever the captured page uses.

| File | Font | Licence | Used for |
|---|---|---|---|
| `fixture-sans.woff2` | Inter | [SIL Open Font License 1.1](https://openfontlicense.org) | A genuinely self-hosted `@font-face` with a relative URL, so `@font-face` discovery, URL resolution, the service-worker fetch and the fonts zip can be exercised offline. |
| `private-icons.ttf` | Material Icons | [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) | Registered from JavaScript via the `FontFace` API under a private name, reproducing an icon font that has no discoverable `@font-face` — the condition that makes glyph rasterization necessary. |

Both are redistributable under their licences. Neither is modified.
