import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openDb, type Db } from "../../../server/db"
import { start, type RunningServer } from "../../../server/index"
import { ensureHubToken } from "../../../server/routes/internal"
import { getAgentByTaskRef, insertAgent } from "../../../server/store/agents"
import { sendMessage, receiptState } from "../../../server/core/messaging"
import { retire } from "../../../server/core/agents"

let root: string
let db: Db
let server: RunningServer
let children: ChildProcessWithoutNullStreams[]
function environment(): NodeJS.ProcessEnv { return { ...process.env, AGENTCHAT_HOME: root, AGENTCHAT_URL: server.url } }
function hook(event: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve("adapters/jeikcode/hook.mjs")], { env: environment() })
    children.push(child)
    let stdout = "", stderr = ""
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString() })
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString() })
    const timer = setTimeout(() => { child.kill(); reject(new Error("hook timed out")) }, 12000)
    child.on("error", reject)
    child.on("close", () => { clearTimeout(timer); resolveResult({ stdout, stderr }) })
    child.stdin.end(JSON.stringify(event))
  })
}
function bridge() {
  const child = spawn(process.execPath, [resolve("adapters/jeikcode/mcp-bridge.mjs")], { env: environment() })
  children.push(child)
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let id = 0
  createInterface({ input: child.stdout }).on("line", (line) => {
    const result = JSON.parse(line) as Record<string, unknown>
    const entry = pending.get(Number(result["id"]))
    if (entry) { clearTimeout(entry.timer); pending.delete(Number(result["id"])); entry.resolve(result) }
  })
  return { child, request(method: string, params?: Record<string, unknown>) {
    const requestId = ++id
    return new Promise<Record<string, unknown>>((resolveResult, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`bridge timeout ${method}`)) }, 12000)
      pending.set(requestId, { resolve: resolveResult, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, ...(params ? { params } : {}) })}\n`)
    })
  } }
}
function toolPayload(result: Record<string, unknown>): Record<string, unknown> {
  const body = result["result"] as { content: { text: string }[]; isError?: boolean }
  expect(body.isError).not.toBe(true)
  return JSON.parse(body.content[0]?.text ?? "{}") as Record<string, unknown>
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "jeikcode-live-"))
  db = openDb(join(root, "agentchat.db"))
  ensureHubToken(join(root, "hub_token"))
  children = []
  server = await start({ port: 0, db, home: root, hubTokenPath: join(root, "hub_token"), adapters: [], sessionTtlMs: 1000 })
})
afterEach(async () => {
  for (const child of children) child.kill()
  await Promise.all(children.map((child) => child.exitCode === null ? new Promise<void>((done) => child.once("close", () => done())) : Promise.resolve()))
  await server.close()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe("JeikCode hooks and bridge ↔ real Hub", () => {
  it("rewrites only AgentChat args with real session identity and blocks empty identity", async () => {
    const result = await hook({ hook_event_name: "PreToolUse", session_id: "actual-session", tool_name: "mcp__agentchat__send", tool_input: { to: "human", body: "hi", "x-agentchat-session": "spoofed" } })
    expect(JSON.parse(result.stdout)).toEqual({ action: "modify", args: { to: "human", body: "hi", "x-agentchat-session": "actual-session" } })
    expect(result.stderr).toBe("")
    expect((await hook({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "read_file", tool_input: {} })).stdout).toBe("")
    expect(JSON.parse((await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__agentchat__send" })).stdout)).toMatchObject({ decision: "block" })
  })
  it("registers container and distinct sessions, preserves id on resume and does not retire on end", async () => {
    const result = await hook({ hook_event_name: "SessionStart", session_id: "session-1", cwd: "/project" })
    expect(result.stdout).toContain("additionalContext")
    const first = getAgentByTaskRef(db, "session-1")
    expect(first?.vendor).toBe("jeikcode")
    expect(first?.parentId).toBeTruthy()
    const parent = db.prepare("SELECT role_tag FROM agents WHERE id = ?").get(first?.parentId) as { role_tag: string }
    expect(parent.role_tag).toBe("container")
    await hook({ hook_event_name: "SessionStart", session_id: "session-2" })
    expect(getAgentByTaskRef(db, "session-2")?.id).not.toBe(first?.id)
    await hook({ hook_event_name: "SessionEnd", session_id: "session-1" })
    await hook({ hook_event_name: "SessionStart", session_id: "session-1" })
    expect(getAgentByTaskRef(db, "session-1")?.id).toBe(first?.id)
  })
  it("injects backlog on prompt and moves receipts to delivered, not read", async () => {
    await hook({ hook_event_name: "SessionStart", session_id: "receiver" })
    const target = getAgentByTaskRef(db, "receiver")
    if (!target) throw new Error("missing receiver")
    const sender = insertAgent(db, { name: "sender", kind: "runtime", vendor: "test", status: "online" })
    const sent = sendMessage(db, { from: sender.id, to: target.id, body: "请检查编译结果" })
    const output = await hook({ hook_event_name: "UserPromptSubmit", session_id: "receiver", prompt: "继续" })
    expect(output.stdout).toContain("请检查编译结果")
    expect(output.stdout).toContain(sender.id)
    expect(receiptState(db, sent.message, target.id)).toBe("delivered")
    expect((await hook({ hook_event_name: "UserPromptSubmit", session_id: "receiver" })).stdout).toBe("")
  })
  it("bridge discovers 12 tools, rejects missing hints and sends from correct session", async () => {
    const client = bridge()
    expect(await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).toHaveProperty("result")
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    const tools = await client.request("tools/list")
    expect((tools["result"] as { tools: unknown[] }).tools).toHaveLength(12)
    expect(await client.request("tools/call", { name: "roster", arguments: {} })).toHaveProperty("error")
    const peer = insertAgent(db, { name: "peer", kind: "runtime", vendor: "test", status: "online" })
    const response = toolPayload(await client.request("tools/call", { name: "send", arguments: { to: peer.id, body: "from A", "x-agentchat-session": "sender-a" } }))
    expect(response).toHaveProperty("message")
    const from = db.prepare("SELECT from_agent_id FROM messages WHERE body = ?").get("from A") as { from_agent_id: string }
    expect(from.from_agent_id).toBe(getAgentByTaskRef(db, "sender-a")?.id)
    await client.request("tools/call", { name: "send", arguments: { to: peer.id, body: "from B", "x-agentchat-session": "sender-b" } })
    const second = db.prepare("SELECT from_agent_id FROM messages WHERE body = ?").get("from B") as { from_agent_id: string }
    expect(second.from_agent_id).toBe(getAgentByTaskRef(db, "sender-b")?.id)
    expect(second.from_agent_id).not.toBe(from.from_agent_id)
  })
  it("uses JEIKCODE_SESSION_ID when the host supplies a session-aware MCP environment", async () => {
    const child = spawn(process.execPath, [resolve("adapters/jeikcode/mcp-bridge.mjs")], { env: { ...environment(), JEIKCODE_SESSION_ID: "env-session" } })
    children.push(child)
    const lines: string[] = []
    createInterface({ input: child.stdout }).on("line", (line) => lines.push(line))
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`)
    await new Promise((resolveResult) => setTimeout(resolveResult, 300))
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "roster", arguments: {} } })}\n`)
    await new Promise((resolveResult) => setTimeout(resolveResult, 500))
    expect(lines.join("\n")).not.toContain("缺少 session identity")
    expect(getAgentByTaskRef(db, "env-session")?.vendor).toBe("jeikcode")
  })
  it("does not revive retired sessions and emits no token in logs", async () => {
    await hook({ hook_event_name: "SessionStart", session_id: "retired" })
    const target = getAgentByTaskRef(db, "retired")
    if (!target) throw new Error("missing target")
    retire(db, target.id)
    const client = bridge()
    const result = await client.request("tools/call", { name: "roster", arguments: { "x-agentchat-session": "retired" } })
    expect(result).toHaveProperty("error")
    expect(getAgentByTaskRef(db, "retired")?.status).toBe("retired")
    expect(readFileSync(join(root, "logs", "jeikcode-adapter.log"), "utf8")).not.toContain(readFileSync(join(root, "hub_token"), "utf8").trim())
  })
})
