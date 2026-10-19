# D13 运行性能与安装探针

2026-10-20，起点3a7e9f2。D05的R2回归在成果生成、重启后预览处失败，日志显示resolve/roots约3.8秒。模型响应正常，原15秒预览上限保持。

## 性能定位

候选原因：网络根等待、解析worker慢、数据库身份代理放大、审计链计算本身。公开openBootstrapDatabase接口实验不使用网络或解析器：200条物化记录的for-of触发808次额外lstat，453.6–535.6ms；每个数组迭代器next都重复查数据库及sidecar。审计记录多次遍历把开销放大到普通文件请求。

修复只让普通数组、行对象、Buffer作为快照返回；数据库、语句、原生迭代器仍受原guard保护。相同实验变为0次额外元数据读取、<0.1ms。原生迭代器与语句关闭失效仍拒绝；现有路径替换/多硬链接/审计篡改/备份恢复等15项通过。R2完整真实Electron的文档生成、重启恢复、预览、另存修改通过，34.100秒；没有延长测试等待。

## 打包问题

1. staging未复制vendor/xlsx-0.20.3.tgz，npm ci ENOENT。增加vendor复制与投影校验，重复后227项生产依赖安装通过（6–8秒）。仅对已知staging目录增加删除重试，保留所有依赖锁/编译检查。
2. 原SEC-02 gate报UNBOUND_SINK electron/main.cjs:8的node:url导入。只读比较当前199处、旧158处；43个新ID、2个过期ID，涉及Browser、Media、Playbook、Worker等，未批量标已审查。
3. 曾尝试将旧审计移出构建前置；协调线程转来自动审批拒绝，理由是已有开发授权未明确涵盖该门槛变更。已精确撤回schema变更、ASAR/stage审计解耦、test:packaged入口变更，原门槛和语义保持。重新运行stage:electron仍因原UNBOUND_SINK拒绝，记录在test-results/d13-preserved-gate.log。

## 被隔离的产物

被拒绝方案的build为9c4ee25f908c；NSIS文件已生成后构建进程被停止。未执行安装器或应用、未运行packaged测试；原生身份的构建日志不算安装证据。该安装器、blockmap和unpacked/RainyDays.exe已加.blocked-d13后缀，release/D13-NOT-A-DELIVERY-CANDIDATE.txt明确禁用，不能分发。安装器实际Authenticode为NotSigned；构建日志中的signing字样不能当已签名。HKCU该安装GUID未注册。当前恢复后的源码构建3bb5589f43aa，没有有效新安装候选。

## 继续条件

保持既有gate，按实际实现与必要行为测试逐项维护绑定；不能靠重写摘要或自动全部reviewed通过。包内本地文档、去开发PATH、worker与重启验证用例已准备但未执行；SEC-05旧fixture的settings:{}对齐当前合法四路径格式，保护断言保持，仍未获得当前包证据。两套无开发工具Windows 11标准用户环境、SmartScreen实际提示、安装/卸载/重装均未验收。本机是有开发工具的Windows 11家庭中文版26200标准用户。
