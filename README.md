# Decision Lab · CLEF / Jev 决策评测

用于 **System One 类型决策模型**的私有评测工作台：任务导入、批量运行、结果对照、原生概率可视化和转人工阈值分析。

## 设计与实施

目标架构及领域约定见 [架构](docs/architecture.md)，当前阶段的工作切口与完成条件见 [实施计划](docs/implementation-plan.md)。这两份文档描述演进目标；session 交付记录见 [logbook](docs/logbook.md)，执行约定见 [AGENTS.md](AGENTS.md)。下文仅描述当前已实现的功能。

## 启动

```sh
cd /Users/pan9/code/DM-eval/decision-lab
npm ci
npm run setup  # 一次性配置 Account ID / Token；输入 Token 不回显
npm run dev
```

需要 Node.js 24.14.1 或更新版本（本轮验证环境为 24.14.1），通过 `npm ci` 安装锁定依赖；CLI 使用 Ajv 校验 JSON Schema。新增持久化切口使用内置 node:sqlite；该环境中此模块仍有 ExperimentalWarning，当前仅声明所测单机范围。

打开 http://localhost:4173 。启动时自动读取项目根目录 `.env`，终端只显示是否配置成功，不输出密钥。`.env` 已加入 Git 忽略规则，setup 设置文件权限为 0600。也支持服务端环境变量 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，或在页面配置临时 Token。线上密钥保存在 Sites secrets 中，不在源码、任务记录和 localStorage 内。切换其他服务商不会复用 Cloudflare 凭据。

```sh
npm run build
npm test
npm run validate
```

## 机器入口 CLI（S001–S002）

已实现能力发现、离线预检、幂等创建、独立 Worker、取消及按项目查询。报告/重评分 CLI、操作 Skill 与基础平台界面按实施计划继续交付；现有页面暂未接入这条持久化链路。

```sh
node bin/decision-lab.mjs capabilities --json
node bin/decision-lab.mjs plan validate --file examples/plans/local-fixture.json --json
node bin/decision-lab.mjs experiment create --file examples/plans/local-fixture.json --project local-demo --idempotency-key demo-001 --json
node bin/decision-lab.mjs worker run --project local-demo --once
node bin/decision-lab.mjs experiment get --id <上一步的experimentId> --project local-demo --json
```

默认数据库为当前目录的 `.local/decision-lab.sqlite`；创建和查询可用 `--db PATH` 显式指定。同一项目同一幂等键与相同计划返回同一 ID，不同计划返回冲突；项目必须与计划一致。样例为自建测试任务，不能作为真实模型成绩。

机器调用直接运行上述 Node 入口，stdout 为一个 JSON 结果，运行时诊断进入 stderr；`npm run cli -- ...` 可用于人工操作，npm 自身日志不属于机器契约。退出码 0 表示命令成功、2 表示输入/预检问题、1 表示运行错误；它们不代表模型成绩。输入和输出契约分别见 [plan schema](contracts/plan.v1.schema.json) 与 [result schema](contracts/result.v1.schema.json)。

预检不访问模型或创建数据库。`examples/plans/unsupported-clef-generation.json` 用于验证能力冲突；当前机器入口只接受 `custom` / `derived` 协议，尚未注册验证的官方协议不会被标为官方兼容。计划明确固定版本、调用预算和运行时限，Worker 在发请求前持久预留调用额度；额度不是实际计费估算，结果未知和已失败调用不会自动退回。运行时限从首次授权起累计，重启不重置；达到时限停止待执行项并尽力中止在途请求。

Cloudflare 方案使用 `adapter: cloudflare-native`、`model: clef` 或 `clef-flash`，凭据用 `credentialRef: env:CLOUDFLARE_API_TOKEN` 引用，并需要执行环境中的 `CLOUDFLARE_ACCOUNT_ID`。CLI 不自动加载 `.env`；本机可通过 `node --env-file=.env bin/decision-lab.mjs ...` 显式加载。Key 不放入计划或命令参数。当前项目/操作者标识仅用于本机范围与来源记录，未实现共享服务认证。

Worker 默认持续轮询；上面的 `--once` 处理当前可领取任务后退出，不等待未过期的旧租约。Worker stdout 为空，运行诊断写入 stderr；进程正常退出不代表每个任务成功，使用 `experiment get` 查看执行计数、尝试错误、`attentionRequired` 及 `control`。测试适配器固定选首个标签或输出测试 JSON，成绩没有模型能力含义。

