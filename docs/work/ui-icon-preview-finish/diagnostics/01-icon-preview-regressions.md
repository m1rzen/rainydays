---
workflow: project-workflow
kind: diagnostic
ticket: ui-icon-preview-finish
status: resolved
---

# Diagnostic — 图标变形与成果预览延迟

## Exact symptom

- 设置入口的齿轮在 Windows 桌面应用中被压扁。
- 底部状态栏的语音播报图标尺寸过小，边缘裁切后呈现为破碎线条。
- 打开“成果”后，文档预览偶发长时间停留在“正在加载预览…”。

## Feedback loop

- Command: `node --test tests/unit/ui-icon-contract.test.mjs`
- Why it can catch this bug: 静态检查设置图标的 SVG 几何、语音播报控件的位置、固定尺寸和更新方式。
- Speed and determinism: 单文件测试，不启动桌面应用，通常在一秒内完成。
- Redacted failing evidence: 修复前测试检测到设置图标含纵向缩放变换，并且语音播报仍位于 26px 高的状态栏。

## Minimal reproduction

1. 启动桌面应用并查看左下角“设置”。
2. 查看右下角语音播报按钮。
3. 打开“成果”，进入一个含 Markdown 文件的目录并选择文件。

## Ranked hypotheses

1. 设置齿轮路径使用非等比纵向缩放，预测源码中存在 `scale(1 .88)`。
2. 语音播报图标放在过矮状态栏且路径贴近 SVG 边界，预测提高可用空间并采用内缩路径后显示恢复。
3. 成果预览前重复加载同一目录，预测请求记录中会出现两次 `/api/files/list`，并推迟后续预览请求。

## Experiments and evidence

| Hypothesis | Probe | Result | Interpretation |
|---|---|---|---|
| 1 | 检查 `i-settings` 符号 | 存在 `transform="translate(0 1) scale(1 .88)"` | 支持 |
| 2 | 对照截图与状态栏尺寸 | 控件被限制在 26px 高区域，图形缺少文字辨识 | 支持 |
| 3 | 记录成果面板的文件请求 | 一次打开动作产生两次目录列表请求 | 支持 |

## Root cause and fix

- Root cause: 非标准缩放改变了齿轮宽高比；语音播报使用无文字的小型边缘路径；成果面板的渲染函数和切换函数同时发起目录加载。
- Fix: 使用无变换的标准 24×24 齿轮路径；把语音播报移入带文字与状态的工具菜单，使用留有安全边距的音量路径；移除切换函数中的重复目录加载。
- Regression test or missing seam: 新增 UI 图标契约测试，并在真实桌面流程中断言一次打开只产生一次目录列表请求。

## Verification and cleanup

- Original loop result: 修复前图标契约测试失败，能够稳定捕获设置图标变形。
- Regression test result: 修复后图标契约测试通过；真实桌面流程完成成果打开、预览、恢复与副本修订，并确认目录列表只请求一次。
- Temporary instrumentation removed: 请求记录只保留在现有端到端测试环境中。
- Remaining uncertainty: 无。桌面、窄窗口以及 125% 显示缩放截图均已人工检查；齿轮保持等比，语音图标在带文字控件内完整显示。
