# -*- coding: utf-8 -*-
"""文档一致性校验。改完文档跑一遍：python tools/check-docs.py

十九项检查：
  1. 相对链接指向的文件存在
  2. goals.md 的内部锚点指向真实存在的小节
  3. 决策编号连续、无重复
  4. §0.4 声明的决策条数 == 决策表实际条数
  5. §10 风险表声明的条数 == 实际条数
  6. 已推翻/已取消的决策，是否还在别处被当成现行的引用
  7. §3.7 硬事实登记表的值 == 下游文档同名键的值      （v19）
  8. ADR 状态 vs 下游措辞：下游不得超前于 ADR 的状态    （v19）
  9. 退役术语（术语层 / 简易模式）未出现在当前态文档里    （v19）
 10. 裸引用（§N.M / 决策 N）指向真实存在的小节与决策     （v19）
 11. 当前版本同步到 README / AGENTS / outline / roadmap / SVG （v20）
 12. ADR-003 进入预览，控制协议关键投影齐全                 （v20）
  13. v18「档 2 留口 / AI 自己试玩」旧当前态不再出现          （v20）
  14. ADR-004 进入预览，决策发现与演化协议投影齐全             （v21）
  15. §9 不确定项 ID 连续、风险乘积正确、引用存在               （v21）
  16. v20「四件事 / 两份纸面 ADR」旧当前态不再出现             （v21）
  17. 每份 ADR 都进了 README 文件树与 build-preview           （v21 审计）
  18. M0 顺序：治理 G1/G2 不得前置于 ADR-002                  （v21 审计）
  19. AGENTS/README 里的 ADR 状态断言与实际一致              （交接审计）
"""
import io, os, re, sys, glob

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GOALS = os.path.join(BASE, 'docs', 'design', 'goals.md')

# 已被推翻或取消的决策 -> 说明。在 goals.md 以外的文件里出现即告警。
OVERTURNED = {
    2:  'v17 推翻，用户画像改为 19′',
    12: 'v17 取消双模式，机制以 I8 保留',
    19: 'v17 推翻，见 19′',
}

# 已退役的术语。出现在「当前态」文档里即告警；带下列标记的行视为历史叙述，豁免。
RETIRED_TERMS = ['术语层', '简易模式']
HIST_MARKS = ['v15', 'v16', 'v17', 'v18', 'v19', 'v20', 'v21', 'v22', '原文', '推翻', '取消', '已于', '曾', '改写']

problems, notes = [], []


def read(p):
    return io.open(p, encoding='utf-8').read()


def mds():
    out = glob.glob(os.path.join(BASE, 'docs', '**', '*.md'), recursive=True)
    for n in ('README.md', 'AGENTS.md', 'CLAUDE.md'):
        p = os.path.join(BASE, n)
        if os.path.exists(p):
            out.append(p)
    return sorted(out)


def rel(p):
    return os.path.relpath(p, BASE).replace('\\', '/')


def norm(s):
    """归一化到只剩字母数字与中日韩字符，容忍连字符位置差异。"""
    return re.sub(r'[^0-9a-z一-鿿]', '', s.lower())


g = read(GOALS)

# ---- 1. 相对链接 ----------------------------------------------------------
for m in mds():
    d = os.path.dirname(m)
    for _txt, url in re.findall(r'\[([^\]]*)\]\(([^)#][^)]*)\)', read(m)):
        if url.startswith('http') or '../../js/' in url:
            continue
        if not os.path.exists(os.path.normpath(os.path.join(d, url.split('#')[0]))):
            problems.append('[断链] %s -> %s' % (rel(m), url))

# ---- 2. goals.md 内部锚点 -------------------------------------------------
heads = {norm(h) for h in re.findall(r'^#{2,4}\s+(.*)$', g, re.M)}
for a in sorted(set(re.findall(r'\]\(#([^)]+)\)', g))):
    if norm(a) not in heads:
        problems.append('[锚点] goals.md 引用了不存在的小节: #%s' % a)

# ---- 3~4. 决策编号 --------------------------------------------------------
sec2 = g.split('## 二 · 决策表')[1].split('\n---\n')[0]
dec = [int(n) for n in re.findall(r'^\|\s*\*{0,2}(\d+)\*{0,2}\s*\|', sec2, re.M)]
maxdec = max(dec) if dec else 0
if dec:
    dup = {n for n in dec if dec.count(n) > 1}
    if dup:
        problems.append('[决策] 编号重复: %s' % sorted(dup))
    miss = [n for n in range(1, maxdec + 1) if n not in dec]
    if miss:
        problems.append('[决策] 编号不连续，缺: %s' % miss)
    d0 = re.search(r'决策表\]\([^)]*\)的\s*(\d+)\s*项', g)
    if d0 and int(d0.group(1)) != len(dec):
        problems.append('[决策] §0.4 声明 %s 项，实际 %d 条' % (d0.group(1), len(dec)))
    notes.append('决策 %d 条，最大编号 %d' % (len(dec), maxdec))

