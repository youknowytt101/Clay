# ADR-001 · ECS 库选型

| | |
|---|---|
| **状态** | **倾向已定，待 spike 验证**（M1 第 1 周结束时转为「已定」或「改选」） |
| **日期** | 2026-08-08 |
| **决策者** | 项目所有者 |
| **上游** | [goals.md](goals.md) 决策 4（实体模型 = ECS）、§6（模块化契约）、§9（未决项） |

---

## 1. 背景

[goals.md](goals.md) 决策 4 定了实体模型用 ECS。本 ADR 决定**用哪个实现**。

选型必须服务的，是 goals.md 里已经定死的几件事，而不是「哪个 ECS 更好」这种泛问：

| 约束来源 | 对 ECS 的要求 |
|---|---|
| §3.2 播放沙箱 | 全世界快照 + 回滚 |
| §3.1 Action 层 | 变更可追踪、可 diff、可回放 |
| §4.1 试飞台（Q1） | **确定性**：同一 Action 序列 → 同一序列化结果 |
| §6.2 模块契约 | 组件类型可在运行时由模块注册 |
| 决策 5 JS 脚本 | 脚本由**人和 AI**书写，API 出错率是一等指标 |
| §4.2 详情面板 | 组件 schema 可自省，用于自动生成控件 |
| 商业化可能性 | 许可证不能带传染性约束 |

---

## 2. 候选与数据

2026-08-08 实测 npm registry 与 GitHub API：

| 库 | 版本 | 最后发布 | 仓库最后提交 | 周下载 | Stars | 许可证 |
|---|---|---|---|---|---|---|
| **bitECS** | 0.4.0 | 2025-12-06 | 2026-04-12 | 15.7k | 1484 | **MPL-2.0** |
| **koota** | 0.6.6 | 2026-05-09 | 2026-08-04 | 10.5k | 712 | ISC |
| miniplex | 2.0.0 | 2023-07-16 | — | 4.5k | ~1k | MIT |
| becsy | 0.15.5 | 2025-03-02 | — | 106 | ~300 | MIT |
| arancini | 8.1.0 | 2025-07-01 | — | 29 | — | MIT |

**首轮淘汰：**

- **miniplex** — 三年未发版。12 个月冲刺不赌停更的库。
- **becsy / arancini** — 周下载两位数，出问题只能自己啃源码，没有社区兜底。

真实候选：**bitECS / koota / 自研**。

---

## 3. 逐项对比

| 需求 | bitECS 0.4 | koota 0.6 |
|---|---|---|
| 快照 + 回滚 | ✅ 内置 `createSnapshotSerializer` | ❌ 无内置 |
| 变更追踪 | ✅ Observer serializer | ✅ `Added/Removed/Changed` 修饰符 |
| 运行时注册组件 | ✅ 组件即普通对象 | ✅ trait 即值 |
| 组件 schema | ⚠️ 仅序列化类型标记 `f32/u8/str` | ⚠️ `trait({x:0,y:0})` 有字段名+默认值 |
| 脚本书写体验 | ❌ `Position.x[eid] = 10` | ✅ `updateEach(([pos]) => pos.x += 1)` |
| 关系 / 层级 | ✅ Relations + Prefabs | ✅ Relations |
| 维护活跃度 | 中 | **高** |
| 许可证 | ⚠️ MPL-2.0 | ✅ ISC |

### 三个决定性发现

**发现 1 · schema 两家都不够用，封装层无论如何要写。**

详情面板自动生成与 AI 可读，需要的是字段范围、枚举、实体引用、单位、说明。
bitECS 的 `f32/str` 只是序列化标记；koota 的默认值只能推出类型。**两家都到不了。**

推论：选型**不是**不可逆的地基决策 —— 见第 4 节。

**发现 2 · MPL-2.0 是真实约束。**

bitECS 是文件级弱著佐权。链接使用无碍，但**被修改的每个 bitECS 源文件都必须公开**。
而本项目几乎一定会改它（快照要接版本化信封、确定性要审计迭代顺序）。
对可能商业化的引擎，这是要提前算的账。koota 的 ISC 无此问题。

**发现 3 · 脚本书写体验的权重高于直觉。**

