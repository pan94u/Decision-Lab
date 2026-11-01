# Decision Lab 交付 Logbook

逐 session 追加交付事实。架构与计划分别维护在 [architecture.md](architecture.md) 和 [implementation-plan.md](implementation-plan.md)，交付流程见 [AGENTS.md](../AGENTS.md)。

## S001 · 2026-11-01 · P1.1 机器契约与最小 CLI

- **目标：** 为智能体及后续平台界面建立共用应用入口，完成能力发现、离线预检、幂等创建与跨进程查询。
- **基线：** `378f734`；本条随提交 `feat: deliver session S001 machine evaluation entry points` 一起交付，具体提交号可从本文件 Git 历史定位。
- **交付：**
  - `contracts/` 固化 plan/result v1 JSON Schema；引入 Ajv 与锁文件校验输入及测试输出，业务约束继续由领域/应用服务执行。
  - `src/application/` 提供共用能力发现、预检及实验创建/读取；CLI 不拥有评分或队列。计划固定任务、方案、协议、评价、预算与来源。
  - `bin/decision-lab.mjs` 提供 capabilities、plan validate、experiment create/get；单 JSON stdout、稳定错误/退出码、显式项目上下文。
  - 查询使用只读 SQLite；无效计划在打开数据库前拒绝；提供自建合法样例和 CLEF 生成任务冲突样例。
  - 补充仓库 session 交付约定；基础平台界面加入 Phase 1 的 P1.5，明确复用应用服务及 CLI/Web 实验互通验收。
- **验证证据：** Node 24.14.1；`npm test` 27/27 通过（新增 7 项），`npm run build`、`npm run validate` 通过。`tests/cli.test.mjs` 实际启动独立进程验证 schema、无副作用预检、重复提交/冲突、冻结指纹、项目范围、只读查询及凭据保护；应用用例检查预检不打开仓库或调用网络。文档相对链接和 `git diff --check` 通过。未调用付费模型。
- **边界与遗留：** 创建后仅为 queued；预算目前只有预检，没有运行时执行控制；尚无独立 Worker、wait/report/rescore/cancel、操作 Skill 或新平台界面。现有页面仍走旧链路。CLI 只显式读取进程环境，不自动读取 `.env`；当前只允许 custom/derived 协议。项目标识不是认证；SQLite 实验性警告仍存在于 stderr。
- **下一 session：** P1.2，单 Worker 的持久领取、预算预留、取消与重启恢复；已落盘响应只补评分，无响应的在途中断显式记录结果未知。继续使用临时库与可控适配器验证，记录证据后提交推送。

## S002 · 2026-11-01 · P1.2 独立执行与故障恢复

- **目标：** 让已入队机器计划由独立 Worker 执行，持久控制调用额度、运行时限、取消与恢复，拒绝不安全的自动重发。
- **基线：** `097a157`；本条随提交 `feat: deliver session S002 durable worker and execution controls` 一起交付，具体提交号可从本文件 Git 历史定位。
- **交付：**
  - 增量 schema v2 增加实验控制、项目 Worker 租约与执行租约；S001 机器计划自动补控制记录，旧 benchmark 实验不自动领取。快照与原始证据继续保留。
  - `worker run --project ... [--once]` 独立运行，项目独占、心跳续约与 generation 检查；`experiment cancel --actor ...` 复用应用服务，幂等记录操作者并阻止晚到完成。
  - 调用前原子登记授权及额度，运行时限从首次授权起累计且重启不重置。领取后未登记调用可安全重新排队；已保存响应恢复评分；无响应的登记调用转 outcome_unknown，不释放额度或自动重发。
  - 测试适配器只读输入并固定给出测试响应，不读参考答案；Worker 默认仅运行该适配器。真实 CLEF 需显式 `--allow-live`，配置阻塞不占调用额度。CLEF 传递取消信号、稳定处理正文读取中断，并保留无概率的合法选择响应。
  - 状态入口增加控制/尝试摘要；区分有效答错、无效响应、已知故障与结果未知；取消后的晚到原文仅附存。生成产物的 ignore 规则限定根目录，确保服务端 Worker 源码纳入 Git。
- **验证证据：** Node 24.14.1；`npm test` 46/46 通过（新增 17 项执行器检查、2 项适配器检查），`npm run build` 与 `npm run validate` 通过。`tests/worker.test.mjs` 真实 CLI 跨进程执行、三个持久检查点的 SIGKILL/重启、第二执行者拒绝与 SIGTERM 释放、跨连接取消、额度与期限、过时代次拒写、原文恢复只评分、评分失败保留证据均通过；机器状态结果继续通过 JSON Schema 校验。文档链接、五章结构与 `git diff --check` 通过。未调用付费模型，未改动用户真实数据库。
- **迁移与回退：** v2 为增量表/索引，控制记录与实验在事务中创建；读取保持只读，旧实验继续可查。升级前停写并做一致性备份；回退时停止 Worker，保留当前库及证据，再整体恢复备份，避免直接删除运行中控制数据。
- **边界与遗留：** 受信任单机、每项目一个 Worker、每次尝试一个调用；进程需由操作者或进程管理器保持运行。未知结果、配置阻塞和终止项目前没有重开/重试命令；晚到证据不会自动重开状态。调用额度为保守授权计数，不等于提供商费用；取消不保证远端撤销。尚未实现 wait/report/rescore CLI、操作 Skill、基础平台界面及共享身份认证。SQLite 实验性警告仍保留在 stderr。
- **下一 session：** P1.3，有界等待、含完整分母的报告/逐例证据读取及幂等版本化重评分；验证等待超时不取消实验、重评分不调用模型、不覆盖旧评分。P1.5 平台界面交付范围保持不变。
