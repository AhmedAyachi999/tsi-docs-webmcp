"""
MCP bridge: exposes the WebMCP tools registered on https://docs.tsi.com.tn/ (by the
TSI Docs WebMCP Chrome extension) to Claude Desktop / Claude Code over stdio.

How it works:
  Claude  --stdio/MCP-->  this bridge  --Chrome DevTools Protocol-->  TSI Chrome window
                                                                       document.modelContext
                                                                       .getTools() / .executeTool()

The tool list and schemas come live from Chrome's WebMCP registry, so the bridge never
duplicates tool logic. If the TSI Chrome window is not open, the bridge starts it with
launch-tsi-chrome.ps1.
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any

import websockets
import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

CDP = "http://127.0.0.1:9333"
SITE = "https://docs.tsi.com.tn/"
HERE = Path(__file__).resolve().parent
LAUNCHER = HERE / "launch-tsi-chrome.ps1"
EXTENSION = HERE / "extension"

logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="[tsi-bridge] %(message)s")
log = logging.getLogger("tsi-bridge")


# ------------------------------------------------------------------ Chrome / CDP

def _http_json(path: str, method: str = "GET", timeout: float = 3) -> Any:
    req = urllib.request.Request(CDP + path, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


async def http_json(path: str, method: str = "GET") -> Any:
    return await asyncio.to_thread(_http_json, path, method)


async def chrome_running() -> dict | None:
    try:
        return await http_json("/json/version")
    except Exception:
        return None


async def ensure_chrome() -> None:
    if await chrome_running():
        return
    log.info("TSI Chrome window not running - starting it with %s", LAUNCHER.name)
    proc = await asyncio.to_thread(
        subprocess.run,
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(LAUNCHER)],
        capture_output=True, text=True, timeout=90,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if proc.returncode != 0 or not await chrome_running():
        raise RuntimeError(f"Could not start the TSI Chrome window: {proc.stderr or proc.stdout}".strip())


async def cdp_call(ws_url: str, method: str, params: dict | None = None, timeout: float = 120) -> dict:
    async with websockets.connect(ws_url, max_size=64 * 1024 * 1024, open_timeout=10) as ws:
        await ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
            if msg.get("id") == 1:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error'].get('message')}")
                return msg["result"]


async def evaluate(ws_url: str, expression: str, timeout: float = 120) -> Any:
    res = await cdp_call(ws_url, "Runtime.evaluate",
                         {"expression": expression, "awaitPromise": True, "returnByValue": True}, timeout)
    if "exceptionDetails" in res:
        d = res["exceptionDetails"]
        raise RuntimeError(d.get("exception", {}).get("description") or d.get("text") or "JavaScript error")
    return res.get("result", {}).get("value")


async def docs_tab() -> str:
    """Returns the DevTools websocket URL of a docs.tsi.com.tn tab, opening one if needed."""
    await ensure_chrome()
    for attempt in range(40):
        targets = await http_json("/json/list")
        page = next((t for t in targets if t.get("type") == "page" and t.get("url", "").startswith(SITE)), None)
        if page:
            return page["webSocketDebuggerUrl"]
        if attempt == 0:
            await http_json("/json/new?" + SITE, method="PUT")
        await asyncio.sleep(0.5)
    raise RuntimeError("Could not open a docs.tsi.com.tn tab in the TSI Chrome window.")


GET_TOOLS_JS = """
(async () => {
  if (!location.href.startsWith('https://docs.tsi.com.tn/') || document.readyState !== 'complete') return [];
  const mc = document.modelContext || navigator.modelContext;
  if (!mc || typeof mc.getTools !== 'function') return null;
  return (await mc.getTools()).map(t => ({
    name: t.name, title: t.title, description: t.description,
    inputSchema: t.inputSchema, annotations: t.annotations }));
})()
"""


async def get_tools(ws_url: str | None = None, wait_s: float = 20) -> tuple[str, list[dict]]:
    ws_url = ws_url or await docs_tab()
    tools: list[dict] | None = None
    for _ in range(int(wait_s / 0.5)):
        try:
            tools = await evaluate(ws_url, GET_TOOLS_JS, timeout=15)
        except Exception as e:  # page navigating / reloading
            log.info("waiting for page: %s", e)
            tools = []
            ws_url = await docs_tab()
        if tools is None:
            raise RuntimeError("WebMCP is not enabled in the TSI Chrome window "
                               "(chrome://flags/#enable-webmcp-testing). Close that window and run launch-tsi-chrome.cmd.")
        if tools:
            return ws_url, tools
        await asyncio.sleep(0.5)
    # Tools missing: the extension is probably not loaded in this session. Try to load it.
    version = await chrome_running()
    try:
        await cdp_call(version["webSocketDebuggerUrl"], "Extensions.loadUnpacked", {"path": str(EXTENSION)})
        await cdp_call(ws_url, "Page.reload")
        await asyncio.sleep(3)
        ws_url = await docs_tab()
        tools = await evaluate(ws_url, GET_TOOLS_JS, timeout=15) or []
    except Exception as e:
        log.info("could not load extension: %s", e)
    if not tools:
        raise RuntimeError("No WebMCP tools on docs.tsi.com.tn. Close the TSI Chrome window and start it "
                           "again with launch-tsi-chrome.cmd (it loads the extension).")
    return ws_url, tools


def call_tool_js(name: str, args: dict) -> str:
    return f"""
