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