inv = len(re.findall(r'^\|\s*\*\*I\d+\*\*', g, re.M))
notes.append('不变量 %d 条' % inv)

# ---- 5. 风险表条数 --------------------------------------------------------
mr = re.search(r'## 十 · 风险(.*?)\n\*\*v17 删掉的五条\*\*', g, re.S)
nrisk = 0
if mr:
    nrisk = len(re.findall(r'^\|\s*\*{0,2}[\d]+[b′\']?\*{0,2}\s*\|', mr.group(1), re.M))
    said = re.search(r'现表\s*(\d+)\s*条', g)
    if said and int(said.group(1)) != nrisk:
        problems.append('[风险] §10 声明 %s 条，实际 %d 条' % (said.group(1), nrisk))
    notes.append('风险 %d 条' % nrisk)

# ---- 6. 已推翻的决策在别处被引用 ------------------------------------------
for m in mds():
    if os.path.abspath(m) == os.path.abspath(GOALS):
        continue
    for line in read(m).split('\n'):
        for n, why in OVERTURNED.items():
            if re.search(r'决策\s*%d(?![\d′\'])' % n, line):
                if any(k in line for k in HIST_MARKS):
                    continue
                problems.append('[过期引用] %s 引用决策 %d（%s）: %s'
                                % (rel(m), n, why, line.strip()[:70]))

# ---- 7. 硬事实登记表 vs 下游 ---------------------------------------------
facts = {}
mf = re.search(r'### 3\.7 硬事实登记表.*?\n\| 键 \| 值 \|\n\|[-\s|]*\|\n(.*?)\n\n', g, re.S)
if not mf:
    problems.append('[硬事实] 找不到 §3.7 登记表，或格式被改动')
else:
    for line in mf.group(1).strip().split('\n'):
        c = [x.strip() for x in line.strip('|').split('|')]
        if len(c) == 2:
            facts[c[0]] = c[1]
    notes.append('硬事实 %d 项' % len(facts))
    # 登记表自身要与实测一致
    for k, v, real in (('决策条数', facts.get('决策条数'), len(dec)),
                       ('不变量条数', facts.get('不变量条数'), inv),
                       ('风险条数', facts.get('风险条数'), nrisk)):
        if v is not None and v.strip() != str(real):
            problems.append('[硬事实] 「%s」登记为 %s，实际 %d' % (k, v, real))
    # 下游同名键的值必须一致
    downstream = [os.path.join(BASE, 'docs', 'design', f) for f in
                  ('architecture-outline.md', 'roadmap.md')] + \
                 [os.path.join(BASE, n) for n in ('README.md', 'AGENTS.md')]
    for m in downstream:
        if not os.path.exists(m):
            continue
        for line in read(m).split('\n'):
            if any(k in line for k in HIST_MARKS):
                continue
            for k, v in facts.items():
                if k in line and k not in ('决策条数', '不变量条数', '风险条数', '当前版本'):
                    num = re.search(r'\d+', v)
                    if num and num.group(0) not in line:
                        problems.append('[硬事实] %s 的「%s」与登记值 %s 不符: %s'
                                        % (rel(m), k, v, line.strip()[:60]))

# ---- 8. ADR 状态 vs 下游措辞 ---------------------------------------------
FROZEN = '已冻结'
for adr in sorted(glob.glob(os.path.join(BASE, 'docs', 'design', 'adr-*.md'))):
    s = read(adr)
    st = re.search(r'^\|\s*\*\*状态\*\*\s*\|\s*(.+?)\s*\|', s, re.M)
    if not st:
        problems.append('[ADR] %s 没有「状态」行' % rel(adr))
        continue
    # 状态单元格里常带「转『已冻结』的条件是…」这类说明，
    # 所以只取开头那个粗体词作为状态本身，不要整格匹配。
    tok = re.match(r'\s*\*\*(.+?)\*\*', st.group(1))
    if not tok:
        problems.append('[ADR] %s 的状态必须以 **状态词** 开头' % rel(adr))
        continue
    state = tok.group(1)
    notes.append('%s 状态: %s' % (os.path.basename(adr), state))
    if state == FROZEN:
        continue
    stem = os.path.basename(adr).split('-')[0] + '-' + os.path.basename(adr).split('-')[1]
    for m in mds():
        if os.path.abspath(m) == os.path.abspath(adr):
            continue
        # 只认「已冻结」这一个断言词；描述「将来转为已冻结」的行豁免。
        # 这是十项里最弱的一项——它查措辞不查语义，改写措辞就能绕过。
        TRANSITION = ('转「已冻结」', '后转', '走通后', '转为「已冻结」')
        for line in read(m).split('\n'):
            if stem in line and '已冻结' in line and not any(t in line for t in TRANSITION):
                problems.append('[ADR 状态] %s 称 %s 已冻结，但 ADR 状态是「%s」: %s'
                                % (rel(m), stem, state[:12], line.strip()[:60]))

