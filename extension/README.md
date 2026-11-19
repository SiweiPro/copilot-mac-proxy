# Local Copilot Session Relay

这是 Chromium Manifest V3 的本机会话中继扩展。它配合 Copilot Mac Proxy 的 native host，将正常 Copilot 页面产生的新会话同步到本机代理，并可独立执行定时会话维护，不需要 Codex 保持运行。首次使用必须先导入包含模型请求证据的 HAR，扩展无法仅凭握手确定模型映射。

仅监听浏览器中正常发起的目标 WebSocket 握手：目标主机为 substrate.svc.cloud.microsoft，路径为 /m365Copilot/StreamHub/。额外检查 wss 协议、路径形状、唯一 access_token 参数和长度；其他请求不会转发。不读取握手头、Cookie、请求体或 WebSocket 消息内容，不使用内容脚本、页面脚本或远程脚本。新增本地存储仅保存维护元数据。

完整连接 URL 含短期访问令牌和账号路由信息，属于敏感凭据。扩展只通过 Chrome native messaging 发送给固定本机宿主 local.codex.copilot_session_relay，不将它写入扩展存储或日志。日志只有固定状态文本。应当仅为本人获准会话安装，本机 host 必须校验允许的扩展 ID、目标 URL 和消息结构，且不能打印消息内容。

## Native messaging 协议

扩展每次观察到有效的新连接时调用 sendNativeMessage。输入是 JSON 对象，字段为：

- version：整数 1。
- type：固定值 copilot-streamhub-session。
- url：实际观察到的完整 wss 连接 URL；只发送给本机 host。
- capturedAt：当前 UTC ISO 时间。

Host 返回 {"ok":true} 表示已经接收。缺失 host、错误或其他返回值仅产生静态失败日志；不把失败详情或凭据回显到页面。原始 URL 不进入重试队列，下一次正常连接会再次尝试。

只读状态请求为 `{"version":1,"type":"copilot-session-status"}`。native host 验证扩展来源后读取固定本机 healthz，返回可达性、到期时间、活动请求数和有限状态。该请求不读取或返回会话凭据，不写快照，也不启动服务。

扩展不调用令牌刷新或登录接口。会话刷新仍由 Copilot 自己完成；正常页面访问会尝试产生新的 WebSocket 握手。无法由握手推断模型 tone，模型映射仍必须来自已验证的请求证据。

## 自动维护

点击工具栏扩展图标，在弹窗开启“自动维护会话”；默认关闭。关闭开关停止定时维护，普通连接中继仍有效。

- “检查状态”：只查询本机状态；会话恢复有效后可解除人工接续状态，并放弃对原维护页的管理。
- “立即尝试更新”：显式发起一次维护，可绕过到期阈值与时间冷却，但仍尊重活动请求、人工接续和现存维护页。
- “打开 Copilot”：另开普通页面供用户登录，不自动点击账号、密码或 MFA。

- Chrome alarms 每 5 分钟检查本机代理，剩余有效期不超过 20 分钟且没有活动请求时尝试恢复。
- 自动尝试每 15 分钟最多一次，建立自己的后台维护标签页；不刷新用户已有页面、不读取页面 DOM、不发送聊天消息。
- 每次尝试最长约 2 分钟。新连接被中继且本机会话有效后才判定更新；相同到期时间不算延长有效期。
- 只在维护页面仍归扩展所有、未被用户激活且停留在固定维护地址时自动关闭。登录跳转、用户接管或离开维护地址后，保留页面供人工处理，不不断创建新页面。
- 页面更新失败通常退避 30 分钟；出现人工接续状态时，关闭原维护页，或通过弹窗打开 Copilot 完成登录后点击“检查状态”。
- Chrome 关闭、Mac 休眠或离线时不会更新；Chrome 的闹钟可能延后，不能保证永不断线。停止本机代理后扩展也不会将其重启。

扩展 storage.local 仅保存开关、检查/尝试时间、到期时间和固定状态码；维护标签页所有权使用 storage.session，浏览器重启后不会凭旧标识关闭页面。不持久化完整连接 URL、令牌、账号或聊天内容。

## 权限范围与验证状态

manifest 请求 webRequest、nativeMessaging、alarms、storage，以及 `wss://substrate.svc.cloud.microsoft/*`（请求目标）和 `https://copilot.cloud.microsoft/*`（发起页面）。Chrome 跨源请求监听同时需要这两项；https 权限不匹配 wss，因此请求目标必须明确使用 wss。不增加其他主机或全部网站权限，也不请求全局 tabs 权限；事件过滤器进一步限定 StreamHub 路径和 websocket 类型。

manifest 的固定公钥用于稳定扩展 ID，不是私钥或访问凭据。原生宿主仅接受配置中指定的扩展来源和已有账号路由。原有中继已通过两个模型的 Claude Code Read 往返；0.2.0 另实测了后台维护页建立连接、同步和自动关闭，保留用户已有页面。正常 SSO 登录取得更晚有效期与后台复用同一有效期两种情况均已验证；相同有效期准确记录为 valid_unchanged，不声称已延长。

此扩展只覆盖安装它的浏览器配置文件，不能观察未安装扩展的 Teams 或独立 Copilot 桌面 WebView。

参考：[Chrome webRequest 文档](https://developer.chrome.com/docs/extensions/reference/api/webRequest) 与 [Native messaging 文档](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。
