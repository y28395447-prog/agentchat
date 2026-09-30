# JeikCode session-aware MCP spawn 补丁

当前 JeikCode 的 `scope: "session"` 只隔离 MCP 进程，不会把内部 `session_id` 传给 stdio MCP 子进程。因此 AgentChat 无法安全判断当前调用来自哪个 JeikCode 会话，bridge 会拒绝调用并显示 `缺少 session identity`。

## 最小源码改动

在 JeikCode 源码中把 `SessionMcpPool::acquire` 得到的 session id 传入 session registry，再传入 `McpRegistry::add_server` / `StdioClient::new`，最终在 `transport_stdio.rs::start()` 设置：

```rust
cmd.env("JEIKCODE_SESSION_ID", session_id);
```

建议把字段命名为 `session_id: Option<String>`，只对 `scope=session` 的 registry 设置；project scope 不设置，避免错误地伪造身份。`session_id` 必须经过环境变量安全校验（非空、无 `\0`），并在子进程创建前传入，不能使用共享文件或“最近会话”猜测。

完整调用链位置：

- `crates/jeikcode-capabilities/src/mcp/session_pool.rs`：session key 已有 `session_id`；
- `crates/jeikcode-capabilities/src/mcp/registry.rs`：创建 `StdioClient`；
- `crates/jeikcode-capabilities/src/mcp/transport_stdio.rs`：`Command` spawn 前设置环境变量。

## AgentChat 适配器行为

本分支 bridge 已支持读取：

```text
JEIKCODE_SESSION_ID
```

并将其作为 AgentChat `task_ref` 注册和 `x-agentchat-session` 请求头。没有该变量且 hook 参数未成功注入时，bridge 会 fail closed，不会回落到容器身份。

由于当前 JeikCode 官方二进制没有传递该变量的接口，单纯重装 AgentChat 适配器无法解决这个问题；需要先合并 JeikCode 源码补丁并重新编译/安装 JeikCode。
