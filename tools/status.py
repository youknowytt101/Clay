# -*- coding: utf-8 -*-
"""项目进度 —— 从既有真源自动派生，不新增第二个真源。

    python tools/status.py            终端报告
    python tools/status.py --md       另写出 STATUS.md（生成物，勿手改）

设计原则（和这个仓库的其他工具一致）：

  1. **不手工维护进度。** 所有数字来自 goals.md / roadmap.md / ADR 头部 / tests 的标记。
  2. **进度的计数单位是「被自动化验证的判据」**，不是「写完的文档」或「自称完成的包」。
     要让数字变好，必须真写一个跑得过的测试——数字不可伪造。
     这与 ADR-004 §8 一致：没有可重放证据的「已完成」只能算「待验证」。
  3. **不写工期、不算百分比完成度。** goals.md §0.5 第 1 条禁止；
     而且分母（总工作量）本身就是未知的，算出来的百分比是假精度。
"""
import io, os, re, sys, glob, subprocess

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
read = lambda p: io.open(p, encoding='utf-8', errors='replace').read()
D = lambda *a: os.path.join(BASE, *a)

g = read(D('docs', 'design', 'goals.md'))
roadmap = read(D('docs', 'design', 'roadmap.md'))

out = []
def say(s=''):
    out.append(s)
    print(s)

# ── 1. ADR 状态机 ───────────────────────────────────────────────────────────
say('═' * 68)
say('  Clay · 项目进度')
say('═' * 68)
say()
say('【ADR 状态】五档：草案 → 倾向已定 → 已验证 → 已冻结 → 已取代')
say()

STATE_ORDER = ['草案', '倾向已定', '已验证', '已冻结', '已取代']
adr_states = {}
for p in sorted(glob.glob(D('docs', 'design', 'adr-*.md'))):
    name = os.path.basename(p)
    if 'walkthrough' in name:
        continue
    m = re.search(r'\|\s*\*\*状态\*\*\s*\|\s*\*\*(.+?)\*\*', read(p))
    st = m.group(1).strip() if m else '?'
    base = next((s for s in STATE_ORDER if st.startswith(s)), st)
    adr_states[name] = base
    bar = ''.join('●' if STATE_ORDER.index(base) >= i else '○'
                  for i in range(4)) if base in STATE_ORDER else '????'
    say('  %-46s %s  %s' % (name.replace('.md', ''), bar, base))

verified = sum(1 for v in adr_states.values() if v in ('已验证', '已冻结'))
say()
say('  已验证及以上：%d / %d' % (verified, len(adr_states)))

# ── 2. 判据覆盖：谁在被自动化守着 ───────────────────────────────────────────
say()
say('【判据覆盖】只有被测试守着的判据才计入——这是唯一不可伪造的进度')
say()

covers = {}          # 标签 -> [测试名]
test_files = sorted(glob.glob(D('tests', '**', '*.test.mjs'), recursive=True))
for tf in test_files:
    src = read(tf)
    pending = []
    for line in src.split('\n'):
        m = re.search(r'//\s*@covers\s+(.+)', line)
        if m:
            pending = m.group(1).split()
            continue
        t = re.match(r"\s*test\(\s*['\"](.+?)['\"]", line)
        if t and pending:
            for tag in pending:
                covers.setdefault(tag, []).append(t.group(1))
            pending = []

# 不变量 I1–I12
inv_total = len(re.findall(r'^\|\s*\*\*(I\d+)\*\*', g, re.M))
inv_covered = sorted({t for t in covers if re.fullmatch(r'I\d+', t)},
                     key=lambda x: int(x[1:]))
say('  不变量        %2d / %-2d 有测试守着   %s'
    % (len(inv_covered), inv_total, ' '.join(inv_covered) or '（无）'))

other = sorted(t for t in covers if not re.fullmatch(r'I\d+', t))
for t in other:
    say('  %-28s %d 项测试' % (t, len(covers[t])))

# 闸门判据总数（可判定的编号条目）
gates = {}
for gm in re.finditer(r'\*\*闸门 ([A-GO])(?:（(.+?)）)?\*\*', g):
    letter, note = gm.group(1), gm.group(2) or ''
    n = re.search(r'([一二三四五六七八九十两])条', note)
    cn = '一二三四五六七八九十'
    if n:
        ch = n.group(1).replace('两', '二')
        gates.setdefault(letter, cn.index(ch) + 1)
