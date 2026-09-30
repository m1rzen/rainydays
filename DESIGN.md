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
  muted-ink: "#65625c"
  clay: "#a6543a"
  clay-deep: "#8e432e"
  clay-muted: "#c49484"
  line: "#dedbd4"
  user-message: "#ebe8e3"
  tool-surface: "#f0eee9"
  hover: "#e8e5df"
  selected: "#e2ded7"
  success: "#39734f"
  danger: "#a43d35"
  code-surface: "#eeece7"
  code-inline: "#eceae5"
  code-keyword: "#99503b"
  code-string: "#3e7050"
  code-number: "#4a6082"
  terminal-surface: "#090b10"
  terminal-ink: "#d6d9e0"
  terminal-cursor: "#8b7cf6"
typography:
  display:
    fontFamily: "Segoe UI Variable, Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "27px"
    fontWeight: 550
    lineHeight: 1.5
    letterSpacing: "-.025em"
  headline:
    fontFamily: "Segoe UI Variable, Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "14px"
    fontWeight: 550
    letterSpacing: "0"
  title:
    fontFamily: "Segoe UI Variable, Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    letterSpacing: "-.035em"
  body:
    fontFamily: "Segoe UI Variable, Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "14px"
    lineHeight: 1.8
  label:
    fontFamily: "Segoe UI Variable, Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  caption:
    fontFamily: "Segoe UI Variable, Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "11px"
    lineHeight: 1.6
  metadata:
    fontFamily: "Segoe UI Variable, Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "10px"
  mono:
    fontFamily: "Cascadia Code, Consolas, monospace"
    fontSize: "12px"
    lineHeight: 1.55
  terminal:
    fontFamily: "Cascadia Mono, Cascadia Code, Consolas, monospace"
    fontSize: "13px"
rounded:
  compact: "5px"
  control: "6px"
  field: "7px"
  row: "8px"
  surface: "10px"
  dialog: "12px"
spacing:
  tiny: "4px"
  compact: "8px"
  row: "12px"
  inset: "16px"
  section: "24px"
  gutter: "32px"
components:
  button-primary:
    backgroundColor: "{colors.clay}"
    textColor: "white"
    rounded: "{rounded.control}"
    size: "32px"
  button-secondary:
    backgroundColor: "{colors.control-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    height: "38px"
    padding: "0 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.compact}"
    height: "30px"
  search-input:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.field}"
    height: "34px"
    padding: "0 10px 0 37px"
  nav-session:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    height: "36px"
    padding: "7px 30px 7px 13px"
  attachment-chip:
    backgroundColor: "{colors.output-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.field}"
    padding: "6px 8px"
  message-user:
    backgroundColor: "{colors.user-message}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "11px 16px"
  output-row:
    backgroundColor: "{colors.output-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.row}"
    height: "58px"
    padding: "9px 11px"
  composer:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    width: "760px"
    padding: "10px 10px 8px"
  tool-receipt:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.field}"
---

# Design System: RainyDays

## Overview

**Creative North Star: "安静的对话工作间"**

工作中的对话和成果文件是主角。暖瓷色画布、浅暖灰导航、深墨色文字与少量陶土色动作组成克制的桌面界面。用户先看到可读的对话；文件、终端和高级设置在需要时打开。这个方向来自用户选择的 A 稿及 Claude Code 感受参考，不复制其品牌标识。

比例、字阶、图标与组件细节共同维持安静感。紧凑的导航、标题和控件为正文留下空间；新增表面沿用已落地的尺度和层级。

**Key Characteristics:**

- 清楚而紧凑的文字层级
- 无卡片包裹的助手正文
- 紧凑的成果行与可展开的执行回执
- 两行输入区与按需展开的工具
- 原创三笔雨滴标记与统一细线图标

## Colors

`clay` 用于品牌雨滴、发送与局部重点；`clay-deep` 用于主动作悬停与 Provider 徽标。`canvas` 承载阅读，`sidebar` 区分导航，`panel` 留给输入与浮层；`control-surface`、`output-surface` 承载轻量按钮、成果、附件与字段。`ink` 是正文，`muted-ink` 是可读的辅助说明、占位文字与常规图标。`line` 分隔必要边界；`hover` 与 `selected` 通过暖灰色差表达状态。助手正文保持透明。

成功和错误分别使用 `success`、`danger`，并配文字或图标。成果文件类型使用中性细线 SVG。`code-surface` 与 `code-inline` 区分代码块和行内代码；`code-keyword`、`code-string`、`code-number` 提供局部语法色，注释沿用 `muted-ink`。终端内部保留 `terminal-surface`、`terminal-ink`、`terminal-cursor` 与现有 ANSI 调色板，外层工具栏沿用暖色界面。

**The Quiet Accent Rule.** 陶土色只提示身份、主要动作和局部重点，不铺满大面积容器。

## Typography

中文界面使用系统无衬线字体栈。欢迎标题用 `display`（窄屏 24px），会话标题用 `headline`（窄屏 13px），品牌名用 `title`；设置标题沿用品牌字号、字重稍轻（600），设置章节略大（17px）。助手正文用 `body`，用户请求和输入文字行距稍紧（1.7）；窄屏消息字号收至 13px。

导航、成果与字段使用 `label`，新建和文件查看器标题略大（13px）；选中导航和文件名局部加重（550）。模型、次级动作与帮助用 `caption`，状态、类型与键盘提示用 `metadata`，辅助字阶保持紧凑（10–13px）。代码编辑与终端分别用 `mono`、`terminal`。助手正文靠段落和标题组织，不依赖消息卡片制造层级。

