# -*- coding: utf-8 -*-
import io, json, os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DOCS = [
    ('overview',  '总览 · README',           os.path.join(BASE, 'README.md')),
    ('outline',   '产品架构大纲 · 决策后的状态', os.path.join(BASE, r'docs\design\architecture-outline.md')),
    ('roadmap',   '开发计划 · 从零到闸门 F', os.path.join(BASE, r'docs\design\roadmap.md')),
    ('goals',     '产品设计大纲 · goals', os.path.join(BASE, r'docs\design\goals.md')),
    ('ai',        'AI 基础设施规格',          os.path.join(BASE, r'docs\design\ai-native-engine.md')),
    ('adr1',      'ADR-001 · ECS 选型',       os.path.join(BASE, r'docs\design\adr-001-ecs.md')),
    ('adr2',      'ADR-002 · 事件表求值语义', os.path.join(BASE, r'docs\design\adr-002-eventsheet-eval.md')),
    ('ui',        '编辑器 UI 约定',           os.path.join(BASE, r'docs\conventions\ui.md')),
    ('roads',     '道路系统架构（存量参考）',  os.path.join(BASE, r'docs\architecture\roads.md')),
]
SVGS = [
    ('overview', '总览图 · 系统全景 / 数据模型 / 一帧发生什么 / 用户流程 / 编辑器界面 / 能力覆盖面',
     os.path.join(BASE, r'docs\diagrams\overview.svg')),
]

def read(p):
    return io.open(p, encoding='utf-8').read()

docs = [{'id': i, 'title': t, 'md': read(p)} for i, t, p in DOCS]

# SVG 自带 cl- 前缀的样式，与模板 CSS 不冲突，直接内联即可
svgs = []
for i, t, p in SVGS:
    s = read(p)
    s = s[s.index('<svg'):]
    s = s.replace('width="680" height', 'width="100%" data-h')
    svgs.append({'id': i, 'title': t, 'svg': s})

def js(o):
    return json.dumps(o, ensure_ascii=False).replace('</', '<\\/')

tpl = read(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview-template.html'))
html = tpl.replace('__DOCS__', js(docs)).replace('__SVGS__', js(svgs))
out = os.path.join(BASE, 'preview.html')
io.open(out, 'w', encoding='utf-8').write(html)
print('written:', out, len(html), 'chars')
