---
name: RainyDays
description: 一条五色条纹标出任务走到哪里的瑞士字体式桌面工作间
colors:
  stripe-1: "#C43D2B"
  stripe-2: "#E5752A"
  stripe-3: "#EFAE34"
  stripe-4: "#35A7BE"
  stripe-5: "#2B6CA8"
  paper: "#F1EDE1"
  ink: "#141B2D"
  muted-ink: "#5A5F6B"
  hair: "#D8D2C2"
  rail: "#E5E0D1"
  well: "#E8E3D5"
  input: "#FDFBF5"
  navy: "#14224A"
  deep: "#0E1A3A"
  dim-navy: "#A9B3CC"
  hold: "#F2622A"
  done: "#25663F"
  run: "#1F5F96"
  terminal-surface: "#090b10"
  terminal-ink: "#d6d9e0"
typography:
  task-title:
    fontFamily: "Noto Sans SC Variable, Microsoft YaHei UI, sans-serif"
    fontSize: "43px"
    fontWeight: 900
    lineHeight: 1.2
  welcome:
    fontFamily: "Noto Sans SC Variable, Microsoft YaHei UI, sans-serif"
    fontSize: "clamp(40px, 5.6vw, 84px)"
    fontWeight: 900
    lineHeight: 1.14
  user-message:
    fontFamily: "Noto Sans SC Variable, Microsoft YaHei UI, sans-serif"
    fontSize: "20px"
    fontWeight: 500
  body:
    fontFamily: "Noto Sans SC Variable, Microsoft YaHei UI, sans-serif"
    fontSize: "15px"
    lineHeight: 1.8
  numeric:
    fontFamily: "Michroma, sans-serif"
    fontSize: "40px"
    fontWeight: 400
  label:
    fontFamily: "IBM Plex Mono, monospace"
    fontSize: "11.5px"
    letterSpacing: ".04em"
rounded:
  all: "0"
spacing:
  stripe-band: "8px"
  stripe: "40px"
  column-pad: "44px"
  gutter: "72px"
layout:
  rail: "216px"
  panel: "300–404px"
  reading: "784px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.all}"
  button-secondary:
    backgroundColor: "{colors.input}"
    textColor: "{colors.ink}"
    rounded: "{rounded.all}"
  message-user:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.user-message}"
  composer:
    backgroundColor: "{colors.input}"
    textColor: "{colors.ink}"
    rounded: "{rounded.all}"
  hold-dialog:
    backgroundColor: "{colors.hold}"
    textColor: "{colors.ink}"
    rounded: "{rounded.all}"
---

# Design System: RainyDays

## Overview

**Creative North Star: "一条线走到底"**

瑞士字体排版，加一条 70 年代 NASA 式的单色带。五色条纹是界面唯一的装饰，而且它在传递信息：从品牌字标旁出发横过顶部，转弯进入右侧深蓝面板，沿步骤向下，停在当前步骤；后面的路用虚线表示，五条色带末端错开。其余一切靠字号、字重和留白组织，不靠卡片、气泡或阴影。

**Key Characteristics:**

- 一条会动的条纹，一眼看出任务走到哪一步
- 43px 粗体任务标题，左对齐，滚动后收成 19px
- 无气泡的对话：标签挂在左侧 56px 栏，正文贴着基线走
- 右侧面板只放真实数据：运行时钟、步骤、上下文表
- 几乎没有圆角

## Colors

条纹五色按序排列，不拆开单独当强调色用。`paper` 承载阅读，`rail` 区分导航，`well` 用于工具回执和代码块，`input` 留给输入框和设置浮层。`navy` 是右侧面板和空闲页的底，`deep` 是仪表区和空闲页状态栏，`dim-navy` 是深蓝底上的辅助文字。

状态色只表达状态：`hold` 橙色只用于等待批准，文字用深色；`run` 蓝色表示运行中；`done` 绿色表示完成。

**The One Stripe Rule.** 不新增第二条装饰线、渐变条或彩色标签。需要强调时，先用字重和字号。

## Typography

中文和正文用随应用打包的 Noto Sans SC 可变字体。选简体字形是因为界面文案是简体，Noto Sans TC 缺部分简体字形，会混入系统字体，同一行字重不一。

Michroma 只用于品牌字标、时钟和百分比这类拉丁字母与数字；时钟每位数字用固定宽度的格子，跳秒时不抖动。IBM Plex Mono 用于标签、模型名、快捷键和代码。

字体文件在 `public/vendor/fonts/`，由 `scripts/copy-vendor.mjs` 从 `@fontsource` 包复制。严格 CSP 不允许远程字体，不要改成 CDN。

## Layout

三栏：导航 216px，对话列自适应（阅读宽度最大 784px，左右内边距 44px），右侧面板随窗口在 300–404px 之间伸缩。消息贴左。

- **任务视图：** 条纹从导航右缘到面板左侧的圆弧，再沿步骤向下。
- **空闲视图：** 没有消息时，工作区变成深蓝底，收起任务面板和标题内容。条纹从会话内容区上方出发，位于工作台标签栏下方，沿右侧连续转弯并延伸到底。输入框保留纸色。左栏收起时，欢迎页左上仍有「会话」入口。
- **1180px 及以下：** 右侧面板和圆弧隐藏，顶部条纹表示已完成步骤的比例。默认只显示当前步骤和完成数，展开后可查看完整清单。
- **720px 及以下：** 导航变为抽屉，关闭后焦点回到会话入口。消息标签回到正文上方。

`--mission-prog` 由 `mission.js` 按实际步骤写入，下限 4%，保证未开始时也能看见。

## Motion

运行中一道高光沿条纹扫过（2.8 秒一圈）。HOLD 时条纹静止，当前步骤的刻线闪烁。步骤推进时色带下延（0.9 秒）。减少动态效果时全部关闭。

## Components

- **任务时钟：** 显示当前任务累计运行时间，按会话分别计时；显示待命、进行中、等待你批准、已完成及未完整结束的结果。
- **步骤：** 来自真实任务清单。没有拆分步骤时显示一句说明，不伪造步骤。
- **上下文表：** 半圆，50% 处开始整理、90% 处压缩各有刻度。百分比来自 memory 估算，不含工具 schema，所以是偏小的估计值。
- **导航：** 当前任务底色和对话区相同，像一个延伸出去的标签。行尾方块表示状态：橙色等待批准，蓝色运行中。
- **消息：** 用户消息 20px；助手正文 15px。"你"和"助手"标签挂在左栏。工具回执折叠成一行，运行中左侧 3px 蓝线。
- **HOLD 对话框：** 橙色用于授权请求。首行放「仅允许这一次」和「拒绝」，初始焦点落在「拒绝」。任务和会话级授权单独列出，附有效范围。
- **按钮：** 保持朴素的矩形，一个实心墨色主按钮，其余细边框。

## Don't

- **不做**日夜切换。
- **不做**航天控制台式的控件：切角按键、指示灯、ATT/PTT/TX 代号、读数窗、带保护盖的中止键、OFF/ON 拨杆。条纹是这套视觉里唯一的航天引用。
- **不用**气泡、卡片式消息、渐变背景或 emoji。
- **不把**设计稿或测试截图里的研究报告、视频下载、模型名写成产品承诺；它们是演示数据。
- 新增页面沿用真实状态：文件名、步骤、模型和计数都从实际数据来，建议入口只准备草稿。

## History

旧的"安静的对话工作间"（陶土色、圆角、居中阅读列）保留在 git 标签 `backup/pre-ui-redesign-20261110`。设计样稿在 `docs/design/redesign-2026-11/`。