# ---- 9. 退役术语 ----------------------------------------------------------
for m in mds():
    for i, line in enumerate(read(m).split('\n'), 1):
        if any(k in line for k in HIST_MARKS):
            continue
        for t in RETIRED_TERMS:
            if t in line:
                problems.append('[退役术语] %s:%d 出现「%s」: %s'
                                % (rel(m), i, t, line.strip()[:60]))

# ---- 10. 裸引用 §N.M / 决策 N --------------------------------------------
gheads = set(re.findall(r'^#{3}\s+(\d+\.\d+)', g, re.M))
for m in mds():
    if 'adr-' in m or 'conventions' in m or 'architecture' in m or m.endswith(('README.md', 'AGENTS.md', 'CLAUDE.md')) \
       or os.path.abspath(m) == os.path.abspath(GOALS):
        targets = [m]
    else:
        targets = [m]
    s = read(m)
    for sec in set(re.findall(r'§(\d+\.\d+)', s)):
        if sec not in gheads:
            problems.append('[裸引用] %s 引用 §%s，goals.md 无此小节' % (rel(m), sec))
    for n in set(int(x) for x in re.findall(r'决策\s*(\d+)', s)):
        if n > maxdec:
            problems.append('[裸引用] %s 引用决策 %d，最大编号只有 %d' % (rel(m), n, maxdec))

# ---- 11. 当前版本投影 ------------------------------------------------------
current_version = facts.get('当前版本')
if current_version:
    version_targets = {
        'README.md': '当前 **%s**' % current_version,
        'AGENTS.md': 'goals.md %s' % current_version,
        'docs/design/architecture-outline.md': '对应 goals.md %s' % current_version,
        'docs/design/roadmap.md': '对应 goals.md %s' % current_version,
        'docs/diagrams/overview.svg': 'goals.md %s' % current_version,
    }
    for name, needle in version_targets.items():
        p = os.path.join(BASE, *name.split('/'))
        if not os.path.exists(p) or needle not in read(p):
            problems.append('[当前版本] %s 缺少「%s」' % (name, needle))

# ---- 12. v20 控制协议投影 -------------------------------------------------
protocol_targets = {
    'docs/design/architecture-outline.md': ('PlanContract', 'EvidenceLedger', '验证驱动自主循环'),
    'docs/design/roadmap.md': ('adr-003-verified-agent-loop.md', 'M3-e **orchestrator 状态机**', 'M3-h **`EvidenceLedger`'),
    'docs/design/ai-native-engine.md': ('## 控制协议 · Plan-Build-Verify-Repair', '验证驱动的自主循环', '错误通过率'),
    'README.md': ('ADR-003', 'PlanContract'),
    'AGENTS.md': ('决策 40 的 v20 修订', 'hard oracle'),
}
for name, needles in protocol_targets.items():
    p = os.path.join(BASE, *name.split('/'))
    s = read(p) if os.path.exists(p) else ''
    for needle in needles:
        if needle not in s:
            problems.append('[控制协议] %s 缺少「%s」' % (name, needle))

preview_builder = read(os.path.join(BASE, 'tools', 'build-preview.py'))
if 'adr-003-verified-agent-loop.md' not in preview_builder:
    problems.append('[预览] tools/build-preview.py 未纳入 ADR-003')

# ---- 13. v18 自主循环旧当前态 ---------------------------------------------
legacy_patterns = (
    ('受监督的自主循环', '留口'),
    ('AI 自己试玩', '本轮做'),
    ('A1 / A2 留口',),
)
for name in ('docs/design/architecture-outline.md', 'docs/design/roadmap.md',
             'docs/design/ai-native-engine.md'):
    p = os.path.join(BASE, *name.split('/'))
    for i, line in enumerate(read(p).split('\n'), 1):
        if any(all(part in line for part in pattern) for pattern in legacy_patterns):
            problems.append('[旧 AI 当前态] %s:%d: %s' % (name, i, line.strip()[:90]))

