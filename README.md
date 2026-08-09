# Clay

> **一个 AI 与人共用同一条编辑通道的通用 3D 网页游戏引擎编辑器：
> 游戏逻辑是数据，AI 和鼠标是同一个命令层的两个前端，产出的是同一种材料。**

**状态：M1 进行中，M1-a / M1-b / M1-c / M1-d / M1-f / M1-h 已落地。**

```bash
npm install && npm test        # headless 断言（56 项）
npm run dev                    # 第一版编辑器：大纲 / 详情 / gizmo / 多选
```

[ADR-002](docs/design/adr-002-eventsheet-eval.md)（事件表求值语义，全项目唯一不可逆项）
已转**已验证**——三个手工样例经[两轮推演](docs/design/adr-002-walkthrough.md)走通，暴露并补上 6 处语义缺口。

> **v17 重定了方向**（当前 **v21**，见 goals.md 开头）：目标用户从「不写代码的普通人」改为**有经验的游戏研发人员**，
> 门槛由**内置 AI + 内置教程**承担而非削能力（决 35）；双模式取消；分发链推后；
> 模板集由**八款目标游戏**（红警 / 星际 / 魔兽 / Dota / 塞尔达 / 艾尔登 / 刺客信条 / 战争机器）
> 倒推为 **RTS·MOBA** 与**第三人称动作**两个。详见 [goals.md](docs/design/goals.md) 开头的 v17 说明。

> **v20 升级了 AI 控制循环**（决策 40）：复杂任务使用可编辑、需批准的 `PlanContract`，
> 每步在 Action 候选事务中执行，经结构 / 确定性行为 / 体验三层验证后才提交 checkpoint；
> 失败进入有预算、不可削弱 hard 测试的修复环，全程留下可重放证据。见
> [ADR-003](docs/design/adr-003-verified-agent-loop.md)。

> **v21 建立了可进化的决策治理**（决策 42）：非平凡任务先扫描十二面 `DecisionCoverage`，
> 未知项进入有风险路由的登记表，必要时发 `DecisionChallenge`；现有方案和治理机制都能被更强证据取代，
> 但 AI 不能静默修改产品意图、hard oracle、权限或历史。见
> [ADR-004](docs/design/adr-004-evidence-governed-evolution.md)。

---

## 从哪读起

| 想干什么 | 读哪里 |
|---|---|
| **只想看图** | [overview.svg](docs/diagrams/overview.svg) —— 六图合一：系统全景 · 数据模型 · 一帧发生什么 · 用户流程 · 编辑器界面 · 能力覆盖面 |
| **一次读完全部** | 打开 [preview.html](preview.html) —— 全部文档 + 总览图合成一页，带目录与过滤 |
| **想知道这编辑器现在有什么能力** | **[architecture-outline.md](docs/design/architecture-outline.md)** —— 决策后的状态快照，只写「是什么」不写「为什么」 |
| **判断能不能做出某类游戏** | architecture-outline.md §二 —— 八款目标游戏的灰盒判定 + 三道闸 + 强/中/弱轴 |
| **接下来做什么、按什么顺序** | **[roadmap.md](docs/design/roadmap.md)** —— 施工版计划：包 · 依赖 · 相对体量 · 验收 · 砍单顺序 · 决策截止点 |
| 快速判断这项目在做什么 | [goals.md](docs/design/goals.md) §0 冷启动：一句话定义 + 12 条不变量 |
| **判断一个提议该不该做** | goals.md §0 → §2 决策表 → §3 范围。这三节就是裁决依据 |
| **让 AI 发现遗漏并改进旧方案** | **[ADR-004](docs/design/adr-004-evidence-governed-evolution.md)** —— 决策覆盖、不确定项、挑战、证据追踪与 champion/challenger |
| 理解产品长什么样 | goals.md §1.3 用户心流 |

---

## 名字的由来

**I3 不变量的原话是「AI 的产出与人手做的是同一种材料」——Clay 就是那个材料。**

- **同一种材料**：AI 生成的规则和你手搭的规则，捏起来手感一样，你随时能接着改
- **随手就能改**：黏土不用先做模具，戳一下就有反馈——「模板优先，空白页有罪」
- **不怕做错**：捏坏了压回去重来——「错误必须便宜」，播放沙箱与全量撤销
- **成品要出窑**：从一团泥到一款完整作品——决策 25 的水位、决策 23 的成品感下限

刻意避开 Unreal / WorldEngine / Foundry 那种「宏大」路线。
定位不是威力，是**同一种材料**——**AI 改的和你改的是同一坨泥**。

> v17 之前这里写的是「可及性」（谁都能上手）。护城河换到 I1 + I3 之后，
> 名字要说的不再是**谁能碰它**，而是**AI 和人碰的是不是同一样东西**。

---

## 目录

