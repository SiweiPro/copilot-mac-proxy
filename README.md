# Copilot Mac Proxy

在 **macOS** 上，将本人正常可用的 Microsoft 365 Copilot Chat 会话接入本机 Claude Code。提供本机 Messages 兼容接口、Chrome 会话中继扩展和 macOS LaunchAgent 管理。扩展可独立检查会话并尝试恢复，**不需要 Codex 保持运行**。

已在 Apple silicon Mac 上验证 Opus 5.5 和 Fable 5.1 的文本与 Read 工具往返。Intel Mac 尚未实测。项目不提供账号、模型权限或访问令牌；模型必须已在使用者自己的 Copilot 界面中可用。

## 工作方式

```mermaid
flowchart LR
    Browser[Chrome 中的 Copilot] -->|正常登录与新连接| Relay[本机会话中继]
    Relay -->|更新短期会话| Proxy[Mac 本机代理]
    CLI[Claude Code CLI / VS Code] -->|Messages 兼容请求| Proxy
    Proxy -->|StreamHub / SignalR| Copilot[Copilot Chat]
```

本项目使用 **Copilot Chat 的 StreamHub 协议**。参考项目 [copilot-app-proxy](https://github.com/madderscientist/copilot-app-proxy) 面向 Windows Copilot Code 的 Loki Messages 接口；两者的运行环境和上游协议不同。

**这不是原生 Anthropic API。** 代理将 system、历史、工具定义及工具结果封装成文本，再将模型返回的 JSON 解析为 Claude Code 工具调用。工具执行与确认仍由 Claude Code 负责。详见[协议与数据流](docs/architecture.md)。

## 准备

- macOS、Node.js 22 或更新版本、npm、Python 3.9 或更新版本。
- 已安装 Claude Code CLI；VS Code 用户可同时安装官方 Claude Code 扩展。
- Chrome 中可以正常使用 [Microsoft 365 Copilot Chat](https://copilot.cloud.microsoft/home)，并能选择所需的两个模型。
- 初次导入需要从本人正常会话导出的 HAR，其中包含两个模型的 WebSocket 请求帧。

本地代理默认仅监听 `127.0.0.1:19324`。安装与管理不需要管理员权限。

## 安装

在仓库目录执行：

```bash
npm ci
python3 manage.py setup
```

安装程序会在当前用户的 `~/Library/Application Support/CopilotMacProxy` 下创建独立运行目录，并生成本机密钥、启动配置和 native host 模板。已有安装目录不会被覆盖。此步骤不启动服务、不注册浏览器宿主，也不修改 Claude Code 设置。

### 1. 导入首次会话

1. 在 Chrome 打开 Copilot，正常登录。打开开发者工具的 **Network** 面板，开始记录并启用 **Preserve log**。
2. 刷新页面，使 Network 记录到新的 WebSocket 连接。选择 Opus，在临时聊天中发送一条简短测试消息，例如“只回复 OK，不搜索、不读取文件、不使用工具”。
3. 选择 Fable，使用同样的测试消息。保留这两次请求的记录。
4. 将记录导出为本地 HAR。文件需要包含 StreamHub WebSocket 条目的 `_webSocketMessages`，其中能找到两个 `chat_request` 帧。导入器缺少任一模型证据时会拒绝导入。
5. 收紧 HAR 权限并导入：

```bash
chmod 600 /path/to/copilot-capture.har
python3 manage.py import-har /path/to/copilot-capture.har
```

HAR 即使标为 **sanitized**，也可能在 WebSocket URL 中包含访问令牌。不要上传到 GitHub、Issue 或聊天；导入并确认可用后，删除原始 HAR。导入器仅保留必要会话字段和已观察到的模型映射，不保留聊天历史或响应内容。

当前映射为：

| Claude Code 模型 ID | Copilot 请求中的 tone |
|---|---|
| `copilot-claude-opus-5.5` | `Claude_Container` |
| `copilot-claude-fable-5.1` | `Claude_Fable` |

显示名称和 tone 必须由使用者自己的界面及请求记录对应确认。若服务改名或协议变化，不应通过猜测模型 ID 来扩大访问范围。

### 2. 安装会话中继扩展

```bash
python3 manage.py register-host
```

在 `chrome://extensions` 打开开发者模式，选择“加载未打包的扩展程序”，打开：

```text
~/Library/Application Support/CopilotMacProxy/extension
```

确认 **Local Copilot Session Relay** 已启用。若同名 native host 已指向另一套安装，管理脚本会拒绝覆盖；应先处理已有安装，再注册本项目。

扩展仅观察 Copilot 正常发起的目标 WebSocket 握手，并把短期会话交给本机 native host。它不读取 Cookie、请求正文或 WebSocket 消息，不使用内容脚本。权限和消息协议见[扩展说明](extension/README.md)。

自动维护默认关闭。完成启动后点击 Chrome 工具栏中的扩展，开启“自动维护会话”；关闭此开关仅停止定时维护，普通会话中继仍可继续工作。“检查状态”只查询本机状态；“立即尝试更新”可显式触发维护，但仍会跳过忙碌、人工接管或已有维护页的情况。

### 3. 启动并接入 Claude Code

```bash
python3 manage.py start
python3 manage.py status
python3 manage.py configure-claude
claude --model opus
```

也可以使用 Fable：

```bash
claude --model fable
```

配置命令会保存原设置备份，写入本机网关地址、密钥和模型映射。重新打开已有 Claude Code 会话后生效。代理会在当前用户登录后启动。

## 会话更新与重启

- **自动维护开启时**，Chrome 每 5 分钟经 native host 读取代理状态。剩余有效期不超过 20 分钟、会话缺失或过期且代理空闲时，扩展最多每 15 分钟创建一次自己的后台维护标签页，访问正常 Copilot 首页以触发连接。
- **维护页建立新连接后**，扩展同步短期会话并热加载代理。一次尝试最长约 2 分钟；Chrome 或系统可能延后闹钟，所以这不是严格的实时调度。
- **不操作用户已有页面**。维护标签页一旦被用户激活、转入登录流程或离开固定维护地址，扩展就不再自动关闭它。需要登录、MFA 或人工操作时，使用扩展弹窗打开 Copilot 后自行完成；扩展不会代填密码或发送聊天消息。
- **凭据有效时**，可关闭 Chrome，继续使用 Claude Code；但关闭 Chrome 后不会自动维护。Mac 休眠或离线时也无法更新，会在恢复运行后再检查。
- **重启后**，代理可复用尚有效的本机会话；Chrome 运行且自动维护开关开启后才会继续尝试更新。Codex 不参与这条链路。

扩展不调用令牌刷新接口，也不获取 refresh token。打开维护页只是让 Copilot 自身正常获取会话，不能保证永不断线。连续两次同步可能具有相同的到期时间；有效期确实晚于旧值才表示延长。只打开 Teams 或独立 Copilot 桌面 WebView 不会触发 Chrome 扩展。

15 分钟间隔限制自动尝试；“立即尝试更新”可绕过时间阈值与冷却，但不会打断活动请求或接管用户页面。自动失败后通常退避 30 分钟；遇到登录或人工接管时暂停创建维护页。关闭原维护页，或完成登录后点击“检查状态”，可继续维护。

0.2.0 已在 Mac 上验证后台维护页建立连接、同步会话并自动关闭的完整流程，原有页面保持打开。正常 SSO 登录后曾取得更晚的有效期；另一次后台检查复用了仍有效的凭据，正确显示有效期未变，没有将其当作延长。

自动维护关闭或需要手动恢复时，在安装扩展的同一 Chrome 配置文件中打开或刷新 Copilot，必要时正常登录或发送简短消息。代理已被主动停止时，扩展不会自行启动它。

## 更新已有安装

先在 Chrome 的扩展管理页暂时停用本扩展，避免升级途中启动 native host；在仓库目录执行：

```bash
git pull --ff-only
npm ci
python3 manage.py stop
python3 manage.py upgrade
python3 manage.py start
```

然后在 `chrome://extensions` 中重新加载并启用扩展，检查新增权限，按需要开启自动维护。扩展 ID 保持不变。

`upgrade` 只替换程序、依赖和扩展，保留私有会话、网关密钥、本机配置、宿主注册与 Claude 设置。旧代码存放在运行目录下独立的 `.local/code-backup-*` 私有目录中；更新失败会尝试恢复旧代码并保持服务停止。安装未停止、端口仍被占用或路径不匹配时会拒绝更新。此命令只用于本项目 `setup` 创建的标准安装。

## 界面兼容性

| 客户端 | 状态 |
|---|---|
| Claude Code CLI | 已验证两个模型的 Read 工具往返 |
| VS Code 官方 Claude Code 扩展 | 可使用同一本机 Messages 网关；图形界面完整工作流未逐项验证 |
| Claude 桌面 App 的 Code 页 | 需要独立第三方推理配置，本项目未实测 |
| Codex | 当前不支持；本项目没有 `/v1/responses` 兼容层 |

VS Code 若仍使用旧地址，检查扩展的 `claudeCode.environmentVariables` 是否覆盖了 Claude Code 用户设置。本项目管理脚本仅管理 Claude Code 用户设置，不自动改写 VS Code 配置。

## 能力范围

- 运行时已验证 Claude Code 的默认 system/工具集下 `Read → tool_result → 最终答案` 两轮流程；没有验证所有工具、长任务、动态工具加载或并行子代理。
- 支持文本和纯文本请求的 `stop_sequences`；图片、部分新内容块、停止序列与工具混用、显式结构化输出不支持。停止序列在完整上游回复解包后处理，不会提前终止上游生成。
- SSE 在完整响应解析后输出，等待期间发送 ping，不是逐 token 上游流。
- token 数与客户端费用显示是估算，不是 Copilot 实际账单。
- 本地文本上限为 200,000 字符；建议使用保守上下文，不能据此宣称支持 1M 上下文。
- `max_tokens`、effort 和缓存行为不能等价映射。
- 客户端断开连接不保证云端推理立即停止。
- 此服务接口可能随上游更新而变化。

## Claude Code 自动模式

0.2.1 修复了自动模式分类器携带 `stop_sequences` 时被本机代理拒绝的问题。旧版可能返回 HTTP 400，而 Claude Code 显示模型暂不可用、无法判断工具安全性。更新代理后可重试该操作，分类器仍由模型正常执行，权限判断继续由 Claude Code 处理。

已用 Claude Code 2.1.322 的 `--permission-mode auto` 实测一次独立临时目录内的文件创建：实际分类器请求返回 HTTP 200 和正确停止序列，随后 Bash 执行成功。测试未配置工具允许列表，也未跳过权限检查。

本机代理不会自动允许被拦截的工具。上游失败、回复格式错误或客户端无法解析判断时，仍会报错；这项协议修复不保证所有自动模式工作流均兼容。

## 管理与测试

```bash
python3 manage.py status
python3 manage.py stop
python3 manage.py start
python3 manage.py restore
node --test
python3 -m unittest discover -s tests
```

`stop` 停止服务并停用该用户的自动启动项；`start` 可再次加载。`restore` 恢复脚本管理的 Claude Code 配置并停止服务，保留无关的后续设置；它不会删除会话或卸载扩展。需要停用会话中继时，在 Chrome 扩展页停用或移除该扩展。

离线测试使用合成会话，不需要真实账号或上游凭据，覆盖文本封装、模型会话选择、私有快照、native messaging、扩展调度与安装升级。测试通过不代表对上游所有功能的兼容保证。

## 凭据与公开内容

运行时的 `session.json` 含短期访问令牌及必要账号路由信息，以 `0600` 文件权限保存在 `0700` 私有目录内；这是权限保护，不是加密存储。请求内容会发送至 Copilot 上游。

仓库仅包含可审阅源码、通用配置模板和合成测试。不要提交运行目录、HAR、网关密钥、Claude 设置、服务日志或截图。扩展 manifest 的 `key` 是用于稳定扩展 ID 的公钥，不是访问凭据。

第三方来源与依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