## Layout

宽屏侧栏为 240px，顶部标题栏为 56px；消息、成果与输入共用最大 760px 的居中阅读列，水平内边距 32px。助手标记与正文相隔 34px，成果沿正文起点对齐；用户气泡右对齐，最大 610px。桌面侧栏可以收起，标题栏保留展开入口，阅读列重新居中。单一会话隐藏工作台页签；多个工作表面按需显示页签和分栏控制。

设置为居中遮罩对话框（最大 980px，四周预留 32px），分类栏为 198px。在 980px 及以下，侧栏收至 216px，内容水平内边距改为 24px。在 720px 及以下，侧栏成为模态抽屉（最大 270px 或 84vw），标题栏收至 50px，消息与输入左右内边距分别为 16px、12px；成果操作允许换行，文件查看器占满视口宽度。设置分类栏收至 132px，表单转为单列。在 520px 及以下，设置分类栏收至 100px并隐藏分类图标，模型标签继续截断。输入区持续位于阅读列底部。

## Elevation & Depth

常态界面主要靠表面色差和细边框区分层级。新建对话与成果行保持平面；输入区只有轻微环境阴影（`0 2px 6px #312b2306`），聚焦时边框与外圈变化（`0 0 0 2px #a6543a0d`）。菜单使用轻浮层阴影（`0 8px 24px #352f271f`），设置使用更明确阴影（`0 18px 60px #29262126`）。确认框、抽屉和浮动文件查看器的完整阴影记录于 `.impeccable/design.json`。

控件颜色反馈使用短过渡（160ms），输入聚焦与抽屉位移稍长（180ms）；减少动态效果时关闭过渡、动画与平滑滚动。

## Shapes

主圆角按紧凑动作、常规控件、字段、行、表面与对话框逐级展开（5、6、7、8、10、12px）；小型附件移除等局部工具可用 4px。用户气泡和输入区使用 `surface`，设置使用 `dialog`，助手正文不加外框。

常规 SVG 共用 24×24 视框，三笔雨滴使用 32×32。描边统一圆端、圆连接（1.65px）；常见图形为 14–18px，成果文件图标稍大而更轻（24px、1.35px），品牌雨滴使用专属粗细（2.6px）。图标大小与点击区域分开定义，顶栏图标按钮为 32×32px。键盘焦点使用陶土色外框（2px、外偏移 2px），输入文字通过整个输入区表达聚焦。

## Components

- **会话导航：** 新建、搜索、最近会话和设置纵向排列；新建为轻边框按钮（38px 高），搜索默认融入侧栏（34px 高），选中会话靠暖灰底、图标与局部字重表达（最小 36px 高）。窄屏抽屉打开后焦点进入关闭按钮，背景不可操作，Tab 留在最上层，Escape 关闭并归还焦点；嵌套设置、确认框沿用同一焦点栈，隐藏导航不进入键盘顺序。
- **消息与回执：** 用户请求右对齐并置于轻灰气泡（11px × 16px 内边距）；助手回复左对齐、带三笔标记，以自然排版显示文本、列表、表格和代码。表格与代码在自身区域内滚动。工具回执默认折叠为紧凑摘要（最小 36px 高），显示名称与实际状态，展开后保留可检查细节。
- **成果与附件：** 成果行使用中性文档／表格图标、真实文件名及类型说明（最小 58px 高）；“打开”是细边框动作，“继续修改”是轻量文字动作（均 30px 高）。窄屏操作换行，长文件名可截断。仅在真实工具回执提供成果时出现；附件草稿沿用浅色表面、状态和移除入口。
- **输入区：** 上行写消息，下行左侧放附件、语音和实际助手模式，右侧放实际模型配置与发送／停止。空文本区最小 43px、增长至最大 150px；工具点击区域 30px，发送／停止 32px。模型未配置时显示“配置模型”，点击进入模型设置。保留 Enter／Shift + Enter 提示，以及上传、录音、禁用、运行和错误状态。
- **欢迎状态：** 欢迎标题、雨滴与三条轻量建议沿用阅读列。建议只填入并聚焦草稿，用户提交后才执行。
- **工具与设置：** 次级工具收在更多菜单，语音播报显示实际开关状态。设置分域导航与紧凑字段（通常 34px 高）、小动作（通常 30px 高）沿用真实配置状态。文件查看器提供现有目录、筛选、分页、预览与操作；终端保留独立技术内容表面，外围控件和工作台页签沿用统一尺度。

## Do's and Don'ts

### Do:

- **Do** 让对话文字和可操作的成果首先被看到，并在真实状态下显示处理、等待、成功或失败。
- **Do** 让新表面沿用紧凑字阶、统一图标、暖色层级与当前阅读尺度。
- **Do** 保留可见键盘焦点、窄屏重排、模态焦点归还与不可操作的背景状态。
- **Do** 让文件名、计数、模型和能力说明取自真实数据流；建议入口只准备草稿。

### Don't:

- **Don't** 把助手回复改成成排大卡片，或让文件工具长期占据默认工作区。
- **Don't** 用渐变、霓虹边缘、装饰性仪表盘、emoji 或借用 Claude 标识代替当前视觉语言。
- **Don't** 为成果文件添加额外品牌色块，或通过放大标题、控件和圆角打破当前紧凑比例。
- **Don't** 将设计稿或测试截图中的研究报告、数据表、示例对话、模型名称及数量写成产品承诺；它们是演示数据。
