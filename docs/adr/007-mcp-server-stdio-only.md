# ADR 007 — MCP server: stdio only for Phase 5

- **Status:** accepted
- **Date:** 2026-04-25
- **Deciders:** core
- **Context tag:** mcp, transport

## Context

`gks-mcp-server` (D.1) needs a transport. The `@modelcontextprotocol/sdk`
ships three:

1. **Stdio** (`StdioServerTransport`) — child-process JSON-RPC over
   stdin/stdout. Standard for desktop MCP clients (Claude Code, Cursor).
2. **SSE** (`SSEServerTransport`) — single-connection server-sent
   events. Common for web hosts.
3. **Streamable HTTP** (`streamableHttp`) — multi-connection,
   resumable. Newer; more deployment surface.

## Decision

Ship **stdio only** for Phase 5. The primary use case is "spawn a child
process per Claude Code window"; that's what stdio is for. The SSE +
HTTP transports add a non-trivial server runtime (Express / Hono /
similar) that we don't need to validate the core tool surface.

If a hosted-server use case shows up post-release we'll add HTTP
behind a `--transport=http --port=...` flag.

## Consequences

**Positive**
- One entry point (`bin/gks-mcp-server.ts`), no web server needed,
  no auth story to design.
- Matches the install instructions every MCP client doc page expects.
- Tests use `InMemoryTransport` from the SDK — no actual process
  spawn, fast (~5 ms per test).

**Negative**
- Each Claude Code window spawns its own GKS server process. Heavier
  if you have ~20 windows open; on the other hand, perfect tenant
  isolation by construction.
- No server-side auth — relies on the client's process identity
  (typically OS user). Fine for single-user desktops; SaaS would
  need HTTP + auth, which is out of scope here.

## References

- `bin/gks-mcp-server.ts` — entry point
- `src/mcp-server/index.ts` — `createGksMcpServer` + `runGksMcpServerStdio`
- [MCP transport docs](https://modelcontextprotocol.io/docs/concepts/transports)
