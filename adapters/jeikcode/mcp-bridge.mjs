#!/usr/bin/env node
import { createInterface } from "node:readline"
import { baseUrl, ensureChild, home, log, post } from "./common.mjs"

const root = process.env.AGENTCHAT_HOME || home(process.env)
const url = baseUrl(process.env)
const configuredSession = typeof process.env.JEIKCODE_SESSION_ID === "string" && process.env.JEIKCODE_SESSION_ID.trim() ? process.env.JEIKCODE_SESSION_ID.trim() : undefined
let upstream
let initParams
let chain = Promise.resolve()
if (!configuredSession) log(root, "JeikCode 未提供 JEIKCODE_SESSION_ID；需要 session-aware MCP spawn 支持或有效 hook 注入")

function requestId(value) { return value !== undefined && value !== null }
function write(value) { process.stdout.write(`${JSON.stringify(value)}\n`) }
function error(id, message) {
  if (requestId(id)) write({ jsonrpc: "2.0", id, error: { code: -32000, message } })
}
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value) }
function hint(message) {
  if (message.method !== "tools/call" || !record(message.params) || !record(message.params.arguments)) return undefined
  const args = message.params.arguments
  const value = args["x-agentchat-session"]
  delete args["x-agentchat-session"]
  return typeof value === "string" && value.trim() ? value : undefined
}

async function initialize(params) {
  initParams = params
  const reply = await post(root, url, { jsonrpc: "2.0", id: "jeikcode-init", method: "initialize", params: params ?? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentchat-jeikcode", version: "0.1.0" } } })
  if (!reply.sessionId) throw new Error("Hub initialize 未返回 MCP session id")
  upstream = reply.sessionId
  return reply.messages
}
async function forward(message, sessionHint) {
  if (message.method === "initialize") return initialize(message.params)
  if (!upstream) await initialize(initParams)
  if (message.method === "notifications/initialized") {
    const reply = await post(root, url, message, upstream)
    upstream = reply.sessionId
    return reply.messages
  }
  const extra = sessionHint ? { "x-agentchat-session": sessionHint } : {}
  let reply
  try { reply = await post(root, url, message, upstream, extra) } catch (failure) {
    if (!String(failure).includes("HTTP 404") || !String(failure).includes("session_not_found")) throw failure
    await initialize(initParams)
    await post(root, url, { jsonrpc: "2.0", method: "notifications/initialized" }, upstream)
    reply = await post(root, url, message, upstream, extra)
  }
  upstream = reply.sessionId
  return reply.messages
}
async function processMessage(message) {
  try {
    if (!record(message)) return
    const sessionHint = hint(message) ?? configuredSession
    if (message.method === "tools/call") {
      if (!sessionHint) throw new Error("AgentChat MCP 调用缺少 session identity；请确认 JeikCode hooks 已安装")
      await ensureChild(root, url, sessionHint)
    }
    const replies = await forward(message, sessionHint)
    if (message.method === "initialize") {
      for (const reply of replies) write({ ...reply, id: message.id })
    } else for (const reply of replies) write(reply)
    if (requestId(message.id) && replies.length === 0) error(message.id, `Hub 未返回 ${message.method} 的结果`)
  } catch (failure) {
    const messageText = failure instanceof Error ? failure.message : String(failure)
    log(root, `bridge ${message.method ?? "notification"} failed: ${messageText}`)
    error(message.id, messageText)
  }
}
function enqueue(line) {
  chain = chain.then(async () => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (Array.isArray(message)) for (const item of message) await processMessage(item)
    else await processMessage(message)
  }).catch((failure) => log(root, `bridge queue failed: ${String(failure)}`))
}
const reader = createInterface({ input: process.stdin })
reader.on("line", (line) => { if (line.trim()) enqueue(line) })
reader.on("close", () => log(root, "bridge stdin closed"))
process.stdin.on("error", () => undefined)
