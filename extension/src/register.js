/*
 * Registers the TSI tools with the browser's WebMCP API.
 *
 * Chrome's implementation has moved between drafts, so this feature-detects:
 *   - document.modelContext / navigator.modelContext
 *   - registerTool(tool) (+ unregisterTool(name)) — current drafts
 *   - provideContext({ tools }) — earliest drafts
 * Enable it in Chrome at chrome://flags/#enable-webmcp-testing.
 */
(function (global) {
  "use strict";
  const TAG = "[TSI WebMCP]";
  const tools = global.TSIWebMCPTools || [];

  // Always expose the tools for manual testing from DevTools:
  //   await TSIWebMCP.call("tsi_search_docs", { query: "paie" })
  global.TSIWebMCP = {
    tools,
    list: () => tools.map((t) => t.name),
    call: async (name, args = {}) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool ${name}`);
      const res = await tool.execute(args, null);
      const text = res.content.map((c) => c.text).join("\n");
      try { return JSON.parse(text); } catch { return text; }
    },
  };

  const mc = global.document?.modelContext || global.navigator?.modelContext;
  if (!mc) {
    console.info(`${TAG} WebMCP API not available. Enable chrome://flags/#enable-webmcp-testing (Chrome 146+). ` +
      `Tools are still callable via TSIWebMCP.call(name, args).`);
    return;
  }

  if (typeof mc.registerTool === "function") {
    const controller = new AbortController();
    let count = 0;
    for (const tool of tools) {
      try {
        try { mc.unregisterTool?.(tool.name); } catch { /* not registered yet */ }
        mc.registerTool(tool, { signal: controller.signal });
        count++;
      } catch (e) {
        console.warn(`${TAG} could not register ${tool.name}:`, e);
      }
    }
    global.TSIWebMCP.unregisterAll = () => {
      controller.abort();
      for (const t of tools) { try { mc.unregisterTool?.(t.name); } catch { /* ignore */ } }
    };
    console.info(`${TAG} registered ${count}/${tools.length} tools.`);
  } else if (typeof mc.provideContext === "function") {
    mc.provideContext({ tools });
    console.info(`${TAG} provided ${tools.length} tools via provideContext().`);
  } else {
    console.warn(`${TAG} modelContext found but has neither registerTool nor provideContext.`);
  }
})(globalThis);