取消未完成实验：

```sh
node bin/decision-lab.mjs experiment cancel --id <experimentId> --project local-demo --actor local-operator --json
```

同一数据库、同一项目只允许一个有效 Worker，默认租约 30 秒；可用 `--lease-ms 1000..300000` 和 `--poll-ms 10..10000` 调整。Ctrl+C / SIGTERM 尽力中止当前调用并退出；SIGKILL 或机器故障后，在租约过期后重启 Worker 恢复：未登记调用的任务可重新排队，已保存响应只补评分，其余登记调用标为 `outcome_unknown`，不自动重发。取消后的晚到响应仅追加证据，不能覆盖取消终态；中止不撤销提供商已执行的请求或费用。当前没有重新开启终止项或重试未知调用的命令。

默认 Worker 仅领取 `controlled-fixture`，真实模型计划会留在队列。要执行真实模型，需显式加载执行环境并开启 `--allow-live`；该选项允许消费本项目中符合条件的真实模型计划及其冻结预算，运行前应检查队列。凭据缺失会在发请求前阻塞该执行，不占调用额度。此版本的执行与取消仅针对新机器计划，旧浏览器/benchmark 数据需要后续显式迁移。

运行时存储以增量 schema v2 增加控制、租约和调用额度记录，不改写历史快照。升级前停写并做数据库一致性备份；回退时停止所有 Worker，保留当前库供审计并整体恢复备份，不对运行中的库直接删除控制表。此版本仍限单机受信任操作者环境。

## 公开基准契约验证

服务端持久化链路通过 CLI 驱动；机器计划可由独立 Worker 调度，以下旧 benchmark 驱动仍显式同步执行，不会被 Worker 自动领取。目前尚未接入页面。现有页面仍使用后文描述的浏览器数据模式。

```sh
npm run benchmark:setup   # 独立 Python 环境；用于运行参考评价器，不是平台运行依赖
npm run benchmark:fetch   # 下载固定 revision 的公开样例/源码并检查 SHA-256
npm run benchmark:verify  # 不需要 Key，不调用任何付费模型
```

Python 依赖在 [benchmarks/requirements.txt](benchmarks/requirements.txt)，源码/数据 revision、来源、许可和文件校验和在 [benchmarks/sources.json](benchmarks/sources.json)。验证使用原始样例与受控响应：MMLU 的原始评分函数通过 AST 提取执行，替换网络传输并对短提示禁用裁剪；CLINC 使用原始标签和 sklearn 独立聚合；IFEval 直接执行固定版本的 strict/loose 原始评价器。

每次运行创建独立 SQLite 文件，完整输入、响应、逐项评价及新进程读取结果保存在 `artifacts/benchmark-verification/`（Git 忽略）。轻量结果摘要见 [benchmarks/verification-summary.json](benchmarks/verification-summary.json)。受控响应刻意包含正确、错误和无效结果，摘要中的分数用于验证评价器一致性，不是模型能力成绩，也不是完整官方 benchmark 复现。

MMLU 仅验证 4 个 abstract_algebra 测试样例及 5 个开发集示例；CLINC 验证 6 个源样例与完整 151 标签空间；IFEval 验证四类判据能覆盖的源样例及响应变体，其他判据、Unicode/JSON 边界和语义回答质量尚未认证。BFCL、BEIR 和 τ-bench 尚未接入验证。

支持从服务端保存的响应重新评价，保留旧评价；版本指纹、事务、幂等、项目范围检查和证据一致性均有自动测试。当前不包含完整权限系统、自动恢复队列或生产门禁，不能据此宣称平台已达到生产标准。

### CLEF 真实调用

配置好本机 `.env` 后运行 `npm run benchmark:clef`，使用上述固定样例分别评测 MMLU 与 CLINC，共最多 10 个真实请求，产生提供商 API 用量，无自动重试。该命令需要先运行过 `benchmark:verify` 生成固定输入；它不读取受控答案来生成模型输出。

报告位于 `artifacts/clef-benchmark/report.md`，原始请求/响应与 SQLite 同目录保存；脱敏摘要见 [benchmarks/clef-live-summary.json](benchmarks/clef-live-summary.json)。MMLU 使用派生原生 choice 协议，CLINC 保留完整 151 标签空间，IFEval 不运行。当前耗时口径为请求开始至响应头到达，不含正文读取。小样本不能外推完整 benchmark 表现。

## 模型协议

