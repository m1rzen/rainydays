# R3 桌面反馈修复

2026-09-30。

输入框：实际 Electron 先红，style 属性为 `--input-height: 43px`。原因是 JS 动态 style 与已有严格 CSP 静态契约冲突。改为 CSS field-sizing、min/max-height 与 overflow；实际短消息 43px、多行增长、40 行 150px 且滚动、清空 43px，静态契约也通过。

断流回归：全桌面命令首次 3/4，R1 第二次断流等待超时。检查页面定位发现 `msg-assistant:last-child` 要求消息也是最后一个 DOM 子元素，成果 panel 在第一次刷新后追加于消息后；真实回答存在。改为最后一条助手消息中的 bubble，原单用例再跑通过；未修改断流处理。其余 R2 PDF 上传、Word/Excel 生成/重开/另存与源码启动均通过。

临时日志在 ignored test-results 中；没有用户密钥或真实任务数据。源码快速检查 23.01 秒；完整桌面门槛含多次启动约 2–3 分钟，独立于日常反馈。