# ---- 14. v21/v22 决策治理协议投影 -----------------------------------------
governance_targets = {
    'docs/design/adr-004-evidence-governed-evolution.md': ('TaskContract', 'DecisionChallenge', 'EvolutionProposal', '## 14. 最小执行模板', 'any` / `all` / `none'),
    'docs/design/architecture-outline.md': ('TaskContract', 'DecisionChallenge', 'champion/challenger', '分支实体集传播'),
    'docs/design/roadmap.md': ('adr-004-evidence-governed-evolution.md', 'M0-d 决策治理准入', '治理准入 G0', 'G2 r2'),
    'docs/design/ai-native-engine.md': ('## 研发治理 · Discover-Challenge-Evolve', 'DecisionCoverage', 'champion', '短路'),
    'README.md': ('ADR-004', 'DecisionCoverage', '不增加普适 D13'),
    'AGENTS.md': ('TaskContract', 'DecisionChallenge', 'evidence package', '条件式逻辑探针'),
}
for name, needles in governance_targets.items():
    p = os.path.join(BASE, *name.split('/'))
    s = read(p) if os.path.exists(p) else ''
    for needle in needles:
        if needle not in s:
            problems.append('[决策治理] %s 缺少「%s」' % (name, needle))

if 'adr-004-evidence-governed-evolution.md' not in preview_builder:
    problems.append('[预览] tools/build-preview.py 未纳入 ADR-004')

# ---- 15. §9 结构化不确定项 ------------------------------------------------
mu = re.search(r'## 九 · 未决项(.*?)\n\*\*已决并移出\*\*', g, re.S)
uncertainty_ids = []
if not mu:
    problems.append('[不确定项] 找不到 §9 活动登记表')
else:
    allowed_types = {'事实', '语义', '架构', '产品', '交付'}
    for line in mu.group(1).split('\n'):
        if not re.match(r'^\|\s*\*\*U-\d{3}\*\*\s*\|', line):
            continue
        cells = [x.strip() for x in line.strip('|').split('|')]
        if len(cells) != 5:
            problems.append('[不确定项] 列数不是 5: %s' % line[:90])
            continue
        uid = re.search(r'U-(\d{3})', cells[0])
        if not uid:
            continue
        uncertainty_ids.append(int(uid.group(1)))
        if cells[2] not in allowed_types:
            problems.append('[不确定项] U-%s 类型无效: %s' % (uid.group(1), cells[2]))
        score = re.fullmatch(r'([1-3])/([1-3])/([1-3])=(\d+)', cells[3])
        if not score:
            problems.append('[不确定项] U-%s 风险格式无效: %s' % (uid.group(1), cells[3]))
        elif int(score.group(1)) * int(score.group(2)) * int(score.group(3)) != int(score.group(4)):
            problems.append('[不确定项] U-%s 风险乘积错误: %s' % (uid.group(1), cells[3]))
        if '·' not in cells[4]:
            problems.append('[不确定项] U-%s 缺少「截止点 · 证据」: %s' % (uid.group(1), cells[4]))

if uncertainty_ids:
    if uncertainty_ids != sorted(set(uncertainty_ids)):
        problems.append('[不确定项] 活动 ID 重复或顺序错误: %s' % uncertainty_ids)
    sec9 = g.split('## 九 · 未决项', 1)[1].split('\n---\n', 1)[0]
    valid_uncertainty_ids = set(int(x) for x in re.findall(r'U-(\d{3})', sec9))
    expected = set(range(1, max(valid_uncertainty_ids) + 1))
    if valid_uncertainty_ids != expected:
        problems.append('[不确定项] §9 登记 ID 不连续，缺: %s' % sorted(expected - valid_uncertainty_ids))
    notes.append('活动不确定项 %d 条，累计登记 %d 条' %
                 (len(uncertainty_ids), len(valid_uncertainty_ids)))
    for m in mds():
        for n in set(int(x) for x in re.findall(r'U-(\d{3})', read(m))):
            if n not in valid_uncertainty_ids:
                problems.append('[不确定项] %s 引用不存在的 U-%03d' % (rel(m), n))

# ---- 16. v20 治理旧当前态 -------------------------------------------------
governance_legacy = ('眼下四件事', '「下一步」的四件事', '两份 ADR 都是纸面工作')
for name in ('README.md', 'AGENTS.md', 'docs/design/architecture-outline.md', 'docs/design/roadmap.md'):
    p = os.path.join(BASE, *name.split('/'))
    for i, line in enumerate(read(p).split('\n'), 1):
        if any(old in line for old in governance_legacy):
            problems.append('[旧治理当前态] %s:%d: %s' % (name, i, line.strip()[:90]))

