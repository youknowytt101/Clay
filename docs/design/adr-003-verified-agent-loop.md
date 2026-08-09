# ADR-003 · 验证驱动的 AI 控制循环

| | |
|---|---|
| **状态** | **倾向已定** —— 见 [ADR 状态机](goals.md#07-adr-状态机v19)。转「已验证」的条件：[§10](#10-三个手工样例与冻结条件) 三个手工样例逐条走通；再由最小纵切实现验证事务与错误通过率后转「已冻结」 |
| **修订** | **r2**（2026-08-09）——[第一轮推演](adr-003-walkthrough.md)暴露 8 处缺口，本版补齐：<br>§3.1 `baseRevision` 职责分离 + `primitivesUsed` / `capabilityGap` · §3.2 `inputTrace` 分层 + `covers` · §4 计划校验含 Action 存在性 · §5 冲突的定义 · §6 约束分级 · §7 修复白名单与回归范围 |

> **r2 补的八处，全部是「两节各自读都成立、合起来推不出唯一结果」的接缝。**
> 其中 **C**（`baseRevision`）按原文字面实现会让**任何多步计划的第二步永远冲突**；
> **E / F** 两处是「验证看起来通过了、但该验的路径没被验」——
> 它们是 §9「错误通过率必须为 0」现在最可能被击穿的地方。
| **日期** | 2026-08-08 |
| **决策者** | 项目所有者 |
| **上游** | [goals.md](goals.md) 决策 40 及 v20 修订、不变量 I1 / I2 / I3 / I7 / I10、§4.2、§5.4 |

---

## 1. 背景

Roblox Planning Mode 已把**计划 → 执行 → 试玩 → 修复**做成编辑器内的产品闭环：计划可编辑、执行前需批准、
会话有 checkpoint，试玩代理能读日志、截图并模拟输入，再把结果交还 Assistant 修复。
这证明「先计划、再构建、再验证」已经是专业引擎内 AI 的竞争基线。

但 Roblox 官方同时明确列出错误通过、可观测性有限、没有实时反射、50 回合上限等限制。
所以 Clay 不把「模型说测试通过」当成验收，而把自主循环建立在已有的 Action、约束层、headless 与确定性之上。

**本 ADR 决定控制协议，不决定使用哪个模型，也不引入通用 agent 框架。**

| 官方依据 | 核对日期 | 失效复查 |
|---|---|---|
| [Roblox Planning Mode](https://devforum.roblox.com/t/announcing-planning-mode-for-roblox-assistant/4580715) | 2026-08-08 | 2026-11-08 |
| [Roblox Playtest Agent](https://devforum.roblox.com/t/studio-beta-studio-assistant-mcp-playtest-agent/4566767/1) | 2026-08-08 | 2026-11-08 |
| [Roblox 虚拟输入与自动试玩](https://devforum.roblox.com/t/assistant-updates-studio-built-in-mcp-server-and-playtest-automation/4474643) | 2026-08-08 | 2026-11-08 |
| [Roblox Assistant 文档](https://create.roblox.com/docs/assistant/guide) | 2026-08-08 | 2026-11-08 |

---

## 2. 决策摘要

> **Clay 的自主循环是「计划契约 → Action 事务 → 分层验证 → 证据提交 → 有界修复」。**
> 模型可以提出下一步，但不能决定事务是否提交、测试是否算通过、预算是否继续，也不能修改验收标准来让自己通过。

六条硬规则：

1. **计划是结构化 `PlanContract`，Markdown 只是同一份数据的人类视图。**
2. **执行以步骤为事务边界。** 每步在候选分支运行，通过后才形成 checkpoint。
3. **硬通过只来自可执行 oracle。** 模型自评、截图描述与自然语言报告只能作为证据，不能单独判定成功。
4. **提出修改与验证修改的上下文隔离。** 可以使用同一模型，但不能沿用执行代理的自我判断。
5. **修复有预算、有停止条件、不得削弱测试。**
6. **全过程形成 `EvidenceLedger`，可重放、可审计、可部分接受。**

---

## 3. 数据契约

### 3.1 `PlanContract`

```ts
type PlanContract = {
  id: string;
  version: number;
  baseRevision: string;
  goal: string;
  assumptions: string[];
  scope: {
    entities?: string[];
    systems?: string[];
    allowedActionTags: string[];
  };
  steps: PlanStep[];
  globalAcceptance: TestSpec[];
  budget: RunBudget;
};

type PlanStep = {
  id: string;
  dependsOn: string[];
  intent: string;
  allowedActions: string[];
  primitivesUsed: string[];        // r2：打算用哪些条件/动作达成 intent
  capabilityGap?: CapabilityGap;   // r2：用现有原语表达不出来时必填
  expectedEffects: string[];
  acceptance: TestSpec[];
  risk: 'low' | 'medium' | 'high';
};
```

首版用**有依赖边的有序列表**，不做通用节点图。`dependsOn` 只负责依赖与跳过传播；
界面仍是可编辑列表。日后需要并行调度时，同一数据可投影成 DAG，不改计划格式。

计划的每次人工或 AI 修改都增加 `version`。批准绑定具体版本；计划一旦变化，未执行步骤回到待批准状态。

**计划里不出现「验证」步骤**（r2 · 缺口 A）。验证是每个步骤的 `acceptance` 与计划的
`globalAcceptance`，不是一个可执行步骤——否则立刻产生递归：那个验证步骤自己的 `acceptance` 是什么？

### 3.1.1 `baseRevision` 的职责划分（r2 · 缺口 C）

**原文只说「校验 `baseRevision`，不一致则停止」，按字面实现会让任何多步计划的第二步永远冲突**：
s1 提交后工程 revision 就已经不等于计划创建时的值了。

| 字段 | 语义 | 何时校验 |
|---|---|---|
| `PlanContract.baseRevision` | 计划**创建 / 批准时**的工程 revision | **仅在第一个步骤执行前**校验。用于检测「批准之后、执行之前，工程被改过」 |
| `StepReceipt.beforeRevision` | 本步骤执行前的 revision（上一步的 `candidateRevision`，首步则为 `baseRevision`） | **每步校验** |

> **「冲突」的定义（r2 收窄）**：revision 的变化**不是由本 run 已提交的步骤造成的**。
> **本 run 自己推进 revision 不算冲突。**

### 3.1.2 `capabilityGap`（r2 · 缺口 H）

```ts
type CapabilityGap = {
  missing: string[];        // 缺哪些条件 / 动作（用自然语言描述能力，不是编造 id）
  attemptedApproach: string;
  whyInsufficient: string;
};
```

`primitivesUsed` 是**计划期必填**。planner 若无法用现有原语表达 `intent`，
**必须产出 `capabilityGap` 而不是留空或硬凑**；`capabilityGap` 非空的计划
**直接停在 `NeedsReview`，不进入执行**。

这把「承认做不到」从**模型的自觉**变成**计划结构的必填项**——
模型仍可能填错，但**填不出来这件事本身会暴露**。
没有这一条时，模型硬凑近似实现的兜底路径是「同一失败签名两次 → 停止」，
用户拿到的报告是「重复失败」，而不是 [§10 S3](#s3--请求一个-registry-不具备的新玩法原语) 要求的「缺少哪个原语」。

### 3.2 `TestSpec`

```ts
type TestSpec = {
  id: string;
  kind: 'schema' | 'constraint' | 'state' | 'interaction' | 'visual';
  oracle: object;
  seed?: number;
  inputTrace?: InputTrace;         // r2：分层，见 3.2.1
  covers: string[];                // r2：断言了哪些实体 / 系统 / 规则组
  timeoutTicks?: number;
  severity: 'hard' | 'soft';
};
```

- `schema / constraint / state / interaction` 可以是 `hard`。
- `visual` 默认只能是 `soft`。只有人明确给出可判定 oracle 时，才允许成为 `hard`。
- 运行中的 AI **无权新增、删除或降级已批准的 hard TestSpec**；需要改验收标准时必须回到计划审批。

### 3.2.1 `inputTrace` 分两层（r2 · 缺口 E）

```ts
type InputTrace =
  | { layer: 'intent'; intents: InputIntent[] }    // 驱动玩法逻辑
  | { layer: 'device'; events: DeviceEvent[] };    // 驱动输入映射与 UI 命中测试
```

**原文只有意图层，而 [I12](goals.md#02-十二条不变量) 的意图（`跳跃 / 确认 / 移动`）不含坐标**，
只能驱动焦点模型。于是**鼠标命中测试那条路径：V2 到不了，V3 判不了硬**——
按钮的鼠标绑定断掉时 V2 仍然全绿，而这正是 [§10 S2](#s2--修复按钮能看到但点了没反应) 要防的错误通过。

> **根因是把「设备无关」用错了地方。**
> I12 约束的是**被测对象**（事件表不得引用设备），
> **测试轨迹不是事件表**——它完全可以在设备层驱动，只要被测逻辑本身只认意图。

**`kind: 'interaction'` 的 device 层测试可以是 `hard`**（r2 明确放开）。
理由：它的判据是**可判定的**（按钮是否被激活、菜单是否关闭），不是视觉判断。
「`visual` 默认 soft」那条规则针对的是「截图好不好看」，**不该殃及命中测试**。

### 3.2.2 `covers` 与回归范围（r2 · 缺口 F）

**回归测试的范围由引擎决定，不由 AI 决定。**

```
需重跑的回归集 = { t ∈ TestSpec | t.covers ∩ 本步骤实际 affects ≠ ∅ }
```

**AI 只能建议扩大这个集合，不能缩小。**

没有这一条时，存在一条**绕过全部现有停止条件的错误通过路径**：
AI 既不删除 hard TestSpec、也不放宽它，**只是不把它列进"必须重跑的回归测试"**。
§7 的停止条件里"试图删除、放宽或跳过 hard TestSpec"抓不到"没跑"这种形态。

### 3.3 `StepReceipt` 与 `EvidenceLedger`

```ts
type StepReceipt = {
  runId: string;
  stepId: string;
  beforeRevision: string;
  candidateRevision: string;
  actions: ActionReceipt[];
  actualEffects: string[];
  validation: TestResult[];
  budgetUsed: RunBudget;
  status: 'passed' | 'failed' | 'needs-review' | 'cancelled';
};
```

`EvidenceLedger` 按顺序保存：计划版本、provider / model、提示摘要、Action 参数、真实 diff、约束反馈、
输入轨迹、种子、状态断言、日志、截图引用、修复假设、预算消耗和最终判定。
它是审计记录，不是新的世界状态真源；工程状态仍以 Action 层为权威。

---

## 4. 引擎拥有的状态机

```text
Draft → AwaitingApproval → Executing → Verifying → Passed
                         ↘             ↘
                          Cancelled     Repairing → Executing
                                         ↓
                              NeedsReview / Failed
```

| 状态 | 谁能推进 | 条件 |
|---|---|---|
| `Draft` | 人 / planner | 计划结构合法：schema 通过、`dependsOn` 无环、**`allowedActions` 与 `primitivesUsed` 的 id 都在 registry 中存在**、`capabilityGap` 为空（r2 · 缺口 G / H）。**尽早失败**——引用了不存在 Action 的计划不该走到人工审批 |
| `AwaitingApproval` | 仅人 | 批准绑定 `PlanContract.version` 与 `baseRevision` |
| `Executing` | orchestrator | 只允许本步骤声明的 Action 与影响域 |
| `Verifying` | verifier | 执行批准时已有的 TestSpec，不得改测试 |
| `Repairing` | orchestrator | 失败证据、原因假设与最小修复集齐全 |
| `Passed` | 引擎 | 所有 hard oracle 通过，事务才可提交 |
| `NeedsReview / Failed / Cancelled` | 人 | 超范围、冲突、超预算、重复失败或人工中断 |

状态、预算和中断信号都在引擎侧。模型输出只能提出状态转换请求，不能直接改状态。

---

## 5. Action 事务语义

每个 `PlanStep` 对应一个事务：

1. 校验 revision（按 [§3.1.1](#311-baserevision-的职责划分r2--缺口-c) 的分工：计划级只在首步查，步级每步查）。
   **冲突 = revision 变化不是本 run 已提交步骤造成的**；冲突则停止并报告，不自动覆盖。
2. `preview` 在候选分支执行 Action，主工程不变。
3. 每条 Action 校验 schema、前置条件、权限和 `affects`；步骤内默认**全有或全无**。
4. 生成 `StepReceipt`，进入验证。
5. hard oracle 全部通过才 `commit`，形成命名 checkpoint。
6. 失败或取消丢弃候选分支；允许接受的最小粒度是**已通过的步骤**，不是失败步骤中的半批 Action。

协议必须支持：

- `baseRevision`：乐观并发控制。
- `idempotencyKey`：重复请求不得执行两次。
- `preview / commit / abort`：预览与提交分离。
- `affects`：实际影响超出计划作用域时立即停止。
- 外部副作用：本轮 Action 不得发送消息、发布、购买或修改远端状态；以后若开放，必须单独权限与补偿协议。

---

## 6. 三层验证

| 层 | 依据 | 作用 |
|---|---|---|
| **V1 结构** | JSON Schema、Action 前置条件、引用完整性、约束四元组 | 快速阻止无效工程状态。**约束分两级**，见下 |
| **V2 行为** | 确定性 headless、固定 seed、输入意图轨迹、状态断言、回归套件 | 决定玩法是否硬通过 |
| **V3 体验** | 真实虚拟输入、日志、截图、视觉判断 | 发现 UI、构图、可达性与体验问题 |

V3 不能替代 V2。`character_navigation` 一类直接移动角色的测试只能证明目标状态可达，
不能证明真实输入、相机、寻路或角色控制器正确；涉及这些系统时必须使用输入意图轨迹。

### 6.1 约束分两级（r2 · 缺口 B）

| 级别 | 例子 | 对 commit 的影响 |
|---|---|---|
| **阻断性** | schema 违反、引用完整性断裂、Action 前置条件不满足 | **阻止 commit**。工程不得进入这种状态 |
| **完成性** | kind 缺皮肤映射、规则行引用了尚未创建的行为单元 | **不阻止 commit**，记入 `StepReceipt` |

**原文没有这个分级，于是「增量构建」与「每个 checkpoint 都合法」直接打架**：
「新增 kind」与「配皮肤」如果必须同时满足全局约束，就只能合成一个原子步骤，计划无法拆细；
而若允许分开，中间 checkpoint 就是一个约束违反的状态。

**因此 r2 规定**：`Passed` 只要求**阻断性**约束与 hard oracle 全通过；
但**「部分接受」时必须显示当前未满足的完成性约束条数与清单**。
用户仍然可以接受一个未完成的中间态，**但必须知道自己接受的是什么**——这是 [I2](goals.md#02-十二条不变量) 的可审计要求。

验证上下文只接收计划、候选 diff、TestSpec 与观测结果，不接收执行代理的「我已经完成」结论。
同一模型可以承担 planner / executor / verifier 三个角色，但上下文与权限必须隔离；
供应商切换不得改变状态机、事务或判定语义。

---

## 7. 有界修复

一次修复必须产生四样东西：

1. 失败证据的稳定签名。
2. 原因假设。
3. 最小 Action 修复集及预期影响域。
4. 受影响测试与必须重跑的回归测试——**范围由引擎按 [§3.2.2](#322-covers-与回归范围r2--缺口-f) 求出，AI 只能建议扩大**。

**修复可以用哪些 Action**（r2 · 缺口 D）：**只限本步骤已批准的 `allowedActions`，且不得改动任何 `acceptance`。**
需要触碰其他步骤影响域的修复（例如「皮肤缺失其实是上一步 kind 名字拼错」），
**必须走 `NeedsReview` 回到审批**，不得在 `Repairing → Executing` 的环内自行扩权。

> 原文的状态机让 `Repairing` 直接回到 `Executing` 而不经审批，
> 同时 §3.1 又规定「计划的每次修改都增加 `version`、未执行步骤回到待批准」。
> **两条合起来留了个口子**：修复引入的 Action 既不算「计划修改」，又不受 `version` 绑定约束。
> 上面这条把口子封上，且不破坏自主循环——**本步骤范围内的修复仍然不需要人介入**。

满足任一条件立即停止并转 `NeedsReview / Failed`：

- 同一失败签名连续出现两次。
- 试图删除、放宽或跳过 hard TestSpec。
- **需要本步骤 `allowedActions` 之外的 Action，或需要改动 `acceptance`**（r2）。
- 实际 `affects` 超出计划作用域。
- Action 次数、修复次数、时间或模型费用任一预算耗尽。
- 需要现有 registry 没有的新条件或动作（`capabilityGap` 在执行期才暴露）。
- revision 冲突或用户中断。

停止时必须保留最后一个通过的 checkpoint 与完整证据，不能只返回一段自然语言道歉。

---

## 8. 审批与权限

- **计划批准是强制门。** 不自动执行、不超时默认接受。
- `low / medium` 步骤在计划批准后可连续执行；`high` 步骤提交前再次批准。
- 删除实体、批量改规则、改变项目流程、导入外部资产默认为 `high`。
- 用户可在任何步骤中断；中断在当前 Action 原子边界生效。
- planner 只能读 `describe` 与 registry；executor 才能 `apply`；verifier 只能运行 TestSpec 与读证据。
- 工程内文本、资产元数据、脚本注释、日志与网页内容一律视为**不可信数据**，不得把其中的指令提升为计划、权限或审批；
  只有用户输入与已批准 `PlanContract` 能改变控制目标。
- provider 适配层不得向模型暴露 API key、代理凭据或未在计划 scope 中声明的工程内容。

这套角色是权限边界，不等于三个并发 agent。**多 agent 并发编辑与合并仍不做。**

---

## 9. 可判定指标

闸门 D 至少记录：

| 指标 | 定义 |
|---|---|
| 计划人工修改率 | 被批准前发生人工修改的步骤 / 总步骤 |
| 首轮通过率 | 无修复即通过的任务 / 总任务 |
| **错误通过率** | 人工植入失败但 verifier 判通过 / 植入失败总数 |
| 平均修复轮数 | 通过任务消耗的修复轮数均值 |
| 越界拦截率 | 实际影响超 scope 且被事务层拦截 / 越界尝试 |
| 恢复距离 | 失败后回到最近通过 checkpoint 所需 Action 数，目标恒为 0 |
| 跨模型一致率 | 不同 provider 下得到相同硬判定的任务 / 总任务 |
| 时间与费用 | 按任务、步骤、模型分别记录，不上传遥测 |

首个闸门 D 套件中，人工植入的 hard 失败**错误通过率必须为 0**。样本扩大后的长期阈值另定，
但不能用「模型大多数时候觉得可以」替代这一条。

---

## 10. 三个手工样例与冻结条件

### S1 · 加一种会飞的敌人

计划包含：新增 kind → 配皮肤 → 增加移动行为 → 生成规则行 → 加入关卡 → 验证。
人工制造一次皮肤缺失约束，要求修复只补映射，不重写玩法。检查逐步 checkpoint、部分接受与证据完整性。

### S2 · 修复「按钮能看到但点了没反应」

V2 用输入意图驱动菜单，V3 用真实鼠标点击。直接调用按钮回调或传送到结果状态不得算通过。
人工植入断开的事件绑定，verifier 必须判失败；修复后必须重跑原测试与菜单回归测试。

### S3 · 请求一个 registry 不具备的新玩法原语

planner 可以识别能力缺口，但 executor 不得生成并自动注册 JS。运行必须停止在 `NeedsReview`，
指出缺少的条件 / 动作、已完成步骤、未执行步骤和最后 checkpoint。

### 转状态条件

- 三个样例纸面推演无歧义 → `已验证` 的纸面条件之一。
- 最小纵切中，事务回滚、计划版本失效、重复请求幂等、错误通过负例全部通过。
- goals / architecture-outline / roadmap / ai-native-engine 的现行措辞全部同步。
- 达成以上条件后才可转 `已冻结`；冻结的是协议字段与判定边界，不是 UI 布局或模型提示词。

---

## 11. 明确不做

- 通用 agent 框架依赖。
- 多 agent 并发编辑与自动合并。
- 让模型自行修改 hard oracle 后继续执行。
- 只靠截图或模型自评判定玩法通过。
- 失败步骤的半批 Action 提交。
- AI 自动注册新 JS 条件与动作。
