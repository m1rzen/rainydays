# Lux Cloud bootstrap 接入诊断

日期：2026-11-16。用户确认该实例由本人或公司管理、允许外部接入，并要求通过有线网卡访问。使用用户指定的佛山组织完成官方钉钉扫码登录。用户在取得诊断结果后选择先交付诊断。

## 当前结论

已打通有线访问、官方登录、工作台会话和当前账号应用入口，读取到 5 个共享模型。已验证的 bootstrap 返回登录票据，不返回模型 API Key。当前账号读取共享 Provider 配置被服务端以 `403 provider_permission_denied` 拒绝，因此本轮未取得可迁移的模型凭据，未新增 Lux 来源的 RainyDays 模型配置。

这说明当前已验证的接口和账号权限不足以完成凭据导入；不能据此判断平台不存在其他经过授权的独立推理接口或管理员导出功能。

## 已验证的链路

| 步骤 | 观察结果 | 含义 |
|---|---|---|
| 默认网络访问 | 目标流量进入 TAP 虚拟网卡，HTTPS 失败 | 原先的 TLS 错误与访问路径有关 |
| 请求绑定实体有线网卡 | HTTPS 正常，入口返回 303 | 可用请求级有线直连访问；TLS 证书正常校验 |
| 官方扫码登录 | 钉钉确认接口返回有效登录结果 | 已验证当前扫码账号的身份 |
| 工作台会话与应用票据 | 会话建立成功，票据交换成功，应用页面 HTTP 200 | 已进入官方为当前账号返回的既有应用 |
| bootstrap 数据 | `origin`、`app_url`、`bootstrap_url`、`expires_in`、`ticket` | 是登录入口交换信息，未返回模型 Key |
| 私人 Provider 清单 | 返回 0 项 | 当前账号未配置私人 Provider |
| `user_runtime.get` | 返回 5 个共享模型，目录均标记 `can_invoke: true` | 账号有平台内的模型调用授权；本轮未执行真实模型推理 |
| 读取共享 Provider 配置 | HTTP 403，`provider_permission_denied` | 当前账号不能通过该管理接口读取配置或取得底层 Key |

原始入口：[用户指定的 Lux 地址](https://lux_cloud.rmaxis.com/app/9e11bb8d4ac141118de8b87b046a5e06/)。官方登录后返回的应用入口与该地址不同；已核对新入口对应当前登录 owner 的既有 Base。原地址是否为旧版或其他入口尚未确认，因此模型清单结论仅适用于此次登录账号的当前目录。

接口行为依据同站实际返回的数据及其官方前端调用流程，包括 `/config.json`、IAM 钉钉 start/finish、工作台 session/enter、应用 `_bootstrap`、`_session`、`_endpoints` 和 Provider 管理接口。账号、原始响应、Cookie、票据及密钥不进入本记录。

## 当前账号的共享模型

| 模型 | 上游协议 | 目录声明的思考能力 | RainyDays 当前适配情况 |
|---|---|---|---|
| deepseek-flash | OpenAI Chat Completions | 开关；low / high / max | 已有同类协议适配，待独立凭据与真实连接验证 |
| deepseek-v4-pro | OpenAI Chat Completions | 开关；low / high / max | 已有同类协议适配，待独立凭据与真实连接验证 |
| glm-5.3 | Anthropic Messages | 开关；low / high / max | 需要 Anthropic 适配器或平台提供 OpenAI 兼容入口 |
| glm-5.3-flash | Anthropic Messages | 开关；low / high / max | 需要 Anthropic 适配器或平台提供 OpenAI 兼容入口 |
| qwen3.8-27b-int4-autoround | OpenAI Chat Completions | 声明不支持可配置思考 | 已有同类协议适配，待独立凭据与真实连接验证 |

上述能力来自目录声明，不是质量、上下文容量或任务完成率的实测成绩。交付时核对源码 `3247477`，`src/config.ts` 的 `assertProviderAdapterAvailable` 仍仅启用 `openai-compatible` / `openai-compatible-vision`。

## 完成接入所需的平台材料

优先由平台签发 RainyDays 专用调用凭据，并提供：接口地址、认证方式、可调用模型名、思考参数、额度与有效期。若平台提供经过授权的统一推理代理，RainyDays 可使用代理凭据，底层共享 Key 继续由平台管理。

若选择导入现有 Provider，则需要具备相应读取/导出权限的管理账号及平台正式提供的导出方式。当前账号的模型调用授权本身不足以证明具有底层共享 Key 的导出权限。

取得有效接口后，按实际协议完成配置或适配，以一条短消息、一次工具调用、流式结束、思考开关/强度及重启恢复验证接入。

## 本机接续与本轮范围

登录状态已通过 Windows 当前用户 DPAPI 加密保存在本机独立的集成目录，配有可接续的登录与只读查询助手；不进入仓库。此前临时执行环境重置导致重新扫码一次，现已验证加密保存和跨进程读取。

本轮完成网络与认证接续、当前账号模型目录读取及权限诊断。本轮未修改 RainyDays 产品源码及模型设置，未运行完整产品回归或新增真实模型推理测试。仓库仅增加本诊断及状态索引。
