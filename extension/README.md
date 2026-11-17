# Local Copilot Session Relay

这是 Chromium Manifest V3 的本机会话中继扩展。它配合 Copilot Mac Proxy 的 native host，将正常 Copilot 页面产生的新会话同步到本机代理。首次使用必须先导入包含模型请求证据的 HAR，扩展无法仅凭握手确定模型映射。

仅监听浏览器中正常发起的目标 WebSocket 握手：目标主机为 substrate.svc.cloud.microsoft，路径为 /m365Copilot/StreamHub/。额外检查 wss 协议、路径形状、唯一 access_token 参数和长度；其他请求不会转发。不读取握手头、Cookie、请求体或 WebSocket 消息内容，不使用内容脚本、页面脚本、远程脚本、存储权限或网络上传。

完整连接 URL 含短期访问令牌和账号路由信息，属于敏感凭据。扩展只通过 Chrome native messaging 发送给固定本机宿主 local.codex.copilot_session_relay，不将它写入扩展存储或日志。日志只有固定状态文本。应当仅为本人获准会话安装，本机 host 必须校验允许的扩展 ID、目标 URL 和消息结构，且不能打印消息内容。

## Native messaging 协议

扩展每次观察到有效的新连接时调用 sendNativeMessage。输入是 JSON 对象，字段为：

- version：整数 1。
- type：固定值 copilot-streamhub-session。
- url：实际观察到的完整 wss 连接 URL；只发送给本机 host。
- capturedAt：当前 UTC ISO 时间。

Host 返回 {"ok":true} 表示已经接收。缺失 host、错误或其他返回值仅产生静态失败日志；不把失败详情或凭据回显到页面。原始 URL 不进入重试队列，下一次正常连接会再次尝试。

扩展不刷新令牌，不调用登录接口，也不主动触发请求。刷新由 Copilot 自己完成；若已有连接一直复用，需要用户正常重新打开/刷新 Copilot 以产生新的 WebSocket 握手。关闭浏览器后此方式不会续期。无法由握手推断模型 tone，模型映射仍必须来自已验证的请求证据。

## 权限范围与验证状态

manifest 请求 webRequest、nativeMessaging，以及 `wss://substrate.svc.cloud.microsoft/*`（请求目标）和 `https://copilot.cloud.microsoft/*`（发起页面）。Chrome 跨源请求监听同时需要这两项；https 权限不匹配 wss，因此请求目标必须明确使用 wss。不包含全部网站权限；事件过滤器进一步限定 StreamHub 路径和 websocket 类型。

manifest 的固定公钥用于稳定扩展 ID，不是私钥或访问凭据。原生宿主仅接受配置中指定的扩展来源和已有账号路由。测试已覆盖两次正常新连接触发的更新，并在更新后完成两个模型的 Claude Code Read 往返；这不意味着扩展能够自行延长令牌有效期。

此扩展只覆盖安装它的浏览器配置文件，不能观察未安装扩展的 Teams 或独立 Copilot 桌面 WebView。

参考：[Chrome webRequest 文档](https://developer.chrome.com/docs/extensions/reference/api/webRequest) 与 [Native messaging 文档](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。
