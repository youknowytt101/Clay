# 道路系统架构

> 交互模型对齐 Cities: Skylines 2，几何方案经调研对齐 CS1/CS2 与业界实践
> （贝塞尔路缘圆角、miter/round join、路定高程）。数据层零 three.js 依赖，可在 node 中离线测试。

## 模块与数据流

```
输入                工具层                命令层                    数据层                渲染层
InputRouter ──► RoadTool ──────► BuildRoadCommand ──────► RoadNetwork(图)  ──► RoadView
 (指针事件)    (控制点栈+吸附)    (journal, 可撤销)          Terrain(高度图)       ├─ computeSegGeometry
                    │                  │                        │    ▲            │   (edgeGeometry)
                    │                  ├─ computeRoadbed ───────┘    │            ├─ computeJunction
                    │                  ├─ computeNodeDisc ───────────┘            │   (junction)
                    │                  └─ _replaceCovered                         └─ buildRibbon
                    └────────────── 预览复用 buildRibbon
信号：roadsChanged(受影响节点) / heightChanged(脏矩形) → 各视图增量重建
```

| 文件 | 职责 |
|---|---|
| [state/roadTypes.js](../../js/state/roadTypes.js) | 参数化 0.5U–5U 道路规格 + 主题包注册表；宽度⊥主题（见下节） |
| [state/RoadNetwork.js](../../js/state/RoadNetwork.js) | 节点+路段无向图；三次贝塞尔（存 4 控制点）；空间哈希判重；吸附查询；de Casteljau 分裂 |
| [state/polyline.js](../../js/state/polyline.js) | 折线弧长工具：截断（超长按比例缩，永不为 null）、按弧长走点取向 |
| [state/junction.js](../../js/state/junction.js) | 节点几何决策（见下表）；纯数学 |
| [state/edgeGeometry.js](../../js/state/edgeGeometry.js) | 路段左右边界：裁剪后中心线 + 逐点半宽（喇叭口）+ 端部共享横断面 |
| [commands/commands.js](../../js/commands/commands.js) | BuildRoadCommand：分裂/建段/替换/整平全部 journal 化，undo 逐采样精确还原 |
| [commands/roadbed.js](../../js/commands/roadbed.js) | 路定高程：纵断面平滑限坡 → 走廊压平+锁定 → 节点圆盘压平（坡地防穿模） |
| [render/RoadView.js](../../js/render/RoadView.js) | 订阅 roadsChanged 增量重建；路段带状网格 + 节点补丁；按 roadRef/主题包共享材质 |
| [tools/RoadTool.js](../../js/tools/RoadTool.js) | CS2 交互：四模式控制点栈、右键逐点回退、六层吸附+修饰键、工程 HUD、红色禁建 |
| [tools/DemolishTool.js](../../js/tools/DemolishTool.js) | 拆除：悬停红色高亮 → 点击删除；走廊解锁、孤点清理、路口重算（可撤销） |
| [tools/EditTool.js](../../js/tools/EditTool.js) | 事后编辑（Move It 式）：端点/切线手柄实时拖拽重塑，松手重贴地，一条撤销 |

## 标准道路 + 主题皮肤（roadTypes.js）

工作流是「先画标准宽度的路网，之后整体套年代风格」。三条分离原则：

**1. 几何只认 widthUnits。** 主题永远不改变路宽、最小半径或路网拓扑。
画路时 `RoadTool._roadRef()` 只写宽度，不写主题。

**2. 主题是场景级呈现，不是路段内容。**

```
seg.roadRef = { widthUnits: 2, theme: null }   // null = 跟随场景
game.settings.themePackId                       // 场景主题（存档里的 roadSelection）
生效主题 = seg.roadRef.theme ?? 场景主题
```

换主题 = `SetSceneThemeCommand`：改一个字段 + dispatch `themeChanged`，
渲染层作废材质缓存重建。**不遍历路网、不写逐段 diff**。
需要混搭（中世纪老城 + 现代新区）时才在路段上写 `theme` 覆盖；
`ClearThemeOverridesCommand` 负责抹平。

面板交互：点主题卡片**只移动选中光标，不动场景**；点卡片上的「替换」才套用到全场
（`ApplyThemeCommand` = 切场景主题 + 抹平覆盖，合成一条撤销记录）。
场景当前生效的主题在卡片上标"使用中"，与选中态是两个独立标记。

**3. 主题声明规则，不列宽度表。**

| 声明 | 含义 |
|---|---|
| `surface: { color: {0.5: c, 2: c, 5: c}, roughness, metalness, emissive, map, repeat }` | 材质描述符；颜色是插值站点，未声明的宽度自动插值 |
| `decorations: [{ kind, minWidthUnits, count, ... }]` | 装饰清单；`count` 可为 `widthUnits` 的函数，求值为 0 则该装饰消失 |

新增宽度档位不需要改任何主题包；新增主题只写 4 行规则。

**装饰扩展点**：RoadView 顶部有 `SEG_DECORATORS` / `NODE_DECORATORS` 两张
`kind → builder` 注册表。加一种装饰 = 注册一个函数 + 在主题里加一条，
既有主题与 `_buildSeg` 都不用动（科幻包的 `edgeGlow` 就是这么加的）。
几何锚点（路缘路径、斑马线锚点）由 junction.js **恒输出**，铺不铺由渲染层按主题闸门——
数据层不认识主题词汇表。