say()
if gates:
    say('  闸门判据条数：' + ' · '.join('%s=%d' % (k, v) for k, v in sorted(gates.items())))
    say('  （闸门要到对应里程碑才判定，此处只登记规模）')

# ── 3. 未决项：按截止里程碑分组，看「下一段之前必须定几件」 ──────────────────
say()
say('【未决项】按风险路由 18–27 关键 / 8–17 受控 / 1–7 可逆')
say()

sec9 = g.split('## 九 · 未决项', 1)[1].split('\n---\n', 1)[0]
active = re.search(r'(.*?)\n\*\*已决并移出\*\*', sec9, re.S).group(1)

items = []
for line in active.split('\n'):
    if not re.match(r'^\|\s*\*\*U-\d{3}\*\*', line):
        continue
    c = [x.strip() for x in line.strip('|').split('|')]
    uid = re.search(r'U-(\d{3})', c[0]).group(1)
    score = re.search(r'=(\d+)', c[3])
    items.append({'id': uid, 'score': int(score.group(1)) if score else 0, 'due': c[4]})

buckets = {'关键': [], '受控': [], '可逆': []}
for it in items:
    k = '关键' if it['score'] >= 18 else ('受控' if it['score'] >= 8 else '可逆')
    buckets[k].append(it)
for k in ('关键', '受控', '可逆'):
    say('  %s  %2d 条   %s' % (k, len(buckets[k]),
        ' '.join('U-' + i['id'] for i in buckets[k][:14]) +
        (' …' if len(buckets[k]) > 14 else '')))

registered_ids = set(re.findall(r'U-(\d{3})', sec9))
active_ids = {it['id'] for it in items}
closed = len(registered_ids - active_ids)
say()
say('  活动 %d 条 · 已关闭 %d 条' % (len(items), closed))

# 下一个里程碑之前的截止项
say()
say('  ── 按截止点前几名（关键档优先）──')
MILES = ['M0', 'M1-a', 'M1-b', 'M1-c', 'M1-g', 'M1', 'M2-2', 'M2-3', 'M2-4', 'M2', 'M3', 'M3.5', 'M4', '闸门']
def due_key(it):
    for i, m in enumerate(MILES):
        if m in it['due']:
            return i
    return len(MILES)
for it in sorted([i for i in items if i['score'] >= 18], key=due_key)[:8]:
    due = re.split(r'\s*·\s*', it['due'])[0][:34]
    say('   U-%s  分数 %2d   截止：%s' % (it['id'], it['score'], due))

# ── 4. 里程碑包 ────────────────────────────────────────────────────────────
say()
say('【里程碑】包清单来自 roadmap.md；验收只认证据，不认自述')
say()

# 一个包算「已验收」有两种证据，都不靠自述：
#   ① 有测试用 @package 标记它；
#   ② 它的验收物是一份 ADR，且该 ADR 已转「已验证」——纸面包没有测试可标，
#      但 ADR 状态机同样是可核验的证据链。
done_by_test = set()
for tf in test_files:
    for m in re.finditer(r'@package\s+([\w.\-]+)', read(tf)):
        done_by_test.add(m.group(1))

adr_ok = {n.replace('.md', '') for n, v in adr_states.items() if v in ('已验证', '已冻结')}
completed_pkgs = set()

def pkg_status(pid, line):
    """返回 (符号, 是否完成)。"""
    if pid in done_by_test:
        return '✔', True
    for a in re.findall(r'adr-\d{3}[\w\-]*', line):
        if a in adr_ok:
            return '◆', True          # 纸面包：由 ADR 状态背书
    return '·', False

for mm in re.finditer(r'^##\s+(M[\d.]+)([^\n]*)', roadmap, re.M):
    mid, rest = mm.group(1), mm.group(2)
    seg = roadmap[mm.end():]
    nxt = re.search(r'^##\s', seg, re.M)
    seg = seg[:nxt.start()] if nxt else seg

    # 只收属于本里程碑的包（M1 段落里会引用 M0-b 作依赖，不能算进 M1）
    found = {}
    for line in seg.split('\n'):
        for pid in re.findall(r'(%s-[a-z\d])' % re.escape(mid), line):
            found.setdefault(pid, line)
    # M2 的子段用 ### M2-N 编号，没有字母包 id
    for hm in re.finditer(r'^###\s+(%s-\d)' % re.escape(mid), seg, re.M):
        found.setdefault(hm.group(1), '')
    if not found:
        continue

    pkgs = sorted(found)
    syms = [pkg_status(p, found[p]) for p in pkgs]
    done = sum(1 for _, ok in syms if ok)
    for pid, (_sym, ok) in zip(pkgs, syms):
        if ok:
            completed_pkgs.add(pid)
    say('  %-30s %s  (%d/%d)'
        % ((mid + rest).split('（')[0].strip()[:30],
           ''.join(s for s, _ in syms), done, len(pkgs)))

