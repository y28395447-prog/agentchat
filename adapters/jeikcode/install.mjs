#!/usr/bin/env node
/** JeikCode JSON hooks + session-scoped stdio MCP installer. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { canonicalPath } from "../claude-code/install-io.mjs"
import { agentchatConfigPath, applyVendor, readAgentchatConfig, writeAgentchatConfig } from "../agentchat-config.mjs"

const dir = dirname(fileURLToPath(import.meta.url))
const bridge = resolve(dir, "mcp-bridge.mjs")
const hook = resolve(dir, "hook.mjs")
const vendor = "jeikcode"
const key = "agentchat"
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value) }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((keyName) => [keyName, stable(value[keyName])]))
  return value
}
function equal(left, right) { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)) }
function read(path, label, optional = false) {
  if (!existsSync(path) && optional) return {}
  if (!existsSync(path)) throw new Error(`${label} 文件不存在：${path}`)
  let value
  try { value = JSON.parse(readFileSync(path, "utf8")) } catch (error) { throw new Error(`${label} 不是合法 JSON：${error}`) }
  if (!record(value)) throw new Error(`${label} 顶层不是对象：${path}`)
  return value
}
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) copyFileSync(path, `${path}.bak`)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}
function quote(value) {
  const path = value.replace(/\\/g, "/")
  if (/[\r\n\0]/.test(path)) throw new Error("hook 参数含不支持的控制字符")
  if (process.platform === "win32") {
    if (/["%]/.test(path)) throw new Error("Windows hook 参数不可含双引号或 %")
    return `"${path}"`
  }
  return `'${path.replace(/'/g, "'\\''")}'`
}
function envValue(env, keyName) { return env[keyName] && env[keyName] !== "" ? env[keyName] : undefined }
function paths(args, env) {
  const home = env.JEIKCODE_HOME && env.JEIKCODE_HOME !== "" ? env.JEIKCODE_HOME : join(homedir(), ".jeikcode")
  const config = args.config ?? join(home, "mcp.json")
  const hooks = args.hooks ?? (args.config ? join(dirname(config), ".hooks.json") : join(home, "hooks.json"))
  return { config: resolve(config), hooks: resolve(hooks), home }
}
function bridgeEnv(env) {
  const result = {}
  if (envValue(env, "AGENTCHAT_HOME")) result.AGENTCHAT_HOME = env.AGENTCHAT_HOME
  if (envValue(env, "AGENTCHAT_URL")) result.AGENTCHAT_URL = env.AGENTCHAT_URL
  if (envValue(env, "AGENTCHAT_PORT")) result.AGENTCHAT_PORT = env.AGENTCHAT_PORT
  return result
}
function hookCommand(env) {
  const args = [process.execPath, hook]
  if (envValue(env, "AGENTCHAT_HOME")) args.push("--home", env.AGENTCHAT_HOME)
  if (envValue(env, "AGENTCHAT_URL")) args.push("--url", env.AGENTCHAT_URL)
  else if (envValue(env, "AGENTCHAT_PORT")) args.push("--url", `http://127.0.0.1:${env.AGENTCHAT_PORT}`)
  return args.map(quote).join(" ")
}
function desired(env) {
  const environment = bridgeEnv(env)
  const command = hookCommand(env)
  return {
    mcp: { command: process.execPath, args: [bridge], scope: "session", ...(Object.keys(environment).length ? { env: environment } : {}) },
    hooks: {
      "agentchat-session-start": { event: "SessionStart", command, timeout_ms: 10000 },
      "agentchat-session-end": { event: "SessionEnd", command, timeout_ms: 10000 },
      "agentchat-prompt": { event: "UserPromptSubmit", command, timeout_ms: 10000 },
      "agentchat-mcp-identity": { event: "PreToolUse", matcher: "mcp__agentchat__*", command, timeout_ms: 10000 },
    },
  }
}
function isOwnedMcp(entry) { return record(entry) && entry.scope === "session" && Array.isArray(entry.args) && entry.args[0] === bridge }
function isOwnedHook(entry, expected) { return record(entry) && entry.event === expected.event && typeof entry.command === "string" && entry.command.replace(/\\/g, "/").includes(hook.replace(/\\/g, "/")) && (expected.matcher === undefined || entry.matcher === expected.matcher) }
function merge(config, hooks, want, force, uninstall) {
  let changed = false
  if (config.mcpServers === undefined) config.mcpServers = {}
  else if (!record(config.mcpServers)) throw new Error("mcpServers 必须是对象，拒绝覆盖")
  const existing = config.mcpServers[key]
  const own = isOwnedMcp(existing)
  if (uninstall) { if (own) { delete config.mcpServers[key]; changed = true } }
  else if (existing === undefined || own || force) { if (!equal(existing, want.mcp)) { config.mcpServers[key] = want.mcp; changed = true } }
  else throw new Error("mcpServers.agentchat 已存在非本适配器条目；确认后使用 --force")
  if (hooks.hooks === undefined) hooks.hooks = {}
  else if (!record(hooks.hooks)) throw new Error("hooks 必须是对象，拒绝覆盖")
  for (const [name, entry] of Object.entries(want.hooks)) {
    const current = hooks.hooks[name]
    const isOwn = isOwnedHook(current, entry)
    if (uninstall) { if (isOwn) { delete hooks.hooks[name]; changed = true } }
    else if (current === undefined || isOwn || force) { if (!equal(current, entry)) { hooks.hooks[name] = entry; changed = true } }
    else throw new Error(`hooks.${name} 已存在非本适配器条目；确认后使用 --force`)
  }
  return changed
}
function args(argv) {
  const out = { config: undefined, hooks: undefined, dry: false, uninstall: false, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--dry-run") out.dry = true
    else if (arg === "--uninstall") out.uninstall = true
    else if (arg === "--force") out.force = true
    else if (arg === "--config" || arg === "--hooks-config") { const value = argv[++i]; if (!value) throw new Error(`${arg} 需要路径`); out[arg === "--config" ? "config" : "hooks"] = value }
    else if (arg === "--help" || arg === "-h") out.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return out
}
const help = `AgentChat JeikCode 适配器\n用法：node adapters/jeikcode/install.mjs [--config <mcp.json>] [--hooks-config <hooks.json>] [--dry-run] [--uninstall] [--force]\n默认写入 ~/.jeikcode/mcp.json 与 ~/.jeikcode/hooks.json；配置了 --config 时 hooks 默认写入同目录 .hooks.json。\n`
function main() {
  const parsed = args(process.argv.slice(2))
  if (parsed.help) { process.stdout.write(help); return }
  const target = paths(parsed, process.env)
  if (canonicalPath(target.config) === canonicalPath(target.hooks) || [target.config, target.hooks].some((path) => canonicalPath(path) === canonicalPath(agentchatConfigPath(process.env)))) throw new Error("MCP、hooks、Hub 配置必须是三个不同文件")
  const want = desired(process.env)
  const config = read(target.config, "MCP", true)
  const hooks = read(target.hooks, "hooks", true)
  const changed = merge(config, hooks, want, parsed.force, parsed.uninstall)
  const hub = readAgentchatConfig(agentchatConfigPath(process.env))
  const hubChanged = applyVendor(hub, agentchatConfigPath(process.env), vendor, parsed.uninstall)
  process.stdout.write(`${parsed.uninstall ? "卸载" : "安装"} JeikCode 适配器\nMCP: ${target.config}\nHooks: ${target.hooks}\n${parsed.dry ? "dry-run：未落盘\n" : ""}`)
  if (parsed.dry || (!changed && !hubChanged)) return
  if (changed) { write(target.config, config); write(target.hooks, hooks) }
  if (hubChanged) writeAgentchatConfig(agentchatConfigPath(process.env), hub)
}
try { main() } catch (error) { console.error(`[agentchat] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 }
