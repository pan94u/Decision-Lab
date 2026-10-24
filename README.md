# Decision Lab 决策模型评测平台

私有评测工作台，包含任务库、JSON 导入、批量评测、重复运行、失败重试、原始输出、约束检查与最优解比较。无运行时第三方 npm 依赖。

## 本地启动

```sh
cd /Users/pan9/code/DM-eval/decision-lab
npm run dev
```

打开 http://localhost:4173 。本地真实调用可通过环境变量 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 配置，也可以在页面填写临时凭据。不要把密钥提交到源码。线上密钥使用 Sites secret 环境变量保存。

```sh
npm run build
npm test
npm run validate
```

`src/page.html` 为界面样式，`src/app.js` 为交互，`src/engine.js` 为评分和精确求解器，`src/seeds.js` 为 12 项合成基准，`src/server.js` 为模型代理。`scripts/assemble.mjs` 将它们组合为自包含的 `worker/index.js`，构建产物在 `dist/`。修改源码后重新启动本地服务。

## 任务格式

支持单个对象、对象数组、`{"tasks": [...]}`。可在任务库下载完整示例。

```json
{
  "title": "资源分配",
  "description": "选择最高收益的可行行动组合。",
  "category": "自定义",
  "budgets": {"预算": 10, "人力": 4},
  "riskWeight": 0.5,
  "minSelect": 1,
  "required": [],
  "options": [
    {"id": "a", "label": "行动 A", "costs": {"预算": 6, "人力": 2}, "value": 12, "downside": 2},
    {"id": "b", "label": "行动 B", "costs": {"预算": 4, "人力": 2}, "value": 7, "downside": 1, "requires": ["a"]}
  ]
}
```

`requires` 指向前置行动，`excludes` 指向互斥行动。导入会验证字段并拒绝不可行任务。每项 2–16 个行动，1–6 个资源维度，每次最多导入 50 项。收益与风险损失均为非负有限数，downside 不大于 value，风险权重为 0–1。

## 评分

目标值 = Σvalue − riskWeight × Σdownside。违反任一预算、依赖、互斥、必选或最少行动数约束，或输出含未知/重复 ID，得 0 分；否则得分为目标值 / 精确枚举最优值 × 100。最优值为 0 时可行解得 100 分。格式或 API 错误按 0 分计入汇总。延迟和 token 用量另行记录，不进入质量得分。

模型返回 `{"selected": ["a"], "reason": "简短决策依据"}`。temperature = 0，max_tokens = 1800，单次接口超时为 60 秒。支持 Cloudflare response 文本、对象及 chat choices 格式；兼容接口要求完整 HTTPS chat/completions URL。

## 数据与边界

- 任务与结果保存在当前浏览器 localStorage，不会跨浏览器同步。可导出 JSON 备份。
- 批量运行由页面顺序驱动，页面关闭会中断；再次打开后可重试未完成项。没有后台任务队列。
- 演示是实时计算的确定性贪心策略；基线是精确求解器，不冒充大模型结果。
- 当前为离散行动组合优化评测；12 项任务是合成基准，不覆盖连续动作、交互式多步环境或真实业务安全性。
- 私有线上站点依赖 Sites owner-only 访问控制。若将来改为公开服务，应先引入用户隔离、调用配额、后台队列和数据库。
- Cloudflare 官方接口说明：https://developers.cloudflare.com/workers-ai/get-started/rest-api/
