/*
 * WebMCP tool definitions for docs.tsi.com.tn.
 * Each tool returns MCP-style content ({ content: [{ type: "text", text }] }),
 * which Chrome's WebMCP and MCP bridges both forward unchanged.
 */
(function (global) {
  "use strict";
  const B = global.TSIBookStack;

  const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
  const fail = (err) => ({ isError: true, content: [{ type: "text", text: `Error: ${err?.message || err}` }] });
  const wrap = (fn) => async (input = {}, client) => {
    try { return ok(await fn(input || {}, client)); } catch (e) { return fail(e); }
  };

  const READ_ONLY = { readOnlyHint: true };
  const urlProp = (what) => ({
    type: "string",
    description: `${what}: full URL (https://docs.tsi.com.tn/books/...), a site path (/books/...), or the 'book-slug/page-slug' shorthand.`,
  });

  const tools = [
    {
      name: "tsi_search_docs",
      description:
        "Full-text search across TSI-DOCUMENTATION, the user guides for the TSI-ERP suite (paie, GRH, comptabilité, trésorerie, gestion commerciale, immobilisations…). " +
        "Content is mostly in French, so search with French terms (e.g. 'calcul de paie', 'déclaration employeur'). " +
        "Supports BookStack syntax: \"exact phrase\", [tag], [tag=value], {in_name:word}. Returns pages/chapters with URLs and snippets.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms." },
          type: { type: "string", enum: ["all", "page", "chapter", "book", "bookshelf"], description: "Restrict to one content type. Default: all." },
          page: { type: "integer", minimum: 1, description: "Results page (20 per page). Default 1." },
        },
        required: ["query"],
      },
      annotations: READ_ONLY,
      execute: wrap(({ query, type, page }) => B.search({ query, type, page: page || 1 })),
    },
    {
      name: "tsi_list_books",
      description:
        "Lists the books (top-level manuals) shown on TSI-DOCUMENTATION's book index, plus shelves if any exist. " +
        "Search can also return pages from books that are not listed here (e.g. 'conception', 'divers').",
      inputSchema: { type: "object", properties: {} },
      annotations: READ_ONLY,
      execute: wrap(async () => {
        const [{ books }, shelves] = await Promise.all([B.listBooks(), B.listShelves().catch(() => ({ shelves: [] }))]);
        return { books, shelves: shelves.shelves };
      }),
    },
    {
      name: "tsi_get_book_contents",
      description:
        "Returns the table of contents of a book: its chapters (one per TSI-ERP module, e.g. TSI-PAIE, TSI-GRH) and the pages in each, with URLs and short snippets. " +
        "The main book is 'guide-dutilisation'.",
      inputSchema: {
        type: "object",
        properties: { book: { ...urlProp("Book"), default: "guide-dutilisation" } },
      },
      annotations: READ_ONLY,
      execute: wrap(({ book }) => B.getBookContents({ book: book || "guide-dutilisation" })),
    },
    {
      name: "tsi_get_chapter",
      description: "Lists the pages of one chapter (e.g. /books/guide-dutilisation/chapter/tsi-paie).",
      inputSchema: { type: "object", properties: { chapter: urlProp("Chapter") }, required: ["chapter"] },
      annotations: READ_ONLY,
      execute: wrap(({ chapter }) => B.getChapter({ chapter })),
    },
    {
      name: "tsi_get_page_outline",
      description:
        "Returns the heading outline of a page (or whole chapter/book) with the site's numbering (1., 1.1., …) and the size of each section. " +
        "Pages can be very long; call this first, then read one section with tsi_read_page.",
      inputSchema: { type: "object", properties: { page: urlProp("Page, chapter or book") }, required: ["page"] },
      annotations: READ_ONLY,
      execute: wrap(({ page }) => B.getOutline({ page })),
    },
    {
      name: "tsi_read_page",
      description:
        "Reads the content of a page (or an entire chapter/book) as Markdown or plain text. " +
        "Use 'section' to read only one heading's section, and 'offset' with the returned next_offset to page through long content. " +
        "Screenshots are replaced by [image] placeholders unless include_images is true.",
      inputSchema: {
        type: "object",
        properties: {
          page: urlProp("Page, chapter or book"),
          section: { type: "string", description: "Heading title (or part of it) to read only that section. Accent- and case-insensitive." },
          format: { type: "string", enum: ["markdown", "plaintext"], description: "Default markdown." },
          include_images: { type: "boolean", description: "Keep image links in the Markdown. Default false." },
          offset: { type: "integer", minimum: 0, description: "Character offset to start from. Default 0." },
          max_chars: { type: "integer", minimum: 500, maximum: 100000, description: "Maximum characters to return. Default 20000." },
        },
        required: ["page"],
      },
      annotations: READ_ONLY,
      execute: wrap((args) => B.readPage(args)),
    },
    {
      name: "tsi_recently_updated",
      description: "Lists the most recently updated documentation pages.",
      inputSchema: { type: "object", properties: { page: { type: "integer", minimum: 1, description: "Results page. Default 1." } } },
      annotations: READ_ONLY,
      execute: wrap(({ page }) => B.recentlyUpdated({ page: page || 1 })),
    },
    {
      name: "tsi_list_tags",
      description: "Lists the tags used on the documentation, for tag-based search.",
      inputSchema: { type: "object", properties: {} },
      annotations: READ_ONLY,
      execute: wrap(() => B.listTags()),
    },
    {
      name: "tsi_get_current_page",
      description:
        "Describes what the user is looking at right now in this tab: URL, content type (page/chapter/book/search), title, breadcrumbs, " +
        "selected text, and whether they are logged in. Set include_content to also get the page text.",
      inputSchema: {
        type: "object",
        properties: {
          include_content: { type: "boolean", description: "Also return the content (Markdown, first max_chars). Default false." },
          max_chars: { type: "integer", minimum: 500, maximum: 100000, description: "Default 20000." },
        },
      },
      annotations: READ_ONLY,
      execute: wrap(async ({ include_content, max_chars }) => {
        const ctx = B.currentContext();
        if (include_content && ["page", "chapter", "book"].includes(ctx.type)) {
          const r = await B.readPage({ page: ctx.url, max_chars: max_chars || 20000 });
          ctx.content = r.content;
          ctx.total_chars = r.total_chars;
          ctx.next_offset = r.next_offset;
        }
        return ctx;
      }),
    },
    {
      name: "tsi_open_page",
      description:
        "Navigates this tab to a documentation page, chapter, book or search, so the user can see it. Optionally scrolls to a heading anchor. " +
        "Only docs.tsi.com.tn URLs are allowed. The page reloads, so call other tools again afterwards.",
      inputSchema: {
        type: "object",
        properties: {
          url: urlProp("Destination"),
          anchor: { type: "string", description: "Optional element id to scroll to (e.g. 'bkmrk-introduction')." },
        },
        required: ["url"],
      },
      annotations: { readOnlyHint: false },
      execute: wrap(({ url, anchor }) => B.openUrl(url, anchor)),
    },
  ];

  global.TSIWebMCPTools = tools;
})(globalThis);