```js
Position.x[eid] = 10     // bitECS：eid 写错会静默改掉别的实体
pos.x = 10               // koota：错了就是错了
```

脚本作者是**开发者和 AI**（决策 5 + §4.3）。AI 写第一种形式出错率显著更高，
且**错误静默**——改到相邻实体不报错，只让 demo 行为诡异，排查成本极高。
这直接打击「AI 真的好用」这个成功判据。

---

## 4. 决策

### 4.1 用一层薄封装把 ECS 库藏起来（无条件执行）

**模块代码禁止直接 import ECS 库。** 组件定义走自写的 `defineComponent()`，
查询走自写的 `query()`，脚本只见到封装层的 API。

三条理由：

1. schema 层反正要写（发现 1），封装是顺带的，边际成本≈0
2. §6.2 模块契约本来就禁止「直接读写不属于自己的组件表」，封装层是它的执行点
3. **选型从「地基决策」降级为「可替换模块」**，§6.4 的退役条件因此才可执行

有了封装，选错的代价从「重写引擎」变成「重写约 800 行适配层」。

### 4.2 主选 koota，spike 后锁定

理由按权重：**ISC 许可证 > 脚本书写体验 > 维护活跃度**。

放弃 bitECS 内置快照的代价可控：本项目存档要的是**版本化信封 + 迁移链**
（沿用现有 [core/serialize.js](../../js/core/serialize.js) 的范式），
bitECS 的二进制快照是为网络复制设计的，本来也不能直接用；
播放沙箱的回滚用结构化克隆自写，量级在几十行。

### 4.3 不自研

自研预计 2–4 周。它能带来的控制力，封装层已经给了；
而 relations / prefabs / 归档查询这些白送的能力，自己补要更久。
12 个月冲刺付不起这个价。

---

## 5. Spike 方案（M1 第 1 周，3 天）

两个库各实现同一纵切片，跑完即决策：

1. 三种组件：纯数值 / 字符串 / 对象引用（mesh 句柄）
2. 运行时注册一个「模块」的组件集
3. 快照 → 改 100 个实体 → 回滚，验证完全还原
4. 10k 实体查询循环，测帧时间
5. **确定性**：同一 Action 序列跑两遍，序列化字节完全一致
6. 手写 30 行「游戏逻辑」，评估书写体验

**第 5 条是杀手判据。** 原型式 ECS 的查询迭代顺序会随组件增删变化，
两家文档均**未承诺**确定性——必须实测，不能信文档。

---

## 6. 退役条件（按 goals.md §6.4 预先写死）

- spike 中任一库无法在 3 天内跑通确定性测试 → **淘汰该库**
- 两家都跑不通 → **自研**，预算上限 3 周；超时则接受「仅编辑期确定性」，
  并把回放功能降级为「Action 日志可读但不保证逐字节复现」
- 封装层落地后，若 6 个月内需要换库 → **换**，代价已被封装层限制在约 800 行内

---

## 7. 连带影响

- **组件 schema 定义方式**（goals.md §9 第 2 项）与本决策绑定，同期决定
- **构建与依赖管理**：当前无 `package.json`、无打包器，three 走 CDN importmap。
  引入 ECS + Rapier + glTF 后大概率绕不开构建步骤，需在 M1 第 1 周一并决定
- 三个被淘汰的库不再复议，除非它们的维护状态发生实质变化

---

## 8. 信息来源

- [bitECS 官网文档](https://bitecs.dev/docs/introduction)
- [bitECS 0.4.0 Release Notes](https://github.com/NateTheGreatt/bitECS/blob/main/docs/RELEASE_NOTES_0.4.0.md)
- [bitECS Serialization 文档](https://github.com/NateTheGreatt/bitECS/blob/main/docs/Serialization.md)
- [koota README](https://github.com/pmndrs/koota)
- [becsy 文档](https://lastolivegames.github.io/becsy/guide/introduction)
- [Web Game Dev · ECS 库对比](https://www.webgamedev.com/code-architecture/ecs)
- [awesome-entity-component-system](https://github.com/jslee02/awesome-entity-component-system)
- npm registry API / GitHub API，2026-08-08 实测