# ---- 17. 每份 ADR 都进了 README 文件树与预览 -------------------------------
# v21 审计发现：ADR-004 已在 README 正文被引用，却漏在文件树里，而检查 14 只查正文字符串。
# 「投影漂移」这次漂在了防漂移机制的缝隙上，所以这条按目录实际内容枚举，不按硬编码清单。
readme = read(os.path.join(BASE, 'README.md'))
tree_blocks = [b for b in re.findall(r'```[^\n]*\n(.*?)```', readme, re.S) if 'Clay/' in b]
tree = '\n'.join(tree_blocks)
for adr in sorted(glob.glob(os.path.join(BASE, 'docs', 'design', 'adr-*.md'))):
    fn = os.path.basename(adr)
    if not tree:
        problems.append('[ADR 投影] README.md 找不到文件树代码块')
        break
    if fn not in tree:
        problems.append('[ADR 投影] README.md 文件树缺少 %s' % fn)
    if fn not in preview_builder:
        problems.append('[ADR 投影] tools/build-preview.py 未纳入 %s' % fn)

# ---- 18. M0 顺序：治理不得前置于求值语义 -----------------------------------
# v21 审计修正：ADR-002 是唯一不可逆项，治理 G1/G2 与它并行，不作为它的前置。
order_legacy = ('先做治理 G1/G2', '先用 ADR-004 的 G1/G2 建立治理准入',
                '进入 AI 指挥前的第一件事', '再让后续 AI 推演 ADR-002')
for name in ('README.md', 'AGENTS.md', 'docs/design/roadmap.md', 'docs/design/goals.md'):
    p = os.path.join(BASE, *name.split('/'))
    for i, line in enumerate(read(p).split('\n'), 1):
        if any(old in line for old in order_legacy):
            problems.append('[M0 顺序] %s:%d: %s' % (name, i, line.strip()[:90]))

# ---- 19. 交接规范里的 ADR 状态断言必须与实际一致 ---------------------------
# 交接规范自身会过期，而且比设计文档更快——它含「当前状态」与「下一步」。
# 一次审计发现 AGENTS.md 还写着「四份 ADR 全部停在倾向已定，零个判据被验证过」，
# 而那时 ADR-001 / ADR-002 已经是「已验证」——接手的模型会据此完全误判项目状态。
STATES = ['草案', '倾向已定', '已验证', '已冻结', '已取代']
real_state = {}
for p in sorted(glob.glob(os.path.join(BASE, 'docs', 'design', 'adr-*.md'))):
    fn = os.path.basename(p)
    if 'walkthrough' in fn:
        continue
    m = re.search(r'\|\s*\*\*状态\*\*\s*\|\s*\*\*(.+?)\*\*', read(p))
    if m:
        st = m.group(1).strip()
        real_state[fn[:7]] = next((s for s in STATES if st.startswith(s)), st)

for name in ('AGENTS.md', 'README.md'):
    p = os.path.join(BASE, name)
    for i, line in enumerate(read(p).split('\n'), 1):
        # 只查同一行里既点名了某份 ADR、又给出了状态词的断言
        for key in set(re.findall(r'[Aa][Dd][Rr]-(\d{3})', line)):
            fn = 'adr-%s' % key
            if fn not in real_state:
                continue
            claimed = [s for s in STATES if s in line]
            if claimed and real_state[fn] not in claimed:
                problems.append('[交接状态] %s:%d 声称 ADR-%s 是「%s」，实际是「%s」'
                                % (name, i, key, '/'.join(claimed), real_state[fn]))
    # 整体性断言：说「全部停在 X」时，实际必须真的全部是 X
    for i, line in enumerate(read(p).split('\n'), 1):
        m = re.search(r'(?:四|五|全)份?\s*ADR\s*(?:都|全部)?\s*(?:停在|处于)\s*[「"]?(\S+?)[」"]?[，。\s]', line)
        if m and set(real_state.values()) != {m.group(1)}:
            problems.append('[交接状态] %s:%d 声称全部 ADR 处于「%s」，实际分布：%s'
                            % (name, i, m.group(1), sorted(set(real_state.values()))))

# ---- 输出 -----------------------------------------------------------------
print('检查了 %d 份文档' % len(mds()))
for n in notes:
    print('  ·', n)
if problems:
    print('\n发现 %d 个问题：' % len(problems))
    for p in problems:
        print('  ✗', p)
    sys.exit(1)
print('\n全部通过。')
