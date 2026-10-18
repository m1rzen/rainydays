# D01 旧文件标签与目录恢复

用户批准D+A后，从D01实施并验证。旧定义绑定在文件根路由丢失错误代码、统一400；现在返回409/SESSION_PERSONA_CHANGED，文件标签提供打开原对话的入口，复用只读历史和继续副本。工作目录被移走时，切换可用根同时清空旧子路径，缓存命中也重新核对。

两项真实Electron回归先红后绿；正常干净/旧数据各10次通过，旧消息和附件内容可核对。产品26+UI15、目录路径3、supervisor6及最终缺陷/后台恢复3项均通过；build为0.1.0+local.4ef1d44d311d。

用户补充Z盘需要公司内网，旧配置修改意在避免依赖Z盘；本轮确认本机缺失部门目录本就可降级。真实SMB断网时延留D05，源码并发测试曾有初始化超时留D13，历史单次后台退出未确认根因。没有读取日常数据库或调用真实模型，也没有新建安全框架。

执行与回退范围见[D01票据](../work/colleague-delivery/tickets/01-startup-and-old-data.md)、[诊断](../work/colleague-delivery/diagnostics/01-startup-and-file-roots.md)和[审查](../work/colleague-delivery/reviews/01-startup-code-review.md)。
