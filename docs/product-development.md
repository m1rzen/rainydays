# 产品开发的短反馈路径

在项目根目录运行：

```powershell
node --import tsx --test tests/product/*.test.mjs
npm run typecheck
```

第一条直接测试当前源码，不依赖旧 dist、不调用真实模型。覆盖资料完整性、SQLite 恢复、Agent 断流持久化以及本地 HTTP/SSE。当前切片不需要先生成所有旧任务卡的证明文件。

与本次改动相关的构建后回归：

```powershell
npm run build
node --test --test-name-pattern "LLM|memory" tests/integration/rt04-runtime-cancellation.test.mjs
node --test --test-name-pattern "R1 real Electron" tests/electron/desktop-smoke.test.mjs
```

Electron 测试使用临时用户目录和假模型配置，会启动测试窗口后自动关闭。聊天响应由测试流提供，验证界面行为，不计入真实任务成功率。

发布前仍需必要的权限、取消、恢复回归，以及候选安装包和真实任务验收。以上短反馈命令不取代发布验收。全 RT-04 当前存在独立的两项 Playbook 接口不匹配，详见 [R1 评审](work/r1/reviews/01-code-review.md)。
