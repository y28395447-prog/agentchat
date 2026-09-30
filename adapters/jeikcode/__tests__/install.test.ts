import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let root: string
let hub: string
let env: NodeJS.ProcessEnv
const installer = resolve("adapters/jeikcode/install.mjs")
function run(...args: string[]) {
  return spawnSync(process.execPath, [installer, ...args], { env, encoding: "utf8", timeout: 10000 })
}
function read(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, name), "utf8")) as Record<string, unknown>
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jeikcode-install space-"))
  hub = mkdtempSync(join(tmpdir(), "jeikcode-hub-"))
  env = { ...process.env, JEIKCODE_HOME: root, AGENTCHAT_HOME: hub, AGENTCHAT_URL: "http://127.0.0.1:4747", HUB_TOKEN: "do-not-write-this" }
})
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(hub, { recursive: true, force: true }) })

describe("JeikCode installer", () => {
  it("writes native hooks and isolated MCP without secrets, preserves other servers", () => {
    writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "echo" } }, note: "keep" }))
    writeFileSync(join(root, "hooks.json"), JSON.stringify({ hooks: { user: { event: "SessionStart", command: "echo user" } } }))
    expect(run().status).toBe(0)
    const mcp = read("mcp.json")
    expect(mcp).toMatchObject({ note: "keep", mcpServers: { other: { command: "echo" }, agentchat: { scope: "session" } } })
    const text = readFileSync(join(root, "hooks.json"), "utf8")
    expect(text).toContain("mcp__agentchat__*")
    expect(text).toContain("echo user")
    expect(text).not.toContain("do-not-write-this")
    expect(readFileSync(join(root, "mcp.json"), "utf8")).not.toContain("do-not-write-this")
    expect(existsSync(join(root, "mcp.json.bak"))).toBe(true)
    expect(JSON.parse(readFileSync(join(hub, "config.json"), "utf8"))).toMatchObject({ adapters: ["jeikcode"] })
  })
  it("is idempotent and uninstalls only owned entries", () => {
    expect(run().status).toBe(0)
    const first = readFileSync(join(root, "mcp.json"), "utf8")
    expect(run().status).toBe(0)
    expect(readFileSync(join(root, "mcp.json"), "utf8")).toBe(first)
    expect(existsSync(join(root, "mcp.json.bak"))).toBe(false)
    expect(run("--uninstall").status).toBe(0)
    expect(read("mcp.json")).toMatchObject({ mcpServers: {} })
    expect(read("hooks.json")).toMatchObject({ hooks: {} })
    expect(JSON.parse(readFileSync(join(hub, "config.json"), "utf8"))).toMatchObject({ adapters: [] })
  })
  it("dry-run does not create configs or backup files", () => {
    expect(run("--dry-run").status).toBe(0)
    expect(existsSync(join(root, "mcp.json"))).toBe(false)
    expect(existsSync(join(root, "hooks.json"))).toBe(false)
    expect(existsSync(join(hub, "config.json"))).toBe(false)
  })
  it("rejects foreign MCP collision without partial writes; force is explicit", () => {
    const text = JSON.stringify({ mcpServers: { agentchat: { command: "user-server" } } })
    writeFileSync(join(root, "mcp.json"), text)
    expect(run().status).toBe(1)
    expect(readFileSync(join(root, "mcp.json"), "utf8")).toBe(text)
    expect(existsSync(join(root, "hooks.json"))).toBe(false)
    expect(run("--uninstall").status).toBe(0)
    expect(readFileSync(join(root, "mcp.json"), "utf8")).toBe(text)
    expect(run("--force").status).toBe(0)
  })
  it("rejects hook collisions and malformed containers without changing other files", () => {
    writeFileSync(join(root, "hooks.json"), JSON.stringify({ hooks: { "agentchat-prompt": { command: "mine" } } }))
    expect(run().status).toBe(1)
    expect(existsSync(join(root, "mcp.json"))).toBe(false)
    writeFileSync(join(root, "hooks.json"), '{"hooks":[]}')
    expect(run().status).toBe(1)
    expect(existsSync(join(root, "mcp.json"))).toBe(false)
    writeFileSync(join(root, "hooks.json"), "not json")
    expect(run().status).toBe(1)
  })
  it("rejects shared config paths and invalid options", () => {
    expect(run("--config", join(root, "same.json"), "--hooks-config", join(root, "same.json")).status).toBe(1)
    expect(run("--config").status).toBe(1)
    expect(run("--not-real").status).toBe(1)
    expect(run("--help").status).toBe(0)
  })
  it("supports project-level files and retains custom hub port for hooks", () => {
    env["AGENTCHAT_URL"] = ""
    env["AGENTCHAT_PORT"] = "4900"
    const project = join(root, ".mcp.json")
    expect(run("--config", project).status).toBe(0)
    expect(existsSync(join(root, ".hooks.json"))).toBe(true)
    expect(readFileSync(join(root, ".hooks.json"), "utf8")).toContain("http://127.0.0.1:4900")
  })
})
