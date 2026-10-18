# D02 本地模型契约与可选资料根诊断

日期：2026-10-18；起点b2cda55。仅使用loopback模型、合成文本和临时数据库，无日常凭据或真实模型。

## 红到绿

`node --import tsx --test tests/product/model-contract.test.mjs`：初始两项均Missing expected rejection。非流式finish_reason=length仍返回成功；流式完整结束标志附残缺JSON仍产生result。共享完成检查后两项及原6项stream回归通过。随后usage两项分别以undefined失败，补标准include_usage及最终空choices处理后通过。缺失或无效用量仍未知，不编造0。

新增真实Agent集成原先两次均收到read错误“Path root is unavailable: DATA_ROOT”。区分三种假设：相对路径默认根错误（换绝对路径仍失败，排除）、已选工作区授权不足（schema/权限/approval已通过，尚未进入gateway）、工具入口强制默认根（源码在绝对路径判断前require DATA_ROOT，确认）。仅修read：绝对路径直接交既有路径gateway选择已授权根，相对路径继续要求默认资料根。未放宽路径权限。

`node --import tsx --test tests/product/model-agent.test.mjs`：最终3/3通过；无DATA_ROOT时三次实际文件读取成功、结果按ID送回模型，残缺JSON整批不执行，范围外绝对路径仍PATH_ROOT_DENIED。这里的“模型”是受控HTTP服务，不能证明模型内容质量。glob/grep/legacy默认根与断网时延交D05。

取消fixture初稿把对象传给response.write导致测试失败/悬挂；改为真正SSE字节后重跑全部21项通过。仅结束自身测试进程，不作为产品缺陷。

## 旧测试故障的边界

尝试直接运行完整TOOL-02 contract、RT-04 runtime与REL-04。REL-04通过；TOOL-02七项在routeToSelectedWorker处因旧fixture没有capabilityContext而失败，尚未进入受改动的read；RT-04另有两项旧Playbook接口失败（id无效/getPlaybook不存在）。没有削弱这些断言。

将b2cda55原始测试复制到忽略的test-results/d02-baseline，imports指向当前dist中本轮未改动的worker/playbook，重现同七项/两项失败；不是完整旧版本重构建。LLM本轮新增结束状态要求导致的fixture缺字段已补role/finish_reason，限定`RT-04 LLM`三项通过。上述旧fixture迁移分别留D05/D11，不能声称旧全层全绿。

## 结果边界

本地协议工程可继续D03/D04，整票真实参考模型认证仍未完成。include_usage遵循已安装SDK4.104.0；第三方兼容地址需真实认证，不自动改格式或换密钥重试。费用、真实usage与模型版本没有本轮证据。
