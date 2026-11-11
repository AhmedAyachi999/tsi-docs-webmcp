# TSI Docs WebMCP (Chrome extension)

Exposes [TSI-DOCUMENTATION](https://docs.tsi.com.tn/) (a BookStack site with the TSI-ERP user guides) to
in-browser AI agents through **WebMCP** (`navigator.modelContext` / `document.modelContext`).

The extension injects a content script into the page's own JavaScript context (`"world": "MAIN"`) on
`https://docs.tsi.com.tn/*` and registers the tools listed below. Every request is a same-origin `fetch` that uses
the visitor's session. Anonymous visitors get the public content and logged-in users get what their account can see.
No API token is used and no data leaves the browser.

## Tools

| Tool | Read-only | Purpose |
|---|---|---|
| `tsi_search_docs` | yes | Full-text search (`query`, `type`, `page`), BookStack syntax supported (`"phrase"`, `[tag]`, `{in_name:x}`) |
| `tsi_list_books` | yes | Books and shelves |
| `tsi_get_book_contents` | yes | Book → chapters → pages (default `guide-dutilisation`) |
| `tsi_get_chapter` | yes | Pages of a chapter |
| `tsi_get_page_outline` | yes | Heading tree with the site's 1. / 1.1. numbering and section sizes |
| `tsi_read_page` | yes | Markdown/plain text of a page, chapter or book. Options: `section`, `offset`/`max_chars` paging, `include_images` |
| `tsi_recently_updated` | yes | Recently updated pages |
| `tsi_list_tags` | yes | Tags (the site currently has none) |
| `tsi_get_current_page` | yes | What the user is viewing: type, title, breadcrumbs, selected text, login state, optionally the content |
| `tsi_open_page` | no | Navigates the tab to a docs.tsi.com.tn URL (other origins are rejected) |

Pages may be given as a full URL, a path (`/books/guide-dutilisation/page/calcul-de-paie`) or the shorthand
`guide-dutilisation/calcul-de-paie`.

## Quick start (dedicated profile)

Double-click `launch-tsi-chrome.cmd` in the project root. It starts a separate Chrome profile
(`%LOCALAPPDATA%\TSIWebMCP\ChromeProfile`) with the WebMCP flag on and the extension loaded, and opens the docs.
Chrome 137+ ignores `--load-extension`, so the script loads the extension through the DevTools protocol, which lasts
one session. Start that profile with the script each time. While that window is open it listens on a local
debugging port (127.0.0.1:9333), so use that profile only for the docs.

In Chrome 157 the API is `document.modelContext`, with `registerTool`, `getTools` and `executeTool(registeredTool, jsonString)`.

## Install in your normal profile (permanent)

1. Use Chrome 146 or later and enable `chrome://flags/#enable-webmcp-testing`, then restart Chrome.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select this `extension` folder.
3. Open https://docs.tsi.com.tn/. The DevTools console shows `[TSI WebMCP] registered 10/10 tools.`

## Test

- Install the **Model Context Tool Inspector** extension from the Chrome WebMCP early preview to list and run the tools.
- From the DevTools console:
  ```js
  navigator.modelContextTesting?.listTools()
  await TSIWebMCP.call("tsi_search_docs", { query: "calcul de paie" })
  await TSIWebMCP.call("tsi_get_page_outline", { page: "guide-dutilisation/calcul-de-paie" })
  await TSIWebMCP.call("tsi_read_page", { page: "guide-dutilisation/calcul-de-paie", section: "Pointage" })
  ```
  `TSIWebMCP.call` also works when the WebMCP flag is off.

## Notes

- The site's `/export/*` endpoints are rate-limited (HTTP 429). Responses are cached for 5 minutes, and a 429 is
  retried twice with backoff. Use `tsi_get_page_outline` with `section` reads rather than reading huge pages in full.
- If the WebMCP API changes shape again, update `src/register.js`. It already detects `registerTool` +
  `unregisterTool`, `registerTool(tool, { signal })` and the older `provideContext({ tools })`.

## Files

- `manifest.json`: MV3 manifest with a content script in the MAIN world.
- `src/bookstack.js`: BookStack client (HTML parsing, export, outline and section extraction, caching).
- `src/tools.js`: WebMCP tool definitions (names, descriptions, JSON schemas, annotations).
- `src/register.js`: feature-detects the WebMCP API, registers the tools and exposes `window.TSIWebMCP`.
