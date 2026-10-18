# 产品开发的短反馈路径

本文只说明测试入口与已知限制；执行顺序见[D+A总路线](work/general-agent/plan.md)，当前事实见[STATUS](STATUS.md)。

在项目根目录运行：

```powershell
npm run check:product
```

此入口依次运行 typecheck、lint、源码产品回归及界面/IPC 核心检查。产品回归不调用真实模型。R2 文档测试复用已构建的隔离解析 worker，因此首次运行或修改解析器后先执行 `npm run build`。覆盖资料完整性、SQLite 恢复、Agent 断流、文档分页以及本地 HTTP/SSE，无旧任务卡清单生成。

与本次改动相关的构建后回归：

```powershell
npm run test:product:desktop
```

此入口先构建，依次验证实际源码桌面启动、存储 ABI、输入框增高/收回、鉴权、R1 断流、R2 附件与文档产出/预览/恢复。Electron 测试使用临时用户目录和假模型配置，会启动测试窗口后自动关闭。聊天响应由测试流提供，验证界面行为，不计入真实任务成功率。

发布前仍需必要的权限、取消、恢复回归，以及候选安装包和真实任务验收。以上短反馈命令不取代发布验收。全 RT-04 当前存在独立的两项 Playbook 接口不匹配，详见 [R1 评审](work/r1/reviews/01-code-review.md)。

## 命令范围

| 入口 | 用途 |
|---|---|
| `check:product` | 日常核心反馈；也可单跑 `test:product` / `test:product:ui` |
| `test:product:desktop` | 修改桌面、附件、成果、模型流后运行 |
| `test` / `test:quick` / `governance:*` | 旧全库/任务卡证明路径，继续保留；结果须区分行为缺陷与历史清单债务 |
| `dist` / `test:package` | 安装候选构建与打包检查，另需D13–D18/A13的干净安装、恢复、取消与真实任务验收 |

bf3a7e4是[历史WIP保存点](audits/wip-baseline-2026-09-30.md)，当前源码事实以STATUS为准。保存提交不表示所有模块已验收；新增能力按D/A当前票据补充相关检查，不把旧证明清单作为普通功能的统一前置。
