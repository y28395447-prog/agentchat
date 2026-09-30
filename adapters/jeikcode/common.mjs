import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export function value(env, key) {
  const result = env[key]
  return result === undefined || result === "" ? undefined : result
}

export function home(env = process.env) {
  return value(env, "AGENTCHAT_HOME") ?? join(homedir(), ".agentchat")
}

export function baseUrl(env = process.env) {
  return (value(env, "AGENTCHAT_URL") ?? `http://127.0.0.1:${value(env, "AGENTCHAT_PORT") ?? "4646"}`).replace(/\/+$/, "")
}

export function token(root) {
  try {
    const text = readFileSync(join(root, "hub_token"), "utf8").trim()
    if (text) return text
  } catch {}
  return undefined
}

export function log(root, message) {
  try {
    const path = join(root, "logs", "jeikcode-adapter.log")
    mkdirSync(dirname(path), { recursive: true })
    try { if (statSync(path).size > 1024 * 1024) renameSync(path, `${path}.1`) } catch {}
    const safe = redact(root, message)
    appendFileSync(path, `${new Date().toISOString()} ${safe}\n`)
  } catch {}
}

export function redact(root, message) {
  let text = String(message)
  for (const secret of [token(root), readJson(jsonPath(root))?.join_token]) if (secret) text = text.split(secret).join("[REDACTED]")
  return text.replace(/unknown join_token: \S+/g, "unknown join_token: [REDACTED]")
}

function parseSse(text) {
  const messages = []
  for (const part of text.split(/\r?\n\r?\n/)) {
    const data = part.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
    if (data) {
      try { messages.push(JSON.parse(data)) } catch {}
    }
  }
  return messages
}

function messages(text, type) {
  if (!text.trim()) return []
  if ((type ?? "").includes("event-stream") || text.trim().startsWith("data:")) return parseSse(text)
  const value = JSON.parse(text)
  return Array.isArray(value) ? value : [value]
}

export function resultOf(list) {
  const rpc = list.find((item) => item && item.result)
  const content = rpc?.result?.content
  const text = Array.isArray(content) ? content.find((item) => item?.type === "text")?.text : undefined
  if (typeof text !== "string") throw new Error("Hub MCP 返回了无效结果")
  if (rpc.result.isError) throw new Error(text)
  return JSON.parse(text)
}

export async function post(root, url, body, sessionId, extra = {}) {
  const auth = token(root)
  if (!auth) throw new Error(`找不到 Hub token：${join(root, "hub_token")}`)
  const headers = { authorization: `Bearer ${auth}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra }
  if (sessionId) headers["mcp-session-id"] = sessionId
  const response = await fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(body.method === "tools/call" && body.params?.name !== "register" ? 300000 : 3000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`Hub HTTP ${response.status}: ${text.slice(0, 300)}`)
  return { sessionId: response.headers.get("mcp-session-id") ?? sessionId, messages: messages(text, response.headers.get("content-type")) }
}

export async function rpc(root, url, body, extra = {}) {
  const init = await post(root, url, { jsonrpc: "2.0", id: "control-init", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentchat-jeikcode", version: "0.1.0" } } })
  const sid = init.sessionId
  if (!sid) throw new Error("Hub initialize 未返回会话 id")
  await post(root, url, { jsonrpc: "2.0", method: "notifications/initialized" }, sid)
  try {
    const reply = await post(root, url, body, sid, extra)
    return resultOf(reply.messages)
  } finally {
    try { await fetch(`${url}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${token(root)}`, "mcp-session-id": sid }, signal: AbortSignal.timeout(1000) }) } catch {}
  }
}

function jsonPath(root) { return join(root, "agents", "jeikcode-root.json") }
function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")) } catch { return undefined } }
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch {}
}

async function withRootLock(root, fn) {
  const path = join(root, "agents", "jeikcode-root.lock")
  mkdirSync(dirname(path), { recursive: true })
  let fd
  for (let n = 0; n < 100; n += 1) {
    try {
      fd = openSync(path, "wx")
      writeFileSync(fd, String(process.pid))
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      try {
        const owner = Number(readFileSync(path, "utf8"))
        try { if (owner > 0) process.kill(owner, 0) } catch (missing) { if (missing.code === "ESRCH") unlinkSync(path) }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  if (fd === undefined) throw new Error("JeikCode 根节点注册锁被占用，请稍后重试")
  try { return await fn() } finally { closeSync(fd); try { unlinkSync(path) } catch {} }
}

export async function ensureRoot(root, url) {
  return withRootLock(root, async () => {
    const path = jsonPath(root)
    const old = readJson(path)
    const args = old?.join_token ? { join_token: old.join_token, vendor: "jeikcode", role_tag: "container", name: old.name } : { kind: "runtime", vendor: "jeikcode", role_tag: "container", name: `jeikcode@${process.env.COMPUTERNAME ?? "local"}` }
    try {
      const payload = await rpc(root, url, { jsonrpc: "2.0", id: "register-root", method: "tools/call", params: { name: "register", arguments: args } })
      const record = { id: payload.agent.id, join_token: payload.join_token ?? old?.join_token, name: payload.agent.name }
      writeJson(path, record)
      return record
    } catch (error) {
      if (!old?.join_token || !String(error).includes("invalid_join_token")) throw error
      try { unlinkSync(path) } catch {}
      const payload = await rpc(root, url, { jsonrpc: "2.0", id: "register-root", method: "tools/call", params: { name: "register", arguments: { kind: "runtime", vendor: "jeikcode", role_tag: "container", name: `jeikcode@${process.env.COMPUTERNAME ?? "local"}` } } })
      const record = { id: payload.agent.id, join_token: payload.join_token, name: payload.agent.name }
      writeJson(path, record)
      return record
    }
  })
}

export async function ensureChild(root, url, sessionId) {
  if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("JeikCode hook 缺少 session_id，拒绝使用容器身份")
  const parent = await ensureRoot(root, url)
  const payload = await rpc(root, url, { jsonrpc: "2.0", id: "register-child", method: "tools/call", params: { name: "register", arguments: { parent_ref: parent.id, task_ref: sessionId, kind: "runtime", vendor: "jeikcode", name: `JeikCode · ${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}` } } })
  if (payload.agent?.parentId !== parent.id || payload.agent?.vendor !== "jeikcode" || payload.agent?.status === "retired") throw new Error("Hub 返回的会话节点身份不匹配")
  return { parent, child: payload.agent }
}

export async function wake(root, url, agentId) {
  const auth = token(root)
  if (!auth) throw new Error("Hub token 不存在")
  const response = await fetch(`${url}/internal/wake`, { method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify({ agentId }), signal: AbortSignal.timeout(3000) })
  const payload = await response.json()
  if (!response.ok) throw new Error(`Hub wake HTTP ${response.status}: ${JSON.stringify(payload)}`)
  return payload
}

export async function delivered(root, url, agentId, messages) {
  if (!messages.length) return
  const auth = token(root)
  const response = await fetch(`${url}/internal/result`, { method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify({ agentId, items: messages.map((message) => ({ messageId: message.id, result: "delivered" })) }), signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error(`Hub result HTTP ${response.status}`)
}