内置包：`whitebox`（素路面）/ `modern`（路缘+虚线+斑马线）/ `medieval`（仅宽路石质路缘）/ `scifi`（发光边条+金属路面）。

## 节点几何决策表（junction.js）

| 节点情形 | kind | 几何 |
|---|---|---|
| 度=1（断头） | none | 无（端头盖待路缘石阶段做） |
| 度=2 近直（>165°）同宽 | **miter** | 共享斜接横断面：两侧路面用同两个顶点，缝隙在几何上不存在 |
| 度=2 近直 异宽 | **transition** | 共享横断面取窄侧半宽；宽侧沿弧长平滑收窄（喇叭口，edgeGeometry） |
| 度=2 可见折弯（≤165°） | **bend** | 路面退到内交点截断线（不重叠）；补丁 = 内共享点 + 外侧半径=半宽的圆弧端帽，与路口圆角同观感 |
| 度≥3 | **polygon** | 各臂截断线（斜接投影+圆角缓冲）在曲线真实位置 + 相邻臂间三次贝塞尔路缘圆角；≥295° 反射楔圆弧兜底 |

关键不变量：
- **切断线两侧 bit-exact**：补丁边界点与路面裁剪端出自同一段代码（walkPolyline），不靠浮点巧合。
- **法线/接缝**：地形法线从高度图中心差分，路面横断面水平——高度用同一次采样。
- **雕刻与道路双向贴合**：铺路时压平路基并锁定走廊；笔刷可以雕刻一切（含路下），
  笔画结束后受影响道路自动重新贴地（重采纵断面→限坡→压平→重锁定），与笔画同属一条撤销命令。
  节点周边用"限坡锥面包络"护住路口盖板（允许路面斜穿节点爬坡，只削横向鼓包）；
  路肩外侧同理用"路堤边坡包络"（EMBANK=45°）：包络内的玩家雕刻原样保留，只夹回超坡高差。

## 可调参数

| 参数 | 位置 | 含义 |
|---|---|---|
| `FILLET_K = 0.8` | junction.js | 路口圆角缓冲（× 相邻臂最大半宽），越大转角越圆 |
| `FILLET_CTRL = 0.4` | junction.js | 圆角贝塞尔控制点系数（0.55≈正圆弧） |
| `REFLEX_ARC = 295°` | junction.js | 反射楔圆弧兜底阈值（仅度≥3 可达） |
| `MITER_MIN = 165°` | junction.js | miter/transition（近直无缝）与 bend（圆角弯头）的分界（对应 CS1 Max Turn Angle） |
| `ROAD_UNIT_WIDTH = 3`（= 30 × `GRID_UNIT`） | roadTypes.js / core/units.js | 1U = 1 车道基准宽度 3 米；所有道路总宽均由单位数线性计算（0.5U=1.5m ~ 5U=15m），贴近真实道路尺度 |
| `DEFAULT_SCENE_THEME = 'whitebox'` | roadTypes.js | 路段无覆盖、场景也没设主题时的回退 |
| `minRadius = width × 1.6` | roadTypes.js | 各宽度规格的最小弯道半径（红色禁建） |
| `MAX_SLOPE = 0.3` | roadbed.js | 路基纵坡上限 |
| 覆盖替换阈值 `0.9 / 0.75` | commands.js | 旧路 ≥90% 落在（半宽和×0.75）走廊内则被替换 |

## 装饰层（RoadView）

所有装饰与路面共用同一套横断面帧（`computeFrames`），保证对齐：
- **`curb`**（几何，路段+路口）：沿路段两侧边界放样（顶面+外立面），路口沿盖板边界路径（junction 输出 `curbs`，切断线处留口与路段路缘续接）
- **`centerline`**（贴地薄面，路段）：按 `count` 条车道分界铺 dash/gap 虚线；随喇叭口半宽收缩
- **`crosswalk`**（贴地薄面，路口）：度≥3 路口各臂截断线外侧，条纹长轴沿行车方向
- **`edgeGlow`**（贴地薄面，路段）：两侧内缩的自发光窄带（Basic 材质，无需后处理泛光）
- 路口内部保持素路面（CS 布局）；尺寸参数全部来自主题声明，不再是 RoadView 的模块常量

## 离线测试（tests/）

`node tests/run-all.mjs` 跑全部 13 个套件（数据层零 three.js 依赖）。
覆盖：图操作与撤销、斜接重合与朝向、弯头内外弧、喇叭口、宽度⊥主题（规则式主题包/场景主题与路段覆盖/材质描述符）、v1–v5 存档迁移、重画替换、裁剪对齐、装饰层数据、G1 续接。

## 已知待办

- 道路纹理阶段：纵向 UV 里程跨缝对齐、盖板世界空间投影、共享横断面法线平均
- 路缘石/人行道 profile 放样（边界曲线已就绪）；断头路圆头端盖
- 高程系统（高架/隧道）、平行模式、网格模式
- 编辑工具进阶：多选/框选、节点合并吸附、最小半径实时校验