- Cloudflare：`@cf/cloudflare/clef` / `@cf/cloudflare/clef-flash`。
- 请求为 `{model, state, questions}`，**不发送 messages、temperature、max_tokens**。
- 支持 `choice`、`noul`、`score` 原生答案与概率。无自由文本推理字段。
- 接口保留完整 `answers`、`confidence`、`probabilities`、模型名、usage 与调用耗时。
- Jev 兼容模式支持 HTTPS System One endpoint 和独立 Token；尚未使用 Jev 真实凭据验证，不宣称已完成 Jev 实测。
- 参考标签 `expected`、人工依据 `rationale` 和工作流配置不会进入发给模型的请求，服务端使用严格字段白名单。

## 导入格式

支持单个任务、任务数组、`{"tasks": [...]}`；每批最多 50 项，每项 1–64 个问题。当前输入为文本或 JSON state，未提供图像上传功能。

```json
{
  "title": "支付故障分流",
  "description": "区分故障处理与发票问题",
  "category": "工单路由",
  "state": {"current": "所有客户付款接口返回 500，没有替代付款入口。"},
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "哪个团队负责当前问题？",
      "criteria": {"technical": "系统故障与接口错误", "billing": "账单和发票"}
    },
    "escalate": {"type": "noul", "instructions": "核心付款流程是否不可用且无替代方案？"}
  },
  "expected": {"route": "technical", "escalate": true},
  "rationale": "接口故障且核心流程不可用。",
  "workflow": {"routeQuestion": "route", "escalateQuestion": "escalate"}
}
```

Choice 参考标签为命名选项，Noul 为布尔值，Score 为从 0 开始的等级整数。Score criteria 是 2–10 个自足的有序描述。任务库可下载完整模板。

## 评测口径

- Choice 使用接口返回 choice；Noul 以 p ≥ 0.5 判真；Score 使用概率众数衡量等级命中，另报告返回期望评分相对标签的 MAE。
- 准确率对失败/未完成问题计错；场景全对率要求所有原子判断均命中。
- Brier：Noul 为 `(p-y)^2`，多类为 `0.5 * sum((p-y)^2)`，均在 0–1 之间，越低越好。
- NLL 使用参考标签的概率，截断到最小 1e-15；ECE 为选中类别概率的 10 桶加权校准误差，**不使用 API confidence 计算校准**。
- 概率指标仅统计有效输出并显示有效/总判断数；概率和允许 0.002 的舍入误差后归一化。
- Confidence 原样保留，Noul 单独显示派生值 `abs(2p-1)`，不冒充接口字段。
- 可调 p(top) 阈值计算原子判断自动处理覆盖率和接受集错误率；无接受项时错误率为 null。任一原子判断低于阈值时场景模拟转人工。
- 组合路由和升级均为只读模拟，不执行业务操作。

## 初始任务与真实结果

12 项合成场景、36 个原子判断，覆盖工单、工具权限、安全证据、政策边界、发布门禁和证据完整性。参考标签按场景中的明确规则人工编写，不是独立公开 benchmark。

`src/initial-runs.json` 包含 2026-10-24 真实调用 CLEF 和 CLEF Flash 的完整结果，每个模型 12 次调用。初次进入自动显示，可查原始答案；这只是小样本验收，不能外推总体能力排名。

均匀概率演示不读标签；参考上界直接读答案，仅验证评分器。两者不进入真实模型汇总。

## 旧版页面的实现与限制

- `src/page.html`：样式；`src/app.js`：交互；`src/engine.js`：校验、协议投影、归一化和指标；`src/seeds.js`：任务；`src/server.js`：模型代理。
- `scripts/assemble.mjs` 组合为自包含 `worker/index.js`，产物为 `dist/`。
- 旧版页面的任务与结果存当前浏览器，不跨设备同步。支持 JSON 导出，尚无结果备份导入。
- 旧版页面的顺序任务依赖页面保持打开；其数据尚未接入上述 CLI 持久队列。
- 当前是独立判断与单步复合流程，尚未实现多轮环境仿真、视觉任务或大量样本校准。
- 线上依赖 Sites owner-private 访问控制；公开前需增加用户隔离与配额。
- 旧版组合优化代码在父目录 `decision-lab-legacy-v1` 留档，不参与当前构建。

协议参考：[CLEF 官方文档](https://developers.cloudflare.com/workers-ai/models/clef/)、[TypeSafe 问题类型](https://docs.typesafe.ai/introduction)、[Confidence 定义](https://docs.typesafe.ai/confidence)。
