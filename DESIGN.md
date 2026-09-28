---
name: RainyDays
description: 以对话和可检查的成果为中心的安静桌面工作间
colors:
  canvas: "#f6f5f1"
  panel: "#fffefa"
  control-surface: "#f8f7f3"
  output-surface: "#fbfaf7"
  sidebar: "#efeee9"
  ink: "#292824"
  muted-ink: "#6d6a64"
  clay: "#a6543a"
  clay-muted: "#c49484"
  line: "#dedbd4"
  user-message: "#ebe8e3"
  tool-surface: "#f0eee9"
  hover: "#e8e5df"
  success: "#3d7957"
  danger: "#b0443b"
typography:
  headline:
    fontFamily: "Segoe UI Variable, Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    letterSpacing: "-.025em"
  title:
    fontFamily: "Segoe UI Variable, Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "19px"
    fontWeight: 650
    letterSpacing: "-.035em"
  body:
    fontFamily: "Segoe UI Variable, Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "15px"
    lineHeight: 1.75
  label:
    fontFamily: "Segoe UI Variable, Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "12px"
    fontWeight: 550
rounded:
  small: "8px"
  control: "10px"
  row: "11px"
  message: "13px"
spacing:
  compact: "8px"
  row: "12px"
  content-narrow: "22px"
  content-wide: "38px"
components:
  button-primary:
    backgroundColor: "{colors.clay}"
    textColor: "{colors.panel}"
    rounded: "{rounded.small}"
    size: "38px"
  button-secondary:
    backgroundColor: "{colors.control-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.row}"
    height: "44px"
  message-user:
    backgroundColor: "{colors.user-message}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.message}"
    padding: "15px 19px"
  output-row:
    backgroundColor: "{colors.output-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.row}"
    padding: "8px 12px"
---

# Design System: RainyDays

## Overview

**Creative North Star: "安静的对话工作间"**

工作中的对话和成果文件是主角。暖瓷色画布、浅暖灰导航、深墨色文字与少量陶土色动作组成克制的桌面界面。用户先看到可读的对话；文件、终端和高级设置在需要时打开。这个方向来自用户选择的 A 稿及 Claude Code 感受参考，不复制其品牌标识。

**Key Characteristics:**

- 清楚的文字层级
- 无卡片包裹的助手正文
- 紧凑的成果行
- 按需展开的工具
- 原创三笔雨滴标记与细线图标

## Colors

主色 `clay` 用于品牌标记、发送、成果计数与少数强调操作。`canvas` 承载阅读，`sidebar` 区分会话导航，`panel` 留给输入、菜单及文件行。`ink` 是正文，`muted-ink` 是辅助说明，`line` 分隔必要边界。成功和错误状态分别使用 `success`、`danger`，并配文字表达状态。

**The Quiet Accent Rule.** 陶土色只提示身份、主要动作和局部重点，不铺满大面积容器。

## Typography

中文界面使用系统无衬线字体栈。会话标题用 `headline`，品牌名用 `title`；消息正文用宽松行距的 `body`；导航、成果摘要与辅助信息使用较小的 `label` 字阶。代码、终端及路径可保留原有等宽排版。助手正文靠段落和标题组织，不依赖消息卡片制造层级。

## Layout

宽屏左侧会话栏为 260px，顶部标题栏为 76px；消息与输入区共用最长 820px 的居中阅读列，宽屏水平内边距 38px。成果文件放在对话流尾部，以紧凑行呈现。设置为遮罩对话框，文件查看器与终端通过更多工具及工作台按需出现。

在 900px 以下，侧栏收至 218px，内容内边距改为 22px。在 650px 以下，侧栏改为可开合抽屉，标题栏收至 60px，消息左右内边距为 13px；成果行允许按钮换行，文件查看器占满视口宽度。输入框持续位于阅读列底部。

## Elevation & Depth

常态界面主要靠表面色差和细边框区分层级。新建对话按钮与成果行保持平面；输入框仅有轻微环境阴影。浮层菜单、设置对话框及窄屏侧栏使用更明确的阴影，表示它们位于当前工作内容之上。

## Shapes

图标是统一的 1.7px 圆端细线 SVG，品牌三笔标记更醒目。控件与成果行使用柔和小圆角；用户消息略圆，助手正文不加外框。分隔线只用于导航、标题、输入或文件区域需要明确边界的地方。

## Components

- **会话导航：** 新建、搜索、最近会话和设置纵向排列；当前会话用浅暖灰底与较粗文字标识。窄屏可开合，遮罩与关闭按钮让返回对话明确。
- **消息：** 用户请求右对齐并置于浅灰气泡；助手回复左对齐、带三笔标记，以自然排版显示文本、列表、表格和代码。执行记录保留可检查的细节。
- **成果行：** 文件类型、实际文件名与“打开／继续修改”同处一行；仅在真实工具回执提供成果时出现。窄屏操作换到下一行，文件名可截断但不丢失操作入口。
- **输入区：** 附件、语音、文本和陶土色发送按钮同列；聚焦时边框与柔和外圈变化。保留 Enter 发送、Shift + Enter 换行提示，以及上传、录音、禁用和错误状态。
- **工具与设置：** 次级工具收在更多菜单；设置对话框分域导航，文件查看器在工作台中提供目录、筛选和预览。二者延续暖色表面与细边界，保留各自的功能状态。

## Do's and Don'ts

### Do:

- **Do** 让对话文字和可操作的成果首先被看到，并在真实状态下显示处理、等待、成功或失败。
- **Do** 在新屏幕沿用暖色表面、细线图标、可见键盘焦点与窄屏重排。
- **Do** 让文件名、计数和能力说明取自真实数据流。

### Don't:

- **Don't** 把助手回复改成成排大卡片，或让文件工具长期占据默认工作区。
- **Don't** 用渐变、霓虹边缘、装饰性仪表盘、emoji 或借用 Claude 标识代替当前视觉语言。
- **Don't** 将设计稿或测试截图中的研究报告、数据表、示例对话及数量写成产品承诺；它们是演示数据。
