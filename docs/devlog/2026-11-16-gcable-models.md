# Gcable 模型与思考设置

用户于 2026-11-16 要求先接入三款公司模型及各自的思考控制，再开展下一轮开发。基线 e390747；本轮不推进其他 D+A 票据。

## 行为

设置 → 模型配置增加内置预设、思考开关和强度。一键添加三款模型只沿用已保存且地址严格匹配公司模型池的凭据，经既有凭据库分别保存；保留当前与默认模型。重复添加保留已调整的配置；不覆盖同名其他模型。配置仍保存为服务端公布的模型别名，旧配置、导入导出、重启及摘要调用沿用现有格式。

| 模型 | 思考开关 | 强度与请求别名 |
|---|---|---|
| Gcable-Pro | 开/关，关闭用 Gcable-Pro | low → Gcable-Pro-Low；high → Gcable-Pro-High；max → Gcable-Pro-Max |
| Gcable-Plus | 开/关，关闭用 Gcable-Plus | low → Gcable-Plus-Low；medium → Gcable-Plus-Medium；xhigh → Gcable-Plus-XHigh |
| Gcable-Max | 固定开启 | low → Gcable-Max-Low；high → Gcable-Max-High；max → Gcable-Max-Thinking-Max |

依据：2026-11-16 直接读取公司网关的 [公开模型目录](https://api.playground.ai.gcable.cc/api/pricing)，字段 thinking_modes、thinking_efforts、thinking_variants；[模型页面](https://api.playground.ai.gcable.cc/pricing)。目录为当前快照，后续模型池调整时需要同步。

会话内 thinking_effort_get/set 按最近一次实际请求的模型提供可用强度；关闭思考时不允许工具重新启用。Gcable 使用专用别名，不叠加通用 reasoning_effort，不把 xhigh/max 压成 high。切换模型别名后忽略旧模型的会话强度覆盖。其他提供方保留原有请求行为。

## 验证

- `npm run check:product`：类型、lint、产品 180/180、UI 15/15 通过。
- `node --test --test-name-pattern 'Gcable presets' tests/integration/ds09-settings-api.test.mjs`：1/1。覆盖同池凭据、拒绝跨提供方复制、CAS 冲突、重复添加、别名保存/导出/重启及密钥不回显。
- `node --test --test-name-pattern 'Gcable model controls' tests/electron/development-launch.test.mjs`：1/1。真实 Electron 操作三款模型的九个强度、两个开关并保存回读；确认 Max 开关禁用。
- 请求测试覆盖流式、非流式、连接探测、会话覆盖与模型切换；使用本地合成提供方，未新增真实模型质量评测。
- 界面截图：本机 `test-results/gcable-settings-desktop.png`，不进 Git。
- 现用桌面已重启到本轮源码，通过设置页执行三款配置添加；本机配置确认 Gcable-Pro / Plus / Max 各有凭据引用，原 default 与 deepseek 保留。现用设置未显示或导出密钥；当前/默认仍为原 default。

在现用环境恢复长对话时，发现大量文件链接同时调用 ensureFileRoots，查询积压导致设置请求等待和服务健康探测超时。增加同会话进行中查询合并；强制刷新仍独立发送。桌面回归先复现 20 次请求，再验证合并为 1 次。保留原始会话与文件。

## 范围与恢复

本轮是模型选择及请求路由接入，不代表九种强度均已通过真实任务质量或上下文容量认证。回退产品提交可撤销界面和路由；已保存配置采用网关本身支持的别名，仍可由旧版按普通 OpenAI compatible 模型使用。
