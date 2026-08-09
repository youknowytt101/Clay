# -*- coding: utf-8 -*-
"""文档一致性校验。改完文档跑一遍：python tools/check-docs.py

检查六件事：
  1. 相对链接指向的文件存在
  2. goals.md 的内部锚点指向真实存在的小节
  3. 决策编号连续、无重复
  4. §0.4 声明的决策条数 == 决策表实际条数
  5. §10 风险表声明的条数 == 实际条数
  6. 已推翻/已取消的决策，是否还在别处被当成现行的引用
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

problems = []
notes = []


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


# ---- 1. 相对链接 ----------------------------------------------------------
for m in mds():
    d = os.path.dirname(m)
    for txt, url in re.findall(r'\[([^\]]*)\]\(([^)#][^)]*)\)', read(m)):
        if url.startswith('http') or '../../js/' in url:
            continue          # 外链，以及有意指向 GameHub 的断链
        target = os.path.normpath(os.path.join(d, url.split('#')[0]))
        if not os.path.exists(target):
            problems.append('[断链] %s -> %s' % (rel(m), url))


# ---- 2. goals.md 内部锚点 -------------------------------------------------
def norm(s):
    """归一化到只剩字母数字与中日韩字符，容忍连字符位置差异。"""
    return re.sub(r'[^0-9a-z一-鿿]', '', s.lower())


g = read(GOALS)
heads = {norm(h) for h in re.findall(r'^#{2,4}\s+(.*)$', g, re.M)}
for a in sorted(set(re.findall(r'\]\(#([^)]+)\)', g))):
    if norm(a) not in heads:
        problems.append('[锚点] goals.md 引用了不存在的小节: #%s' % a)


# ---- 3~4. 决策编号 --------------------------------------------------------
nums = [int(n) for n in re.findall(r'^\|\s*\*{0,2}(\d+)\*{0,2}\s*\|', g, re.M)]
# 决策表在 §二，风险表在 §十，两张表都用数字开头；按位置切开
sec2 = g.split('## 二 · 决策表')[1].split('\n---\n')[0]
dec = [int(n) for n in re.findall(r'^\|\s*\*{0,2}(\d+)\*{0,2}\s*\|', sec2, re.M)]
if dec:
    dup = {n for n in dec if dec.count(n) > 1}
    if dup:
        problems.append('[决策] 编号重复: %s' % sorted(dup))
    missing = [n for n in range(1, max(dec) + 1) if n not in dec]
    if missing:
        problems.append('[决策] 编号不连续，缺: %s' % missing)
    declared = re.search(r'决策表\]\([^)]*\)的\s*(\d+)\s*项', g)
    if declared and int(declared.group(1)) != len(dec):
        problems.append('[决策] §0.4 声明 %s 项，实际 %d 条'
                        % (declared.group(1), len(dec)))
    notes.append('决策 %d 条，最大编号 %d' % (len(dec), max(dec)))

inv = len(re.findall(r'^\|\s*\*\*I\d+\*\*', g, re.M))
notes.append('不变量 %d 条' % inv)


# ---- 5. 风险表条数 --------------------------------------------------------
mrisk = re.search(r'## 十 · 风险(.*?)\n\*\*v17 删掉的五条\*\*', g, re.S)
if mrisk:
    rows = re.findall(r'^\|\s*\*{0,2}[\d]+[b′\']?\*{0,2}\s*\|', mrisk.group(1), re.M)
    said = re.search(r'原来\s*(\d+)\s*条里删了\s*(\d+)\s*条、降级\s*\d+\s*条、加重\s*\d+\s*条、新增\s*(\d+)\s*条', g)
    if said:
        expect = int(said.group(1)) - int(said.group(2)) + int(said.group(3))
        if expect != len(rows):
            problems.append('[风险] §10 声明合计 %d 条，实际 %d 条' % (expect, len(rows)))
    notes.append('风险 %d 条' % len(rows))


# ---- 6. 已推翻的决策在别处被引用 ------------------------------------------
for m in mds():
    if os.path.abspath(m) == os.path.abspath(GOALS):
        continue              # goals.md 里保留原行是纪律要求
    s = read(m)
    for line in s.split('\n'):
        for n, why in OVERTURNED.items():
            if re.search(r'决策\s*%d(?![\d′\'])' % n, line):
                if 'v17' in line or 'v18' in line or '取消' in line or '推翻' in line:
                    continue  # 已经标注过了
                problems.append('[过期引用] %s 引用决策 %d（%s）: %s'
                                % (rel(m), n, why, line.strip()[:70]))


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