```
Clay/
├─ README.md              本文
├─ AGENTS.md              AI 协作规范（单一真源）：接手指引 · 七步迭代流程 · 检查表
├─ CLAUDE.md              指向 AGENTS.md 的 stub
├─ preview.html           全部文档合成的单页预览（生成物，勿手改）
├─ tools/
│  ├─ check-docs.py       文档一致性校验
│  ├─ build-preview.py    重新生成 preview.html
│  └─ preview-template.html
└─ docs/
   ├─ design/             未来方案、取舍、决策记录（会过期）
   │  ├─ goals.md              产品设计大纲 —— 最高裁决依据（决策过程）
   │  ├─ architecture-outline.md  产品架构大纲 —— 决策后的状态（能力清单）
   │  ├─ roadmap.md            开发计划 —— 施工版：包 · 依赖 · 体量 · 决策截止点
   │  ├─ ai-native-engine.md   AI 基础设施规格（下级文档）
   │  ├─ adr-001-ecs.md        ECS 库选型
   │  ├─ adr-002-eventsheet-eval.md  事件表求值语义 —— 唯一不可逆的一项
   │  ├─ adr-003-verified-agent-loop.md  AI 计划 · 事务 · 验证 · 证据 · 有界修复协议
   │  ├─ adr-004-evidence-governed-evolution.md  决策发现 · 挑战 · 证据 · champion/challenger
   │  ├─ adr-002-walkthrough.md          ADR-002 三个样例的推演结果（已采纳）
   │  ├─ adr-003-walkthrough.md          ADR-003 三个样例的推演结果（已采纳）
   │  ├─ spike-001-rapier-determinism.md Rapier 确定性实测（同机通过，跨平台未验）
   │  └─ spike-002-ecs.md               ECS 选型验证（koota 锁定）
   ├─ diagrams/           给人看的入口（内容以 goals.md 为准）
   │  └─ overview.svg          六图合一：系统全景 · 数据模型 ·
   │                          一帧发生什么 · 用户流程 · 编辑器界面 · 能力覆盖面
   ├─ conventions/        写代码时要遵守的规则（很少变）
   │  └─ ui.md                 UI 令牌与图标约定，防风格漂移
   └─ architecture/       已实现模块的架构与理由（跟着代码改）
      └─ roads.md              继承自 GameHub 存量
```

> **goals.md 与 architecture-outline.md 的分工**：前者是**决策过程**（决策表 + 版本沿革、
> 每条为什么这么定、否掉了什么），是裁决依据；后者是**决策后的状态**（现在能做什么、
> 做到哪儿为止、封顶在哪），是能力清单。**冲突时以 goals.md 为准。**

**文档按生命周期分三类**，不按主题——三类过期的方式完全不同，混在一起会分不清哪份还算数：
`design/` 会过期，实施后要么归档、要么把落地部分挪进 `architecture/`；
`conventions/` 很少变，变了要在决策表或 ADR 里留痕；
`architecture/` 跟着代码改，代码变了文档没变就是 bug。

**当前绝大部分内容仍在 `design/`**，代码只有 M0-b 的工程地基（`src/` + `tests/`）。
`architecture/` 与 `conventions/` 里现有的两份是从 GameHub 继承的存量参考。
**M1 落地后，实现过的部分要从 `design/` 挪进 `architecture/`**——这是三类文档分工的执行点。

---

## 怎么改这些文档

**五条编辑规则的出处是 [goals.md §0.5](docs/design/goals.md)。**
**这里不复述**——规则写到第二个地方，两处就会各自漂移。

**完整的迭代流程在 [AGENTS.md](AGENTS.md)**：三分钟接手指引、权威顺序、七步流程、
三条最容易犯的错、交接检查表。**任何 AI 助手接手前先读那一份**（`CLAUDE.md` 是指向它的 stub）。

改完跑这两条：

```bash
python tools/check-docs.py
```
```bash
python tools/build-preview.py
```

`check-docs.py` 查断链、锚点、决策编号连续性、声明条数与实际是否一致，
以及**已推翻的决策是否还在别处被当成现行的引用**——v17 那次漏改 `conventions/ui.md`
就是这类问题。**报错就修，不要忽略。**

---

## 与 GameHub 的关系

前身工程在 `E:\GameHub`：约 3200 行道路与地形的领域实现、1845 行离线测试，
以及一套可直接留用的编辑器外壳（停靠系统、i18n、项目门厅、存档信封、无边框窗口、图标系统）。

**它被冻结为参考实现**（决策 10、goals.md §8）：

- **不再加新功能**，严重 bug 仍修
- [roads.md](docs/architecture/roads.md) 是迁移时的规格书
- `js/state/roadTypes.js` 的**主题包机制是决策 20（皮肤包）的原型**——
  「几何只认 widthUnits，主题永远不改变路宽、最小半径与路网拓扑」
- 迁移若发生，用**新旧对拍**（旧实现作 oracle），不重写测试

> 文档里形如 `../../js/core/History.js` 的链接指向 `E:\GameHub` 的源码，在本仓库内会断链。
> 这是有意的——它们引用的是那份冻结的参考实现。

---

## 下一步

### M0 已完成

