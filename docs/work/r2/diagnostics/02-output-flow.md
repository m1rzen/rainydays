# R2-02 桌面流程诊断

复现入口：`node --test --test-name-pattern "R2 real Electron completes" tests/electron/desktop-smoke.test.mjs`。

1. 首次测试启动失败：日志明确说明 HTTP loopback 模型需要开发模式。测试夹具原先为无模型的 provider.invalid；这次加入本机 HTTP 服务，却未打开已有的开发开关。仅对指定本机模型 URL 的测试设置 RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER=1，无产品策略变化。
2. 流程通过后截图发现顶部成果标题被遮住，窄窗口输入框不可见。候选为面板高度、焦点自动滚动、文字横向溢出。CSS 显示工作台根 pane 缺少高度约束，子 view 使用 100% 高度；内容撑高后焦点滚动父级。补足 pane 高度、用户长路径换行，并在两种窗口尺寸断言成果标题和输入框同时处于工作台范围。
3. 后续重跑偶发成果预览超时。候选为解析失败、会话选择、异步目录刷新清空预览。捕获到的界面状态是默认“选择文件以预览”，同一正确 session/owner，selected 为空，模型无错误，证明预览被清空。原 openFileDirectory 在响应完成后无条件 clearFilePreview，能清除请求开始之后才打开的文件。单独在目录响应比较 preview generation 仍不足：renderWorkbenchLayout 延迟等待根目录返回后才开始另一轮目录请求，可能在预览开始之后再次刷新。修复两处：后台根目录请求结束时检查目录/预览是否已推进，目录响应也检查预览是否已推进。增加受控延迟目录请求：请求先开始，再打开文件，最后释放目录响应，预览必须保留。复用现有 generation，不增加轮询或放大超时。

所有资料、输出、配置与数据库均在临时用户目录；测试关闭该 Electron 进程树后清理夹具。未读取真实凭据。