(async () => {{
  const mc = document.modelContext || navigator.modelContext;
  const tool = (await mc.getTools()).find(t => t.name === {json.dumps(name)});
  if (!tool) return JSON.stringify({{ isError: true, content: [{{ type: 'text', text: 'Unknown tool ' + {json.dumps(name)} }}] }});
  const args = {json.dumps(args)};
  let r;
  try {{ r = await mc.executeTool(tool, args); }}           // Chrome 157+: input object
  catch (e) {{
    if (!(e instanceof TypeError)) throw e;
    r = await mc.executeTool(tool, JSON.stringify(args));  // earlier drafts: JSON string
  }}
  return typeof r === 'string' ? r : JSON.stringify(r);
}})()
"""


# ------------------------------------------------------------------ MCP server

async def on_list_tools(ctx, params) -> types.ListToolsResult:
    _, tools = await get_tools()
    return types.ListToolsResult(tools=[
        types.Tool(
            name=t["name"],
            title=t.get("title") or None,
            description=t.get("description") or "",
            input_schema=t.get("inputSchema") or {"type": "object", "properties": {}},
            annotations=types.ToolAnnotations(**{
                k: v for k, v in {
                    "read_only_hint": (t.get("annotations") or {}).get("readOnlyHint"),
                }.items() if v is not None
            }) if t.get("annotations") else None,
        )
        for t in tools
    ])


def _to_result(raw: Any) -> types.CallToolResult:
    data = raw
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except ValueError:
            return types.CallToolResult(content=[types.TextContent(type="text", text=raw)])
    if isinstance(data, dict) and isinstance(data.get("content"), list):
        content = [types.TextContent(type="text", text=c.get("text", json.dumps(c)))
                   for c in data["content"] if isinstance(c, dict)]
        return types.CallToolResult(content=content, is_error=bool(data.get("isError")))
    text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, indent=2)
    return types.CallToolResult(content=[types.TextContent(type="text", text=text)])


async def on_call_tool(ctx, params: types.CallToolRequestParams) -> types.CallToolResult:
    try:
        ws_url, _ = await get_tools()
        raw = await evaluate(ws_url, call_tool_js(params.name, params.arguments or {}))
        return _to_result(raw)
    except Exception as e:
        log.exception("tool %s failed", params.name)
        return types.CallToolResult(content=[types.TextContent(type="text", text=f"Error: {e}")], is_error=True)


server = Server(
    "tsi-docs-webmcp",
    version="1.0.0",
    instructions=(
        "Tools for TSI-DOCUMENTATION (docs.tsi.com.tn), the French-language user guides of the TSI-ERP suite "
        "(paie, GRH, comptabilité, trésorerie, gestion commerciale...). Search in French. For long pages, call "
        "tsi_get_page_outline first, then tsi_read_page with a section. Calls run in the user's TSI Chrome window via WebMCP."
    ),
    on_list_tools=on_list_tools,
    on_call_tool=on_call_tool,
)


async def main() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
