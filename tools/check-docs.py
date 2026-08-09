# -*- coding: utf-8 -*-
"""文档一致性校验。改完文档跑一遍：python tools/check-docs.py

十项检查：
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
HIST_MARKS = ['v15', 'v16', 'v17', 'v18', 'v19', '原文', '推翻', '取消', '已于', '曾', '改写']

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