say()
say('  ✔ 有测试守着   ◆ 由已验证的 ADR 背书（纸面包）   · 未验收')

# ── 4b. 截止点已过但仍活动的未决项 ─────────────────────────────────────────
# 未决项的价值全在「再不定就要返工的那个时刻」。若截止里程碑已经验收而该项还开着，
# 它就已经失去路由作用——而按截止点排序只显示关键档，受控/可逆档会**悄悄过期**。
# 这条是踩出来的：U-024 截止点写着 M1-g，M1-g 交付后它仍活动，没有任何提示。
overdue = []
for it in items:
    # 只看截止点本身（· 之前）里的**第一个**里程碑：
    # 后面常跟「（原 M1-g，已延期）」这类历史说明，扫全文会误报。
    head = re.split(r'\s*·\s*', it['due'])[0]
    head = re.sub(r'（[^）]*）|\([^)]*\)', '', head)   # 去掉「（原 M1-g，已延期）」这类括注
    first = re.search(r'M[\d.]+-[a-z\d]', head)
    if first and first.group(0) in completed_pkgs:
        overdue.append((it, first.group(0)))

say()
if overdue:
    say('【截止点已过】里程碑已验收，但这些未决项仍活动——要么关闭，要么显式延期')
    say()
    for it, pid in sorted(overdue, key=lambda x: -x[0]['score']):
        say('  U-%s  分数 %2d   截止里程碑 %s 已验收' % (it['id'], it['score'], pid))
else:
    say('【截止点】没有已过期仍活动的未决项 ✓')

# ── 5. 测试与校验实际跑一遍 ────────────────────────────────────────────────
say()
say('【实测】数字来自真跑，不是自述')
say()

def run(cmd):
    try:
        r = subprocess.run(cmd, cwd=BASE, capture_output=True, text=True,
                           shell=True, timeout=300, errors='replace')
        return r.returncode, (r.stdout or '') + (r.stderr or '')
    except Exception as e:
        return -1, str(e)

rc, o = run('npm test')
m_pass = re.search(r'^. pass (\d+)', o, re.M)
m_fail = re.search(r'^. fail (\d+)', o, re.M)
say('  npm test            %s  通过 %s · 失败 %s'
    % ('通过' if rc == 0 else '失败 ←',
       m_pass.group(1) if m_pass else '?', m_fail.group(1) if m_fail else '?'))

rc2, o2 = run('python tools/check-docs.py')
nd = re.search(r'检查了 (\d+) 份文档', o2)
say('  check-docs.py       %s  %s 份文档'
    % ('通过' if rc2 == 0 else '失败 ←', nd.group(1) if nd else '?'))

code_lines = 0
for pat in ('src/**/*.js', 'tests/**/*.mjs', 'tools/spikes/*.mjs'):
    for f in glob.glob(D(*pat.split('/')), recursive=True):
        code_lines += len(read(f).split('\n'))
doc_lines = sum(len(read(f).split('\n')) for f in glob.glob(D('docs', 'design', '*.md')))
say('  代码 %d 行 · 设计文档 %d 行' % (code_lines, doc_lines))

say()
say('═' * 68)

if '--md' in sys.argv:
    body = '\n'.join(out)
    io.open(D('STATUS.md'), 'w', encoding='utf-8', newline='\n').write(
        '# 项目进度\n\n> **生成物，勿手改。** `python tools/status.py --md` 重新生成。\n'
        '> 数据全部派生自 goals.md / roadmap.md / ADR 头部 / tests 标记 / 真跑结果。\n\n'
        '```\n' + body + '\n```\n')
    print('\nwritten: STATUS.md')

sys.exit(0 if (rc == 0 and rc2 == 0) else 1)