| | 产出 |
|---|---|
| ✅ **求值语义定稿**（决策 31） | [ADR-002](docs/design/adr-002-eventsheet-eval.md) **r2 · 已验证**——[两轮推演](docs/design/adr-002-walkthrough.md)走通三个样例，补上 6 处语义缺口 |
| ✅ **AI 控制协议推演**（决策 40） | [ADR-003](docs/design/adr-003-verified-agent-loop.md) **r2**——[两轮推演](docs/design/adr-003-walkthrough.md)补上 8 处缺口；M1-b 已为事务、revision 与修复权限底座提供机器执行证据 |
| ✅ **工程地基**（M0-b） | vite + three + Rapier 从 npm 加载；`npm test` 6 项 headless 断言 |
| ✅ **ECS 选型**（ADR-001） | [spike-002](docs/design/spike-002-ecs.md) 六条判据全过，**koota 锁定**；`U-001` 关闭 |
| ⚠️ **物理确定性**（决策 29） | [spike-001](docs/design/spike-001-rapier-determinism.md)——同机与跨 V8 版本通过；**跨 CPU 架构未验**（需第二台机器，截止点闸门 A） |
| ⬜ **决策治理回放**（决策 42） | [ADR-004](docs/design/adr-004-evidence-governed-evolution.md) G1–G3 未做。横切约束，**不阻塞 M1** |

### M1-a / M1-b / M1-c / M1-d / M1-f / M1-h 已完成；下一步是 M1-i

**M1-a ECS 封装层**已经提供稳定实体 id、按 id 升序的 `query()`、声明式组件 schema、
连续版本迁移与结构化诊断；生产代码只在适配层导入 koota。9 项 M1-a 测试含 koota 原始错序与半写负例，
`U-002` 已关闭。

**M1-c** 已提供确定性版本信封、SHA-256 revision、组件 / 信封迁移链、按块存取、
跨块实体引用恢复、精确运行时版本解析与命名 checkpoint。`U-039` 已关闭：升级 Rapier 时保留旧版本适配器，
快照缺少精确运行时时在加载世界前失败，不得回退到最新版。

**M1-b** 已提供 Action Registry、自省、JSON Schema 子集、前置条件、稳定语义 `affects`、确定性真实 diff、
preview / commit / abort、幂等、命名 checkpoint、日志与撤销。11 项测试关闭 `U-041` / `U-042`：
计划基线只在首步校验，后续步骤只接受本 run 推进的 revision；repair 只能使用本步骤批准的 Action 与影响域，
越界稳定返回 `needs-review`。

**M1-d** 已提供 TestSpec / oracle registry、按实际 `affects` 选择回归集、固定 seed RNG、checkpoint / 候选世界隔离运行、
意图 / 设备两层输入适配、固定 tick、结构化证据与 M1-b validator。8 项测试证明 hard 失败阻止 commit、soft 失败不能覆盖 hard、
oracle 不得改世界后自称通过；`U-043` / `U-044` 仍保持活动，具体设备事件格式与 `covers` 准确性留到 M3-f 验证。

**M1-f** 已提供可序列化的 ECS Transform 与父子层级、稳定网格空间索引、实体射线拾取，以及 ECS → Three.js 的增量只读投影。
9 项测试覆盖层级与序列化、循环和无效父节点、索引更新的原子性、稳定命中顺序、投影增删改、动态 bounds 与渲染对象不得回写 ECS。
浏览器自检已迁移到真实 ECS 投影，并能点击选中稳定实体 id；BVH 与射线候选加速仍按路线图后置。

**M1-h** 已交付第一版真正可操作的编辑器：ECS 父子大纲、schema 自动详情、点选 / Ctrl 多选 / 拖框、
translate / rotate / scale gizmo、轨道相机与桌面三栏工作台。编辑器选择只存稳定 id，不进世界快照；
属性输入与 gizmo 松手统一提交 `editor.patch-components` Action，并共享现有 revision、checkpoint 与撤销栈。
6 项 M1-h 测试覆盖 GUI / Action revision 对拍、批量回滚、选择隔离、世界替换重绑定、层级环拒绝与父子 gizmo 补丁。

下一步做 **M1-i 最小 AI 单步指令**，验证模型与人能否复用同一条 Action 通道和事务回执；随后进入 M1-g 分块流式加载。

完整的包拆分、依赖、砍单顺序见 [roadmap.md](docs/design/roadmap.md) M1。

> **仍然有效的两条纪律**：不往设计文档里加新范围；`preview.html` 是生成物。
>
> 「不加新规范直到至少一份 ADR 转入已验证」这条**已达成**——
> ADR-001 与 ADR-002 均为「已验证」。但它换成了一条更强的：
> **M1 期间新增的任何协议字段，都要有一个跑得起来的测试**，
> 而不是又一段纸面规范。ADR-002 的 D4、ADR-001 的排序职责都已经做到了这一点。

> v16 是一次**收口**（提前不可逆决策、补执行漏洞）；
> **v17 是一次转向**——它删掉的比加上的多，因为一整套「为普通人付的税」随画像一起走了。
