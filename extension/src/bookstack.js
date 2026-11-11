/*
 * BookStack client for docs.tsi.com.tn.
 *
 * Runs in the page (MAIN world), so every request is same-origin and carries
 * the visitor's own session: a logged-in user sees what they can see, an
 * anonymous visitor sees the public content. No API token is needed; data
 * comes from the regular HTML views and the built-in export endpoints.
 */
(function (global) {
  "use strict";

  const ORIGIN = "https://docs.tsi.com.tn";

  /** Resolves a URL, a path ("/books/x/page/y") or "book/page" slugs to an absolute same-origin URL. */
  function resolveUrl(input) {
    if (!input || typeof input !== "string") throw new Error("A URL or path is required.");
    let s = input.trim();
    if (!/^https?:\/\//i.test(s) && !s.startsWith("/")) {
      // "book-slug/page-slug" or "book-slug/chapter-slug" shorthand
      const parts = s.split("/").filter(Boolean);
      if (parts.length === 1) s = `/books/${parts[0]}`;
      else if (parts.length === 2) s = `/books/${parts[0]}/page/${parts[1]}`;
      else s = "/" + parts.join("/");
    }
    const url = new URL(s, ORIGIN);
    if (url.origin !== ORIGIN) throw new Error(`Only ${ORIGIN} URLs are allowed, got ${url.origin}.`);
    url.hash = "";
    // Strip trailing export/edit/revisions segments so callers can pass any page URL.
    url.pathname = url.pathname.replace(/\/(export\/[^/]+|edit|revisions.*)\/?$/, "").replace(/\/+$/, "");
    return url;
  }

  /** Classifies a BookStack URL path. */
  function describePath(pathname) {
    let m;
    if ((m = pathname.match(/^\/books\/([^/]+)\/page\/([^/]+)/))) return { type: "page", book: m[1], slug: m[2] };
    if ((m = pathname.match(/^\/books\/([^/]+)\/chapter\/([^/]+)/))) return { type: "chapter", book: m[1], slug: m[2] };
    if ((m = pathname.match(/^\/books\/([^/]+)$/))) return { type: "book", book: m[1], slug: m[1] };
    if ((m = pathname.match(/^\/shelves\/([^/]+)$/))) return { type: "bookshelf", slug: m[1] };
    if (pathname === "/search") return { type: "search" };
    if (pathname === "" || pathname === "/") return { type: "home" };
    return { type: "other" };
  }

  // Small response cache: the export endpoints are rate-limited (HTTP 429),
  // and outline + section reads of one page would otherwise refetch it each time.
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const cache = new Map(); // url -> { at, promise }

  function fetchText(url, signal) {
    const key = String(url);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
    const promise = fetchTextUncached(key, signal);
    cache.set(key, { at: Date.now(), promise });
    promise.catch(() => cache.delete(key));
    if (cache.size > 50) cache.delete(cache.keys().next().value);
    return promise;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchTextUncached(url, signal, attempt = 0) {
    const res = await fetch(url, { credentials: "include", signal, headers: { Accept: "text/html,text/plain,*/*" } });
    if (res.status === 429 && attempt < 2) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * (attempt + 1), 15000));
      return fetchTextUncached(url, signal, attempt + 1);
    }
    if (res.status === 429) throw new Error(`The site is rate-limiting requests (HTTP 429). Wait a minute and retry.`);
    if (res.status === 404) throw new Error(`Not found: ${url}`);
    if (res.status === 401 || res.status === 403) throw new Error(`Access denied (${res.status}) for ${url}. Log in to docs.tsi.com.tn and retry.`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    // BookStack redirects to /login when content needs authentication.
    if (new URL(res.url).pathname === "/login" && new URL(url).pathname !== "/login") {
      throw new Error(`Login required to view ${url}.`);
    }
    return res.text();
  }

  async function fetchDoc(url, signal) {
    return new DOMParser().parseFromString(await fetchText(url, signal), "text/html");
  }

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  /** Parses one `.entity-list-item` anchor (search results, book contents, lists). */
  function parseEntity(a) {
    const snippetEl = a.querySelector(".entity-item-snippet p, .entity-item-snippet .text-muted");
    const path = [];
    a.querySelectorAll(".entity-item-snippet .text-book, .entity-item-snippet .text-chapter").forEach((el) => path.push(clean(el.textContent)));
    const tags = [];
    a.querySelectorAll(".tag-item, .tag").forEach((t) => {
      const name = clean(t.querySelector(".tag-name")?.textContent);
      const value = clean(t.querySelector(".tag-value")?.textContent);
      if (name) tags.push(value ? `${name}: ${value}` : name);
    });
    const entity = {
      type: a.dataset.entityType || [...a.classList].find((c) => ["page", "chapter", "book", "bookshelf"].includes(c)) || "unknown",
      id: a.dataset.entityId ? Number(a.dataset.entityId) : undefined,
      name: clean(a.querySelector(".entity-list-item-name")?.textContent || a.textContent),
      url: a.href,
    };
    if (path.length) entity.location = path.join(" > ");
    const snippet = clean(snippetEl?.textContent);
    if (snippet) entity.snippet = snippet;
    if (tags.length) entity.tags = tags;
    return entity;
  }

  function mainArea(doc) {
    return doc.querySelector("main.content-wrap") || doc.querySelector("main") || doc.querySelector("#main-content") || doc.body;
  }

  function hasNextPage(doc, page) {
    return [...doc.querySelectorAll("a[href*='page=']")].some((a) => {
      try { return Number(new URL(a.href, ORIGIN).searchParams.get("page")) === page + 1; } catch { return false; }
    });
  }

  // ---------------------------------------------------------------- API

  async function search({ query, type, page = 1, signal }) {
    let term = String(query || "").trim();
    if (!term) throw new Error("query must not be empty.");
    if (type && type !== "all") term += ` {type:${type}}`;
    const url = new URL("/search", ORIGIN);
    url.searchParams.set("term", term);
    if (page > 1) url.searchParams.set("page", String(page));
    const doc = await fetchDoc(url, signal);
    const results = [...mainArea(doc).querySelectorAll("a.entity-list-item")].map(parseEntity);
    return { query: term, page, results, has_more: hasNextPage(doc, page) };
  }

  async function listBooks({ signal } = {}) {
    const doc = await fetchDoc(new URL("/books?view=list", ORIGIN), signal);
    const seen = new Set();
    const books = [];
    doc.querySelectorAll("a[href^='" + ORIGIN + "/books/'], a[href^='/books/']").forEach((a) => {
      const u = new URL(a.href, ORIGIN);
      if (!/^\/books\/[^/]+$/.test(u.pathname) || seen.has(u.pathname)) return;
      seen.add(u.pathname);
      const isEntity = a.classList.contains("entity-list-item") || a.closest(".grid-card, .entity-list-item");
      if (!isEntity) return;
      books.push({
        name: clean(a.querySelector(".entity-list-item-name, h2, h3, h4")?.textContent || a.textContent),
        url: u.href,
        slug: u.pathname.split("/")[2],
        description: clean(a.querySelector(".entity-item-snippet, .text-muted, p")?.textContent) || undefined,
      });
    });
    return { books };
  }

  async function listShelves({ signal } = {}) {
    const doc = await fetchDoc(new URL("/shelves?view=list", ORIGIN), signal);
    const shelves = [...mainArea(doc).querySelectorAll("a.entity-list-item, a.grid-card")]
      .filter((a) => /\/shelves\/[^/]+$/.test(new URL(a.href, ORIGIN).pathname))
      .map((a) => ({ name: clean(a.querySelector(".entity-list-item-name, h2")?.textContent || a.textContent), url: a.href }));
    return { shelves };
  }

  async function getBookContents({ book, signal }) {
    const url = resolveUrl(book);
    const info = describePath(url.pathname);
    if (info.type !== "book") throw new Error(`Not a book URL: ${url.href}`);
    const doc = await fetchDoc(url, signal);
    const container = doc.querySelector(".book-contents");
    const contents = [];
    if (container) {
      let currentChapter = null;
      for (const el of container.children) {
        if (el.matches("a.entity-list-item")) {
          const entity = parseEntity(el);
          if (entity.type === "chapter") {
            currentChapter = { ...entity, pages: [] };
            contents.push(currentChapter);
          } else {
            currentChapter = null;
            contents.push(entity);
          }
        } else if (el.matches(".chapter-expansion") && currentChapter) {
          el.querySelectorAll("a.entity-list-item").forEach((p) => currentChapter.pages.push(parseEntity(p)));
        }
      }
    }
    const page_count = contents.reduce((n, e) => n + (e.type === "chapter" ? e.pages.length : 1), 0);
    return {
      book: clean(mainArea(doc).querySelector("h1")?.textContent),
      url: url.href,
      chapter_count: contents.filter((e) => e.type === "chapter").length,
      page_count,
      contents,
    };
  }

  async function getChapter({ chapter, signal }) {
    const url = resolveUrl(chapter);
    if (describePath(url.pathname).type !== "chapter") throw new Error(`Not a chapter URL: ${url.href}`);
    const doc = await fetchDoc(url, signal);
    const main = mainArea(doc);
    return {
      chapter: clean(main.querySelector("h1")?.textContent),
      url: url.href,
      description: clean(main.querySelector(".chapter-content .text-muted, .text-muted.break-text")?.textContent) || undefined,
      pages: [...main.querySelectorAll("a.entity-list-item")].map(parseEntity).filter((e) => e.type === "page"),
    };
  }

  /** Splits markdown into sections keyed by headings. */
  function markdownSections(md) {
    const lines = md.split(/\r?\n/);
    const sections = [];
    let inFence = false;
    lines.forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      const m = !inFence && line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (m) sections.push({ level: m[1].length, title: m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(), line: i });
    });
    return { lines, sections };
  }

  const normalize = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  function extractSection(md, wanted) {
    const { lines, sections } = markdownSections(md);
    const w = normalize(wanted);
    let idx = sections.findIndex((s) => normalize(s.title) === w);
    if (idx < 0) idx = sections.findIndex((s) => normalize(s.title).includes(w));
    if (idx < 0) return null;
    const start = sections[idx];
    const next = sections.slice(idx + 1).find((s) => s.level <= start.level);
    return { title: start.title, markdown: lines.slice(start.line, next ? next.line : lines.length).join("\n") };
  }

  function stripImages(md) {
    // [![alt](img)](link)  and  ![alt](img)
    return md
      .replace(/\[!\[([^\]]*)\]\([^)]*\)\]\([^)]*\)/g, (_, alt) => `[image${alt && alt !== "image.png" ? ": " + alt : ""}]`)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => `[image${alt && alt !== "image.png" ? ": " + alt : ""}]`);
  }

  /** Drops the presentational <span> wrappers the Word import leaves in the export. */
  const stripSpans = (s) => s.replace(/<\/?span\b[^>]*>/gi, "");

  /** BookStack's Markdown export keeps HTML entities (e.g. "Paie &gt; Calcul"). */
  function decodeEntities(s) {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return named[e.toLowerCase()] ?? m;
    });
  }

  async function readPage({ page, format = "markdown", section, include_images = false, offset = 0, max_chars = 20000, signal }) {
    const url = resolveUrl(page);
    const info = describePath(url.pathname);
    if (!["page", "chapter", "book"].includes(info.type)) throw new Error(`Not a page, chapter or book URL: ${url.href}`);
    const exportFormat = format === "plaintext" ? "plaintext" : "markdown";
    let text = decodeEntities(stripSpans(await fetchText(`${url.href}/export/${exportFormat}`, signal)));
    if (exportFormat === "markdown" && !include_images) text = stripImages(text);
    text = text.replace(/\n{3,}/g, "\n\n");

    let title = "";
    if (exportFormat === "markdown") title = (text.match(/^#\s+(.+)$/m) || [])[1] || "";
    let sectionTitle;
    if (section) {
      if (exportFormat !== "markdown") throw new Error("section requires format 'markdown'.");
      const found = extractSection(text, section);
      if (!found) {
        const { sections } = markdownSections(text);
        throw new Error(`Section "${section}" not found. Available headings: ${sections.map((s) => s.title).join(" | ")}`);
      }
      text = found.markdown;
      sectionTitle = found.title;
    }
    const total = text.length;
    const start = Math.max(0, Math.min(offset, total));
    const limit = Math.max(500, Math.min(max_chars, 100000));
    const chunk = text.slice(start, start + limit);
    const end = start + chunk.length;
    return {
      title: title.trim() || undefined,
      type: info.type,
      url: url.href,
      format: exportFormat,
      section: sectionTitle,
      offset: start,
      returned_chars: chunk.length,
      total_chars: total,
      next_offset: end < total ? end : null,
      content: chunk,
    };
  }

  async function getOutline({ page, signal }) {
    const url = resolveUrl(page);
    const info = describePath(url.pathname);
    if (!["page", "chapter", "book"].includes(info.type)) throw new Error(`Not a page, chapter or book URL: ${url.href}`);
    const md = stripImages(decodeEntities(stripSpans(await fetchText(`${url.href}/export/markdown`, signal))));
    const { lines, sections } = markdownSections(md);
    // Numbering mirrors the site's CSS counters (H2 -> "1.", H3 -> "1.1.", ...).
    const counters = [0, 0, 0, 0, 0, 0, 0];
    const outline = sections.map((s, i) => {
      const nextLine = sections[i + 1] ? sections[i + 1].line : lines.length;
      const chars = lines.slice(s.line, nextLine).join("\n").length;
      let number;
      if (s.level >= 2 && s.level <= 5) {
        counters[s.level]++;
        for (let l = s.level + 1; l < counters.length; l++) counters[l] = 0;
        number = counters.slice(2, s.level + 1).join(".") + ".";
      } else if (s.level === 1) {
        counters.fill(0);
      }
      return { level: s.level, number, title: s.title, chars };
    });
    return { url: url.href, type: info.type, total_chars: md.length, headings: outline };
  }

  async function recentlyUpdated({ page = 1, signal } = {}) {
    const url = new URL("/pages/recently-updated", ORIGIN);
    if (page > 1) url.searchParams.set("page", String(page));
    const doc = await fetchDoc(url, signal);
    return {
      page,
      pages: [...mainArea(doc).querySelectorAll("a.entity-list-item")].map(parseEntity),
      has_more: hasNextPage(doc, page),
    };
  }

  async function listTags({ signal } = {}) {
    const doc = await fetchDoc(new URL("/tags", ORIGIN), signal);
    const tags = [];
    mainArea(doc).querySelectorAll(".tag-item, .tag").forEach((t) => {
      const name = clean(t.querySelector(".tag-name")?.textContent || t.textContent);
      const count = clean(t.querySelector(".tag-value, .text-muted")?.textContent);
      if (name) tags.push(count ? { name, count } : { name });
    });
    return { tags, hint: "Search by tag with tsi_search_docs using query '[tag_name]' or '[tag_name=value]'." };
  }

  function currentContext() {
    const url = new URL(location.href);
    const info = describePath(url.pathname.replace(/\/+$/, ""));
    const main = mainArea(document);
    const breadcrumbs = [...document.querySelectorAll(".breadcrumbs a, nav.breadcrumbs a")]
      .map((a) => ({ name: clean(a.textContent), url: a.href }))
      .filter((b) => b.name);
    const loggedIn = !document.querySelector('header a[href$="/login"]');
    const ctx = {
      site: "TSI-DOCUMENTATION (docs.tsi.com.tn) — user guides for the TSI-ERP suite (paie, GRH, comptabilité, gestion commerciale…)",
      url: url.href,
      ...info,
      title: clean(main.querySelector("h1")?.textContent) || document.title,
      logged_in: loggedIn,
    };
    if (breadcrumbs.length) ctx.breadcrumbs = breadcrumbs;
    if (url.hash) ctx.anchor = url.hash;
    if (info.type === "search") ctx.search_term = url.searchParams.get("term");
    const sel = String(getSelection?.() || "").trim();
    if (sel) ctx.selected_text = sel.slice(0, 4000);
    return ctx;
  }

  function openUrl(target, anchor) {
    const url = resolveUrl(target);
    if (anchor) url.hash = anchor.startsWith("#") ? anchor : `#${anchor}`;
    // Defer so the tool result is delivered before the page unloads.
    setTimeout(() => location.assign(url.href), 50);
    return { navigating_to: url.href };
  }

  global.TSIBookStack = {
    ORIGIN, resolveUrl, describePath, search, listBooks, listShelves, getBookContents, getChapter,
    readPage, getOutline, recentlyUpdated, listTags, currentContext, openUrl,
    // exported for tests
    _internal: { stripImages, extractSection, markdownSections, parseEntity },
  };
})(globalThis);
