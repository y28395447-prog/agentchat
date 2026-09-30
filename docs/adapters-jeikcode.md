# AgentChat — JeikCode 适配器

此适配器把 JeikCode 的每个 coding session 注册为 AgentChat 的独立会话节点，并把 AgentChat MCP 工具挂载到 JeikCode。

## 安装

在 AgentChat 仓库根目录执行：

```powershell
node adapters/jeikcode/install.mjs --dry-run
node adapters/jeikcode/install.mjs
```

默认写入：

- `~/.jeikcode/mcp.json`：session-scoped stdio MCP bridge；
- `~/.jeikcode/hooks.json`：SessionStart、SessionEnd、UserPromptSubmit、PreToolUse hooks；
- `~/.agentchat/config.json`：登记 `jeikcode` pull adapter。

安装器支持 `--config <path>`、`--hooks-config <path>`、`--dry-run`、`--uninstall` 与 `--force`，会在覆盖已有文件前写 `.bak`，并使用临时文件原子替换。配置里不写 Hub token。

安装后启动 Hub，再在 JeikCode 中执行 `/mcp reload`。项目级安装可使用：

```powershell
node adapters/jeikcode/install.mjs --config "$PWD/.mcp.json" --hooks-config "$PWD/.hooks.json"
```

项目级 MCP 配置需要信任当前项目：`/mcp trust`。

## 运行机制

1. `SessionStart` / `UserPromptSubmit` 读取 JeikCode 的真实 `session_id`，确保 AgentChat 根节点和子会话节点存在，并拉取待投递消息。
2. `PreToolUse` 只改写 `mcp__agentchat__*` 工具调用，在原始参数中加入 `x-agentchat-session`。
3. stdio bridge 在发送 `tools/call` 时删除这个内部参数，并以 `x-agentchat-session` HTTP 请求头转发给 Hub。
4. 每个 JeikCode session 使用独立的 MCP 进程（`scope: session`），避免不同会话共享可变 MCP 身份；缺少身份时 bridge 拒绝调用，不回落到根容器。

Hub 的信任边界仍是本机进程和文件系统。`x-agentchat-session` 是路由身份，不是网络安全认证；不要把 Hub 暴露到不可信网络。

## 环境变量

| 变量 | 作用 |
|---|---|
| `AGENTCHAT_HOME` | Hub 数据目录，默认 `~/.agentchat` |
| `AGENTCHAT_URL` | Hub 地址，默认 `http://127.0.0.1:4646` |
| `AGENTCHAT_PORT` | 未设置 URL 时使用的端口 |

Hub 必须先启动以生成 `<AGENTCHAT_HOME>/hub_token`。当前 JeikCode upstream 不会向 `scope=session` MCP 子进程传入 `session_id`；需应用 [session spawn 补丁](jeikcode-session-spawn-patch.md) 后 bridge 才能在 hook 身份注入不可用时使用 `JEIKCODE_SESSION_ID`。适配器日志写入 `<AGENTCHAT_HOME>/logs/jeikcode-adapter.log`。

## 排障

- `/mcp` 显示 failed：确认 Hub 已启动、`hub_token` 存在，然后执行 `/mcp reload`。
- 调用提示缺少 session identity：确认四个 hooks 已写入 JeikCode 实际读取的 `hooks.json`，并重启或 reload 当前会话。
- 节点重复：不要手动删除 `agents/jeikcode-root.json`；它保存根 join token。若 Hub 数据库已重置，删除该文件后重新启动即可自愈。
- 消息未注入：检查日志；注入发生在 SessionStart 或下一次 UserPromptSubmit，不依赖不存在的 Stop hook。
