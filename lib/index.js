/**
 * dsh-plugin-product-manual — 产品功能手册生成器（宿主端正式插件）
 *
 * 这是一个 Cordis 插件行（供 agent preset 的 agent.cordis.yml 引用）：
 *  - 注册 7 个 manual_* 工具（访谈 / 章节读写 / 同类产品检索 / 一页纸 / 反馈 / 状态 / 渲染）
 *  - 注册一段「产品访谈员」系统提示协议（150 号段）
 *  - 注册一个按实例隔离的 PDF 服务路由（/product-manuals-<rand>/<manualId>/<文件名>）
 *
 * 设计约束：
 *  - 零外部 import：只用 ctx 与内建能力，避免宿主端解析依赖问题；
 *  - 工具定义手写 ToolDefinition（parameters 用标准 JSON Schema），不依赖 defineTool；
 *  - 每个插件实例使用独立的 URL 前缀，多个会话同时挂载不冲突。
 */

import { spawn } from 'node:child_process'

const SECTIONS = [
  { key: 'productSummary', title: '一、产品定位与一句话描述', hint: '给谁用、解决什么痛点、和现有做法相比好在哪', question: '用一句话说说这个产品：给谁用、解决他们什么麻烦？' },
  { key: 'audience', title: '二、目标用户', hint: '用户是谁、水平如何、在什么环境里用', question: '谁会用它？他们的角色、使用水平和使用环境是怎样的？' },
  { key: 'scenarios', title: '三、典型使用场景', hint: '什么情况下打开它、从头到尾怎么完成一件事', question: '能举一个具体例子吗：什么情况下打开它、从头到尾怎么用？' },
  { key: 'features', title: '四、功能清单', hint: '按 P0/P1/P2 排优先级的功能条目表', question: '最核心的三件事是什么？其他想要的功能按重要程度排个序？' },
  { key: 'details', title: '五、功能需求详述', hint: '每个核心功能的输入、操作、输出、边界与验收标准', question: '挑一个最重要的功能拆细：输入什么、点哪里、看到什么结果、什么情况算成功？' },
  { key: 'nonFunctional', title: '六、非功能要求', hint: '用户视角的速度、隐私、稳定性、可用性期待', question: '对速度和稳定性有什么要求？用户最不能忍受的体验问题是什么？' },
  { key: 'outOfScope', title: '七、明确不做的事', hint: '这一版先不做什么，避免范围蔓延', question: '这一版明确不做什么？哪些想法先放一放？' },
  { key: 'techRoute', title: '八、技术路线', hint: '由功能需求倒推的技术实现路线与取舍', question: '基于以上功能，哪些是技术上的硬要求（数据量、实时性、离线、安全、成本、团队规模）？' }
]

const DIR = 'product-manuals'
/** Per-instance route prefix so several sessions can mount this row without colliding. */
const ROUTE = '/product-manuals-' + Math.random().toString(36).slice(2, 8)

const PROMPT_TEXT = [
  '## 产品功能手册（manual_* 工具）',
  '',
  '当用户想把一个模糊的想法变成可以开发的产品，或想写产品功能手册 / 需求文档时，用这套工具。你的角色是产品访谈员：通过多轮对话，把用户口头的、碎片化的、不精确的描述，整理成结构化的功能需求，最终生成 Markdown 手册和 PDF。',
  '',
  '访谈规则：',
  '1. 每轮只问 1-2 个问题。先复述、确认用户上一轮说的，再问下一个。用日常语言，不堆术语。',
  '2. 永远问用户视角的功能：谁用、什么场景、要完成什么、输入什么、看到什么结果、怎样算成功或失败。不要主动询问技术栈、框架、数据库、云服务或部署方式。',
  '3. 能用 2-4 个具体选项覆盖的问题，优先用 ask_user_question 工具让用户直接点选（单选或多选），而不是让用户打字回答；只有开放式问题才用文字提问。用户说“随便 / 都行 / 你定”时，也必须给出具体选项帮其选择。',
  '4. 每个功能至少澄清：触发场景、输入、核心操作、输出结果、边界与异常、验收标准。',
  '5. 没问到的不编造，宁可留空，让用户下一轮补充。',
  '6. 章节内部的小标题一律用三级标题（### 开头），不要用二级（##）——二级标题是章级，生成时会自动把章内 ## 降为 ###。',
  '',
  '工具与流程：',
  '- 先 manual_start 记录产品名与定位。',
  '- 每轮访谈结束调用 manual_update，把本轮确认的内容写进对应章节（Markdown）。',
  '- 用户描述模糊、或某个功能拿不准要不要做时，先调用 manual_research 看看别人怎么做（可反复调用、可换角度：github 开源项目 / wechat 小程序案例 / zhihu 产品讨论 / web）。把“别人怎么做”讲成 2-3 个具体例子给用户看，再用 ask_user_question 让用户选；研究结论用 note 记下，会进入附录“参考案例”。',
  '- 用 manual_status 查看还缺什么、下一问什么。',
  '- 访谈完成后调用 manual_render 生成 Markdown 与 PDF（PDF 文件名直接就是产品名，如“中学校友小程序.pdf”），把 pdfUrl 链接和文件路径告诉用户；之后用户可以继续迭代，改动后再调用一次 manual_update + manual_render。',
  '- 用户想要“一页纸 / 截图转发 / 给领导朋友看”的简介时，调用 manual_onepager 生成单页 PDF：只讲主要功能亮点，文案正向、大白话、不要写限制 / 异常 / 技术细节。可用 highlights 给 3-6 个亮点、steps 给 2-4 步上手流程，把一页纸写满。',
  '- 用户看完 PDF 提出改进意见时，先调用 manual_feedback 记录（可多条），再据此更新对应章节或一页纸文案，然后重新生成。',
  '',
  '章节结构：productSummary 产品定位 / audience 目标用户 / scenarios 典型使用场景 / features 功能清单（P0/P1/P2 表）/ details 功能需求详述 / nonFunctional 非功能要求 / outOfScope 明确不做的事 / techRoute 技术路线。研究得到的参考产品进“附录”，不占前七章。',
  '',
  '顺序要求：前七章只写用户视角的功能与验收口径，不出现技术选型。最后一章 techRoute 才写技术路线，并且必须从前面的功能需求倒推——先提炼功能对技术的硬要求（数据量、实时性、离线、安全、成本、团队规模），再给出技术路线、为什么选它、以及替代方案的取舍。技术是功能的下游，不能反过来用技术限制功能。'
].join('\n')

/* ────────────────────────── 小工具函数 ────────────────────────── */

function slugify(name) {
  let s = String(name == null ? '' : name).toLowerCase()
  s = s.replace(/[^a-z0-9]+/g, '-')
  s = s.replace(/^-+|-+$/g, '')
  if (s === '') s = 'manual-' + Date.now()
  if (s.length > 48) s = s.slice(0, 48)
  return s
}

function baseNameOf(state) {
  let s = String(state && state.title ? state.title : '产品功能手册').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) s = '产品功能手册'
  if (s.length > 40) s = s.slice(0, 40)
  return s
}

function nowText() {
  try { return new Date().toLocaleString('zh-CN', { hour12: false }) } catch (e) { return new Date().toISOString() }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inlineMd(text) {
  let t = escapeHtml(text)
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
  return t
}

function mdToHtml(md) {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n')
  const out = []
  const isSep = (l) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.indexOf('-') >= 0
  const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim()
      const buf = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i += 1 }
      i += 1
      out.push('<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' + escapeHtml(buf.join('\n')) + '</code></pre>')
      continue
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      out.push('<h' + level + '>' + inlineMd(h[2]) + '</h' + level + '>')
      i += 1
      continue
    }
    if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i += 1; continue }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i += 1 }
      let t = '<table><thead><tr>' + head.map((c) => '<th>' + inlineMd(c) + '</th>').join('') + '</tr></thead><tbody>'
      for (const r of rows) t += '<tr>' + r.map((c) => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>'
      out.push(t + '</tbody></table>')
      continue
    }
    if (/^\s*>/.test(line)) {
      const buf = []
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1 }
      out.push('<blockquote>' + inlineMd(buf.join(' ')) + '</blockquote>')
      continue
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items = []
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
        if (m) items.push(m[2])
        i += 1
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push('<' + tag + '>' + items.map((it) => '<li>' + inlineMd(it) + '</li>').join('') + '</' + tag + '>')
      continue
    }
    if (line.trim() === '') { i += 1; continue }
    const buf = []
    while (i < lines.length && lines[i].trim() !== '' && !/^\s*(#{1,6}\s|```|\||>|[-*+]\s|\d+[.)]\s|(\*{3,}|-{3,})\s*$)/.test(lines[i])) {
      buf.push(lines[i])
      i += 1
    }
    if (buf.length === 0) { i += 1; continue }
    out.push('<p>' + inlineMd(buf.join(' ')) + '</p>')
  }
  return out.join('\n')
}

const PRINT_CSS = [
  '@page { size: A4; margin: 22mm 18mm; }',
  'body { font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "SimSun", sans-serif; font-size: 10.5pt; line-height: 1.75; color: #1f2328; }',
  'article { max-width: 190mm; margin: 0 auto; }',
  'h1 { font-size: 20pt; text-align: center; border-bottom: 2px solid #1f2328; padding-bottom: 8pt; margin: 0 0 8pt; }',
  'h2 { font-size: 14pt; margin: 18pt 0 8pt; padding-left: 6pt; border-left: 4px solid #2f6fde; page-break-after: avoid; }',
  'h3 { font-size: 12pt; margin: 12pt 0 6pt; page-break-after: avoid; }',
  'p, li { margin: 4pt 0; }',
  'table { width: 100%; border-collapse: collapse; margin: 8pt 0; font-size: 9.5pt; page-break-inside: avoid; }',
  'th, td { border: 1px solid #c9ced6; padding: 4pt 6pt; text-align: left; vertical-align: top; }',
  'th { background: #eef2f8; font-weight: 600; }',
  'blockquote { margin: 8pt 0; padding: 6pt 10pt; background: #f6f8fa; border-left: 3px solid #b6c2d2; color: #4a5563; }',
  'code { font-family: Consolas, "Courier New", monospace; font-size: 9pt; background: #f2f4f7; padding: 0 3pt; border-radius: 2px; }',
  'pre { background: #f6f8fa; border: 1px solid #e3e7ee; padding: 8pt 10pt; overflow: auto; page-break-inside: avoid; }',
  'pre code { background: none; padding: 0; }',
  'hr { border: none; border-top: 1px solid #d7dbe2; margin: 12pt 0; }',
  'ul, ol { padding-left: 18pt; }',
  'a { color: #2f6fde; text-decoration: none; }'
].join('\n')

function htmlDocument(title, body) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title><style>' + PRINT_CSS + '</style></head><body><article>' + body + '</article></body></html>'
}

const ONEPAGER_CSS = [
  '@page { size: A4; margin: 0; }',
  '* { box-sizing: border-box; }',
  'html, body { margin: 0; padding: 0; }',
  'body { font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif; color: #1f2328; -webkit-print-color-adjust: exact; }',
  '.sheet { width: 210mm; height: 297mm; padding: 12mm 13mm; display: flex; flex-direction: column; gap: 4.5mm; overflow: hidden; position: relative; }',
  '.sheet::before { content: ""; position: absolute; right: -36mm; top: -36mm; width: 132mm; height: 132mm; border-radius: 50%; background: radial-gradient(circle, #e6eefc 0%, rgba(230,238,252,0) 68%); z-index: 0; }',
  '.band { position: relative; z-index: 1; display: flex; justify-content: space-between; align-items: flex-start; border-left: 6px solid #2f6fde; padding: 1mm 0 1mm 6mm; }',
  '.deco { flex: none; margin-top: 0.5mm; }',
  '.name { font-size: 27pt; font-weight: 700; letter-spacing: 1px; line-height: 1.15; }',
  '.tag { font-size: 12pt; color: #4a5563; margin-top: 2.5mm; line-height: 1.5; }',
  '.sec { position: relative; z-index: 1; font-size: 9pt; font-weight: 700; color: #2f6fde; letter-spacing: 3px; border-bottom: 1.5px solid #dbe4f3; padding-bottom: 1.5mm; margin: 0.5mm 0 -1mm; }',
  '.grid { position: relative; z-index: 1; flex: 1 1 auto; display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: 1fr; gap: 4mm; }',
  '.card { display: flex; flex-direction: column; background: #f4f7fd; border: 1px solid #dbe4f3; border-radius: 3mm; padding: 4.5mm 5mm; }',
  '.chead { display: flex; justify-content: space-between; align-items: center; }',
  '.num { width: 6.5mm; height: 6.5mm; border-radius: 50%; background: #2f6fde; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 9.5pt; flex: none; }',
  '.ic { font-size: 17pt; line-height: 1; }',
  '.ct { font-size: 12.5pt; font-weight: 600; margin-top: 2mm; line-height: 1.3; }',
  '.cd { font-size: 10pt; color: #4a5563; margin-top: 1.5mm; line-height: 1.55; }',
  '.steps { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 3.5mm; }',
  '.step { background: #eef3fb; border-radius: 3mm; padding: 3mm 4mm; }',
  '.sn { font-size: 12pt; font-weight: 700; color: #2f6fde; line-height: 1.3; }',
  '.sd { font-size: 9pt; color: #2f4f7a; margin-top: 1mm; line-height: 1.45; }',
  '.who { position: relative; z-index: 1; font-size: 10pt; color: #2f4f7a; background: #eef3fb; border-radius: 3mm; padding: 3mm 4.5mm; line-height: 1.55; }',
  '.wl { font-weight: 700; margin-right: 3mm; }',
  '.foot { position: relative; z-index: 1; text-align: right; font-size: 8pt; color: #8a94a3; margin-top: auto; }'
].join('\n')

const DECO_SVG = '<svg class="deco" width="64" height="64" viewBox="0 0 64 64" fill="none"><circle cx="46" cy="18" r="15" fill="#2f6fde" fill-opacity="0.10"/><circle cx="22" cy="44" r="11" fill="#2f6fde" fill-opacity="0.16"/><circle cx="52" cy="50" r="6" fill="#2f6fde" fill-opacity="0.30"/><circle cx="10" cy="14" r="4" fill="#2f6fde" fill-opacity="0.22"/></svg>'

function iconFor(title) {
  const t = String(title == null ? '' : title)
  const rules = [
    [/找|搜|查找|同学/, '🔍'],
    [/联系|隐私|申请|体面/, '🔒'],
    [/求助|内推|岗位|互助|帮/, '🤝'],
    [/活动|报名|聚会|讲座|球赛/, '📅'],
    [/提醒|通知|消息/, '🔔'],
    [/可信|举报|拉黑|安全|干净/, '🛡️'],
    [/注册|邀请|加入/, '✉️'],
    [/聊|私信|沟通/, '💬'],
    [/统计|数据|报表|汇总/, '📊'],
    [/照片|图片|上传/, '🖼️']
  ]
  for (const r of rules) if (r[0].test(t)) return r[1]
  return '✨'
}

function stripMd(text) {
  return String(text == null ? '' : text)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseFeatures(state) {
  const text = state && state.sections ? state.sections.features : ''
  if (!text) return []
  const rows = []
  for (const line of String(text).split('\n')) {
    if (!/^\s*\|/.test(line)) continue
    const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => stripMd(c))
    if (cells.length < 3) continue
    const p = cells[0].trim().toUpperCase()
    if (p !== 'P0' && p !== 'P1' && p !== 'P2') continue
    rows.push({ p, title: cells[1].trim(), desc: cells[2].trim() })
  }
  rows.sort((a, b) => {
    const rank = (x) => (x === 'P0' ? 0 : x === 'P1' ? 1 : 2)
    return rank(a.p) - rank(b.p)
  })
  return rows
}

function deriveOnepager(state) {
  const summary = stripMd(state.sections && state.sections.productSummary || '')
  const tagline = summary.length > 56 ? summary.slice(0, 56) + '…' : summary
  const feats = parseFeatures(state)
  const highlights = []
  for (const f of feats) {
    if (highlights.length >= 6) break
    highlights.push({ title: f.title, desc: f.desc.replace(/^[：:]\s*/, '') })
  }
  const who = stripMd(state.sections && state.sections.audience || '')
  return {
    headline: String(state.title || '产品'),
    tagline: tagline || '一句话说清这个产品',
    highlights,
    steps: [],
    who: who.length > 90 ? who.slice(0, 90) + '…' : who
  }
}

function onepagerHtml(state, content) {
  const c = content || {}
  const name = escapeHtml(c.headline || state.title || '产品')
  const tag = escapeHtml(c.tagline || '')
  const who = escapeHtml(c.who || '')
  const hl = Array.isArray(c.highlights) ? c.highlights.slice(0, 6) : []
  const steps = Array.isArray(c.steps) ? c.steps.slice(0, 4) : []
  const cards = hl.map((h, i) => {
    const icon = h && typeof h === 'object' ? (h.icon || iconFor(h.title)) : '✨'
    const title = h && typeof h === 'object' ? (h.title || '') : ''
    const desc = h && typeof h === 'object' ? (h.desc || '') : ''
    return '<div class="card"><div class="chead"><span class="num">' + String(i + 1) + '</span><span class="ic">' + escapeHtml(icon) + '</span></div><div class="ct">' + escapeHtml(title) + '</div><div class="cd">' + escapeHtml(desc) + '</div></div>'
  }).join('')
  const stepHtml = steps.map((s, i) => {
    const parts = String(s).split(/[：:]/)
    const t = parts.length > 1 ? parts[0] : ('第' + String(i + 1) + '步')
    const d = parts.length > 1 ? parts.slice(1).join('：') : String(s)
    return '<div class="step"><div class="sn">' + escapeHtml(t) + '</div><div class="sd">' + escapeHtml(d) + '</div></div>'
  }).join('')
  const parts = [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + name + '</title><style>' + ONEPAGER_CSS + '</style></head><body><div class="sheet">',
    '<div class="band"><div><div class="name">' + name + '</div>' + (tag ? '<div class="tag">' + tag + '</div>' : '') + '</div>' + DECO_SVG + '</div>',
    hl.length ? '<div class="sec">亮点功能</div><div class="grid">' + cards + '</div>' : '',
    stepHtml ? '<div class="sec">三步上手</div><div class="steps">' + stepHtml + '</div>' : '',
    who ? '<div class="who"><span class="wl">适合谁</span>' + who + '</div>' : '',
    '<div class="foot">给读者的一页纸 · 完整内容见产品功能手册</div>',
    '</div></body></html>'
  ]
  return parts.join('')
}

function hasText(state, key) {
  const v = state && state.sections ? state.sections[key] : undefined
  return typeof v === 'string' && v.trim() !== ''
}

function demoteHeadings(text) {
  return String(text == null ? '' : text).split('\n').map((line) => /^#{1,2}\s+/.test(line) ? '### ' + line.replace(/^#{1,2}\s+/, '') : line).join('\n')
}

function composeMarkdown(state) {
  const lines = []
  lines.push('# ' + (state.title || '产品功能手册'))
  lines.push('')
  lines.push('> 本手册通过多轮对话整理生成 · 更新于 ' + (state.updatedAt || nowText()))
  lines.push('')
  lines.push('## 阅读说明')
  lines.push('')
  lines.push('- 第一至第七章只描述用户视角的功能需求与验收口径，不涉及技术选型。')
  lines.push('- 第八章“技术路线”由前面的功能需求倒推，说明为什么这些功能需要相应技术，以及替代方案的取舍。')
  lines.push('- 标注“待补充”的章节表示尚未确认，可在对话中继续补充后重新生成。')
  lines.push('')
  for (const s of SECTIONS) {
    lines.push('## ' + s.title)
    lines.push('')
    if (hasText(state, s.key)) lines.push(demoteHeadings(String(state.sections[s.key]).trim()))
    else lines.push('> 待补充：' + s.hint + '。')
    lines.push('')
  }
  const refs = Array.isArray(state.references) ? state.references : []
  if (refs.length > 0) {
    lines.push('## 附录：参考案例（启发清单）')
    lines.push('')
    lines.push('下面是访谈过程中检索到的同类产品 / 开源项目 / 讨论，用来解释“别人为什么这样做”，帮助确认功能取舍。')
    lines.push('')
    const groups = {}
    const order = []
    for (const r of refs) {
      if (!r || !r.url) continue
      const noteText = r.note && String(r.note).trim() ? String(r.note).trim() : (r.query || '检索结果')
      if (!groups[noteText]) { groups[noteText] = []; order.push(noteText) }
      groups[noteText].push(r)
    }
    for (const key of order) {
      lines.push('### ' + key)
      lines.push('')
      for (const r of groups[key]) {
        const t = r.title || r.url
        const sn = r.snippet ? ' — ' + r.snippet : ''
        lines.push('- [' + t + '](' + r.url + ')' + sn)
      }
      lines.push('')
    }
  }
  const fbs = Array.isArray(state.feedback) ? state.feedback : []
  if (fbs.length > 0) {
    lines.push('## 附录：改进意见（待处理）')
    lines.push('')
    lines.push('读者看过当前版本后的修改意见，后续迭代按这些意见更新。')
    lines.push('')
    for (const f of fbs) lines.push('- ' + String(f.text || '') + (f.at ? '（' + String(f.at) + '）' : ''))
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push('> 本文档由“产品功能手册”插件生成：功能需求决定技术，而不是相反。')
  return lines.join('\n')
}

/** Model-facing text for one canonical tool value. */
function textOf(v) {
  if (!v || typeof v !== 'object') return String(v)
  const lines = []
  if (v.message) lines.push(String(v.message))
  if (typeof v.filledCount === 'number' && typeof v.totalSections === 'number') lines.push('进度：' + v.filledCount + '/' + v.totalSections + ' 章')
  if (Array.isArray(v.missing) && v.missing.length) lines.push('缺失章节：' + v.missing.join('、'))
  if (v.nextQuestion) lines.push('建议下一问：' + v.nextQuestion)
  if (typeof v.referenceCount === 'number' && v.referenceCount > 0) lines.push('参考案例：' + v.referenceCount + ' 条')
  if (typeof v.feedbackCount === 'number' && v.feedbackCount > 0) lines.push('改进意见：' + v.feedbackCount + ' 条')
  if (Array.isArray(v.feedbackLatest) && v.feedbackLatest.length) lines.push('最新意见：' + v.feedbackLatest.join('；'))
  if (v.pdfUrl) lines.push('PDF 链接：' + v.pdfUrl)
  if (v.onepagerUrl) lines.push('一页纸链接：' + v.onepagerUrl)
  if (Array.isArray(v.warnings) && v.warnings.length) lines.push('提示：' + v.warnings.join('；'))
  if (Array.isArray(v.results) && v.results.length) {
    lines.push('检索结果：')
    for (const r of v.results) lines.push('- ' + (r.title || r.url) + ' ' + r.url + (r.snippet ? '：' + String(r.snippet).slice(0, 160) : ''))
  }
  if (Array.isArray(v.notes) && v.notes.length) lines.push('摘要：' + v.notes.join(' '))
  if (lines.length === 0) {
    try { return JSON.stringify(v) } catch (e) { return String(v) }
  }
  return lines.join('\n')
}

/**
 * Build a registry-ready ToolDefinition without defineTool: the runtime needs
 * `output.render` and a supported JSON Schema for `output.schema`; arguments are
 * validated by this plugin itself.
 */
function makeTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    ...(typeof definition.timeoutMs === 'number' ? { timeoutMs: definition.timeoutMs } : {}),
    output: {
      schema: {},
      render: (args, value) => [{ type: 'text', text: textOf(value) }]
    },
    execute: definition.execute
  }
}

/* ────────────────────────── 插件本体 ────────────────────────── */

/** Cordis plugin name (loader display + diagnostics). */
export const name = 'product-manual'

/** `tools` is required; everything else is resolved lazily so the row also loads in minimal compositions. */
export const inject = ['tools']

export function apply(ctx) {
  const tools = ctx.get('tools')
  let fs = ctx.get('fs')
  let subprocess = ctx.get('subprocess')
  let sandboxPolicy = ctx.get('sandboxPolicy')
  let systemPrompt = ctx.get('systemPrompt')
  let webServer = ctx.get('webServer')
  let timer = ctx.get('timer')
  let web = ctx.get('web')

  /** 宿主组合装载顺序不确定：服务可能晚于本行就绪，执行时重新解析。 */
  function ensureServices() {
    if (fs === undefined) fs = ctx.get('fs')
    if (subprocess === undefined) subprocess = ctx.get('subprocess')
    if (sandboxPolicy === undefined) sandboxPolicy = ctx.get('sandboxPolicy')
    if (webServer === undefined) webServer = ctx.get('webServer')
    if (timer === undefined) timer = ctx.get('timer')
    if (web === undefined) web = ctx.get('web')
  }

  let lastManualId = ''
  let lastRoot = ''
  const knownDirs = {}

  function requireFs() {
    ensureServices()
    if (fs === undefined) throw new Error('文件系统服务 fs 不可用，无法读写手册文件')
  }

  function policyFrom(session) {
    ensureServices()
    if (sandboxPolicy === undefined) return undefined
    try { return session ? sandboxPolicy.resolve({ session }) : sandboxPolicy.resolve() } catch (e) { return undefined }
  }

  function rootFrom(policy) {
    if (policy && policy.workspaceRoot) return String(policy.workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '')
    return lastRoot
  }

  function dirOf(root, id) { return root + '/' + DIR + '/' + id }
  function statePathOf(root, id) { return dirOf(root, id) + '/state.json' }

  async function readJson(abs) {
    try {
      const target = await fs.resolve(abs)
      const info = await fs.stat(target)
      if (!info) return null
      return JSON.parse(await fs.readText(target))
    } catch (e) { return null }
  }

  async function writeTextFile(abs, text, signal, policy) {
    const target = await fs.resolve(abs, policy && policy.workspaceRoot ? { cwd: policy.workspaceRoot } : undefined)
    return await fs.writeText(target, text, undefined, signal, policy)
  }

  async function writeJson(abs, data, signal, policy) {
    return await writeTextFile(abs, JSON.stringify(data, null, 2), signal, policy)
  }

  async function writePointer(root, id, signal, policy) {
    try { await writeJson(root + '/' + DIR + '/.current.json', { id, ts: Date.now(), at: nowText() }, signal, policy) } catch (e) {}
  }

  async function listManualIds(root) {
    const out = []
    if (!root) return out
    try {
      const target = await fs.resolve(root + '/' + DIR)
      const info = await fs.stat(target)
      if (!info) return out
      const entries = await fs.listDir(target)
      for (const e of entries) {
        if (!e || typeof e.name !== 'string' || e.name.charAt(0) === '.') continue
        const st = await readJson(root + '/' + DIR + '/' + e.name + '/state.json')
        if (st) out.push(e.name)
      }
    } catch (e) {}
    return out
  }

  async function resolveCurrent(policy) {
    const root = rootFrom(policy)
    if (!root) return { root: '', id: '' }
    if (lastManualId) {
      const st = await readJson(statePathOf(root, lastManualId))
      if (st) return { root, id: lastManualId }
      lastManualId = ''
    }
    try {
      const ptr = await readJson(root + '/' + DIR + '/.current.json')
      if (ptr && ptr.id) {
        const st = await readJson(statePathOf(root, String(ptr.id)))
        if (st) { lastManualId = String(ptr.id); lastRoot = root; return { root, id: String(ptr.id) } }
      }
    } catch (e) {}
    try {
      const target = await fs.resolve(root + '/' + DIR)
      const info = await fs.stat(target)
      if (info) {
        const entries = await fs.listDir(target)
        let best = ''
        let bestTs = -1
        for (const e of entries) {
          if (!e || typeof e.name !== 'string' || e.name.charAt(0) === '.') continue
          const st = await readJson(root + '/' + DIR + '/' + e.name + '/state.json')
          if (!st) continue
          const ts = typeof st.ts === 'number' ? st.ts : 0
          if (ts > bestTs) { bestTs = ts; best = e.name }
        }
        if (best) { lastManualId = best; lastRoot = root; return { root, id: best } }
      }
    } catch (e) {}
    return { root, id: '' }
  }

  function emptySections() {
    return SECTIONS.map((s) => ({ key: s.key, title: s.title, filled: false, chars: 0 }))
  }

  function statusOf(state, id, root) {
    const filled = {}
    for (const s of SECTIONS) filled[s.key] = hasText(state, s.key)
    const filledKeys = SECTIONS.filter((s) => filled[s.key]).map((s) => s.key)
    const missingKeys = SECTIONS.filter((s) => !filled[s.key]).map((s) => s.key)
    const first = SECTIONS.find((s) => !filled[s.key])
    return {
      ok: true,
      hasState: true,
      manualId: id,
      title: state.title || id,
      dir: dirOf(root, id),
      sections: SECTIONS.map((s) => ({ key: s.key, title: s.title, filled: filled[s.key], chars: filled[s.key] ? String(state.sections[s.key]).length : 0 })),
      filled: filledKeys,
      missing: missingKeys,
      filledCount: filledKeys.length,
      totalSections: SECTIONS.length,
      nextQuestion: first ? first.question : '',
      nextSection: first ? first.key : '',
      ready: missingKeys.length === 0,
      referenceCount: Array.isArray(state.references) ? state.references.length : 0,
      feedbackCount: Array.isArray(state.feedback) ? state.feedback.length : 0,
      feedbackLatest: Array.isArray(state.feedback) ? state.feedback.slice(-3).map((f) => String(f.text || '')) : [],
      updatedAt: state.updatedAt || '',
      render: state.render || null
    }
  }

  function emptyStatus(extra) {
    const base = { ok: true, hasState: false, totalSections: SECTIONS.length, filledCount: 0, sections: emptySections(), missing: SECTIONS.map((s) => s.key), nextQuestion: SECTIONS[0].question, referenceCount: 0, feedbackCount: 0 }
    return Object.assign(base, extra || {})
  }

  async function findBrowser() {
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}
    const override = env.DSH_PDF_BROWSER || env.DSH_CHROME || env.CHROME_PATH || ''
    const cands = []
    if (override) cands.push(override)
    cands.push(
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    )
    for (const c of cands) {
      try {
        const target = await fs.resolve(c)
        const info = await fs.stat(target)
        if (info) return fs.processPath(target)
      } catch (e) {}
    }
    // PATH 兜底：msedge / chrome / chromium
    if (subprocess !== undefined) {
      for (const exe of ['msedge', 'chrome', 'chromium', 'google-chrome']) {
        try {
          const found = await subprocess.resolveExecutable(exe)
          if (found) return found
        } catch (e) {}
      }
    }
    return ''
  }

  /** GitHub 内置检索：无需任何宿主服务，keyless（可选 GITHUB_TOKEN 提额）。 */
  async function githubSearch(query, limit, signal) {
    if (typeof fetch !== 'function') throw new Error('当前运行环境没有 fetch')
    const per = Math.max(1, Math.min(10, limit))
    const url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(query) + '&per_page=' + per + '&sort=stars'
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-product-manual' }
    try {
      const env = (typeof process !== 'undefined' && process.env) ? process.env : {}
      if (env.GITHUB_TOKEN) headers.authorization = 'Bearer ' + env.GITHUB_TOKEN
    } catch (e) {}
    const res = await fetch(url, { headers, signal })
    if (!res.ok) throw new Error('GitHub API HTTP ' + res.status)
    const data = await res.json()
    return (Array.isArray(data.items) ? data.items : []).map((it) => ({
      url: String(it.html_url || ''),
      title: String(it.full_name || it.name || ''),
      snippet: String(it.description || '')
    }))
  }

  /** 启动一次浏览器进程：优先用宿主 subprocess 服务，缺失时退回 node:child_process。 */
  async function runBrowser(argv, cwd) {
    if (subprocess !== undefined) {
      const handle = subprocess.spawn({ argv, cwd, stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 16384 } }, graceMs: 4000 })
      let race
      try {
        race = timer !== undefined
          ? await Promise.race([handle.done.then((v) => ({ t: 'exit', v })), timer.timeout(45000).then(() => ({ t: 'timeout' }))])
          : await handle.done.then((v) => ({ t: 'exit', v }))
      } catch (e) {
        return { ok: false, detail: '进程失败：' + (e && e.message ? e.message : String(e)) }
      }
      if (race.t === 'timeout') {
        try { handle.terminate() } catch (e) {}
        return { ok: false, detail: '打印超时（45s）' }
      }
      const errText = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
      const outText = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
      return { ok: true, exitCode: race.v && race.v.exitCode, outText, errText }
    }
    return await new Promise((resolve) => {
      let out = ''
      let child
      try {
        child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) {
        resolve({ ok: false, detail: 'spawn 失败：' + (e && e.message ? e.message : String(e)) })
        return
      }
      const t = setTimeout(() => {
        try { child.kill() } catch (e) {}
        resolve({ ok: false, detail: '打印超时（45s）' })
      }, 45000)
      child.stdout.on('data', (d) => { out += String(d) })
      child.stderr.on('data', (d) => { out += String(d) })
      child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, detail: 'spawn 失败：' + (e && e.message ? e.message : String(e)) }) })
      child.on('close', (code) => { clearTimeout(t); resolve({ ok: true, exitCode: code, outText: out, errText: '' }) })
    })
  }

  async function printPdf(exe, htmlPath, pdfPath, profileDir, workDir, signal) {
    const htmlTarget = await fs.resolve(htmlPath)
    const fileUrl = fs.fileUrl(htmlTarget)
    const common = ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--no-pdf-header-footer', '--user-data-dir=' + profileDir, '--print-to-pdf=' + pdfPath, fileUrl]
    const variants = [['--headless=new'].concat(common), ['--headless'].concat(common), ['--headless=new', '--no-sandbox'].concat(common)]
    let detail = ''
    for (let k = 0; k < variants.length; k++) {
      const argv = [exe].concat(variants[k])
      const r = await runBrowser(argv, workDir)
      if (!r.ok) { detail = r.detail || '打印失败'; continue }
      try {
        const pdfTarget = await fs.resolve(pdfPath)
        const info = await fs.stat(pdfTarget)
        if (info && info.size > 0) return { ok: true }
      } catch (e) {}
      detail = ('exit=' + String(r.exitCode) + ' ' + (r.errText || r.outText || '未产出 PDF')).slice(0, 600).trim()
    }
    return { ok: false, detail }
  }

  async function renderManual(idArg, includePdf, signal, session) {
    requireFs()
    const policy = policyFrom(session)
    const cur = await resolveCurrent(policy)
    const root = cur.root
    const id = String(idArg || cur.id || '')
    if (!root) return { ok: false, message: '无法确定工作区根目录，无法写入手册文件' }
    if (!id) return { ok: false, message: '还没有手册，请先在对话中开始访谈（manual_start）' }
    const state = await readJson(statePathOf(root, id))
    if (!state) return { ok: false, message: '手册 ' + id + ' 不存在' }
    const base = baseNameOf(state)
    const md = composeMarkdown(state)
    const mdPath = dirOf(root, id) + '/' + base + '.md'
    await writeTextFile(mdPath, md, signal, policy)
    const htmlPath = dirOf(root, id) + '/' + base + '.html'
    await writeTextFile(htmlPath, htmlDocument(state.title || base, mdToHtml(md)), signal, policy)
    const warnings = []
    const filled = {}
    for (const s of SECTIONS) filled[s.key] = hasText(state, s.key)
    const missingKeys = SECTIONS.filter((s) => !filled[s.key]).map((s) => s.key)
    if (missingKeys.length) warnings.push('以下章节尚未填写：' + missingKeys.join('、'))
    let pdfPath = ''
    let pdfName = ''
    if (includePdf) {
      if (subprocess === undefined) warnings.push('subprocess 服务不可用，跳过 PDF')
      else {
        const exe = await findBrowser()
        if (!exe) warnings.push('未找到 Edge 或 Chrome，无法生成 PDF（Markdown 已生成）')
        else {
          const profileDir = dirOf(root, id) + '/.edge-profile'
          const target = dirOf(root, id) + '/' + base + '.pdf'
          const out = await printPdf(exe, htmlPath, target, profileDir, dirOf(root, id), signal)
          if (out.ok) { pdfPath = target; pdfName = base + '.pdf' }
          else warnings.push('PDF 生成失败：' + out.detail)
        }
      }
    }
    state.render = { at: nowText(), mdPath, htmlPath, pdfPath }
    state.updatedAt = state.updatedAt || nowText()
    state.ts = Date.now()
    await writeJson(statePathOf(root, id), state, signal, policy)
    lastManualId = id
    lastRoot = root
    knownDirs[id] = dirOf(root, id)
    await writePointer(root, id, signal, policy)
    const st = statusOf(state, id, root)
    st.mdPath = mdPath
    st.htmlPath = htmlPath
    st.pdfPath = pdfPath
    st.pdfUrl = pdfPath && webServer !== undefined ? ROUTE + '/' + id + '/' + encodeURIComponent(pdfName) : ''
    st.onepagerUrl = state.onepager && state.onepager.pdfPath && webServer !== undefined ? ROUTE + '/' + id + '/' + encodeURIComponent(baseNameOf(state) + '-一页纸.pdf') : ''
    st.warnings = warnings
    st.message = '已生成：' + mdPath + (pdfPath ? '；PDF：' + pdfPath : '') + (warnings.length ? '（' + warnings.join('；') + '）' : '')
    return st
  }

  async function renderOnePager(idArg, content, signal, session) {
    requireFs()
    const policy = policyFrom(session)
    const cur = await resolveCurrent(policy)
    const root = cur.root
    const id = String(idArg || cur.id || '')
    if (!root) return { ok: false, message: '无法确定工作区根目录' }
    if (!id) return { ok: false, message: '还没有手册，请先 manual_start' }
    const state = await readJson(statePathOf(root, id))
    if (!state) return { ok: false, message: '手册 ' + id + ' 不存在' }
    const base = baseNameOf(state)
    const merged = deriveOnepager(state)
    if (content && typeof content === 'object') {
      if (typeof content.headline === 'string' && content.headline.trim()) merged.headline = content.headline.trim()
      if (typeof content.tagline === 'string' && content.tagline.trim()) merged.tagline = content.tagline.trim()
      if (typeof content.who === 'string' && content.who.trim()) merged.who = content.who.trim()
      if (Array.isArray(content.highlights) && content.highlights.length) {
        merged.highlights = content.highlights.filter((h) => h && typeof h === 'object' && (h.title || h.desc)).map((h) => ({ title: String(h.title || '').slice(0, 18), desc: String(h.desc || '').slice(0, 44), icon: h.icon ? String(h.icon).slice(0, 4) : '' })).slice(0, 6)
      }
      if (Array.isArray(content.steps) && content.steps.length) {
        merged.steps = content.steps.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 56)).slice(0, 4)
      }
    }
    merged.headline = String(merged.headline || '').slice(0, 24)
    merged.tagline = String(merged.tagline || '').slice(0, 60)
    merged.who = String(merged.who || '').slice(0, 90)
    const html = onepagerHtml(state, merged)
    const onepagerName = base + '-一页纸.pdf'
    const htmlPath = dirOf(root, id) + '/' + base + '-一页纸.html'
    await writeTextFile(htmlPath, html, signal, policy)
    const warnings = []
    let pdfPath = ''
    if (subprocess !== undefined) {
      const exe = await findBrowser()
      if (!exe) warnings.push('未找到 Edge 或 Chrome，无法生成 PDF')
      else {
        const profileDir = dirOf(root, id) + '/.edge-profile'
        const target = dirOf(root, id) + '/' + onepagerName
        const out = await printPdf(exe, htmlPath, target, profileDir, dirOf(root, id), signal)
        if (out.ok) pdfPath = target
        else warnings.push('一页纸 PDF 生成失败：' + out.detail)
      }
    } else {
      warnings.push('subprocess 服务不可用，跳过 PDF')
    }
    state.onepager = { at: nowText(), htmlPath, pdfPath, content: merged }
    state.updatedAt = state.updatedAt || nowText()
    state.ts = Date.now()
    await writeJson(statePathOf(root, id), state, signal, policy)
    lastManualId = id
    lastRoot = root
    knownDirs[id] = dirOf(root, id)
    await writePointer(root, id, signal, policy)
    const st = statusOf(state, id, root)
    st.onepagerPath = pdfPath
    st.onepagerHtml = htmlPath
    st.onepagerUrl = pdfPath && webServer !== undefined ? ROUTE + '/' + id + '/' + encodeURIComponent(onepagerName) : ''
    st.content = merged
    st.warnings = warnings
    st.message = '一页纸已生成：' + (pdfPath || htmlPath) + (warnings.length ? '（' + warnings.join('；') + '）' : '')
    return st
  }

  async function addFeedback(text, source, session) {
    requireFs()
    const policy = policyFrom(session)
    const cur = await resolveCurrent(policy)
    const id = cur.id
    if (!id) throw new Error('还没有手册，请先开始访谈（manual_start）')
    const state = await readJson(statePathOf(cur.root, id))
    if (!state) throw new Error('手册 ' + id + ' 不存在')
    const t = String(text || '').trim()
    if (!t) throw new Error('改进意见不能为空')
    const list = Array.isArray(state.feedback) ? state.feedback : []
    list.push({ text: t.slice(0, 300), at: nowText(), source: source || 'chat' })
    while (list.length > 30) list.shift()
    state.feedback = list
    state.updatedAt = nowText()
    state.ts = Date.now()
    await writeJson(statePathOf(cur.root, id), state, undefined, policy)
    lastManualId = id
    lastRoot = cur.root
    knownDirs[id] = dirOf(cur.root, id)
    await writePointer(cur.root, id, undefined, policy)
    const st = statusOf(state, id, cur.root)
    st.message = '已记录改进意见（共 ' + list.length + ' 条）：' + t.slice(0, 60)
    return st
  }

  /* ── 系统提示协议（延迟注入：systemPrompt 可能晚于本行就绪） ── */
  function registerPrompt(sctx) {
    sctx.effect(() => sctx.systemPrompt.section({ name: 'product-manual:interview', order: 150, text: PROMPT_TEXT }))
  }
  ctx.inject(['systemPrompt'], registerPrompt)

  /* ── PDF 服务路由（每实例唯一前缀；handler 按文件名扩展名决定类型） ── */
  function registerRoute(rctx) {
    rctx.effect(() => rctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => {
        const work = async () => {
          ensureServices()
          const pathname = String(req && req.url ? req.url : '/').split('?')[0]
          const parts = pathname.split('/').filter(Boolean)
          const id = parts[1] ? decodeURIComponent(parts[1]) : ''
          const rawFile = parts.length > 2 ? parts.slice(2).join('/') : ''
          let mime = ''
          try {
            const decoded = decodeURIComponent(rawFile)
            if (/\.pdf$/i.test(decoded)) mime = 'application/pdf'
            else if (/\.md$/i.test(decoded)) mime = 'text/markdown; charset=utf-8'
            else if (/\.html$/i.test(decoded)) mime = 'text/html; charset=utf-8'
          } catch (e) { mime = '' }
          if (fs === undefined || !id || !mime) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return }
          const abs = knownDirs[id] || (rootFrom(policyFrom(undefined)) ? dirOf(rootFrom(policyFrom(undefined)), id) : '')
          if (!abs) { res.writeHead(404); res.end('not found'); return }
          let file = rawFile
          try { file = decodeURIComponent(rawFile) } catch (e) {}
          const target = await fs.resolve(abs + '/' + file)
          const info = await fs.stat(target)
          if (!info) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return }
          const bytes = await fs.readBytes(target, undefined, 64 * 1024 * 1024)
          res.writeHead(200, { 'content-type': mime, 'content-length': String(bytes.byteLength), 'cache-control': 'no-store', 'content-disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent(file) })
          res.end(bytes)
        }
        work().catch(() => { try { res.writeHead(500); res.end() } catch (e) {} })
      }
    }))
  }
  ctx.inject(['webServer'], registerRoute)

  /* ── 工具定义（手写 JSON Schema；execute 内部自行校验） ── */
  const toolsList = [
    makeTool({
      name: 'manual_start',
      description: '开始一本新的产品功能手册：记录产品名（可选定位、目标用户），返回章节清单、进度和下一个该问的问题。若同名手册已存在则保留原内容（传 reset=true 可清空重来）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '产品/项目名称，用于命名手册目录' },
          positioning: { type: 'string', description: '一句话定位（给谁、解决什么问题）' },
          audience: { type: 'string', description: '目标用户简述' },
          reset: { type: 'boolean', description: 'true 表示清空同名手册的旧章节重新开始' }
        },
        required: ['name'],
        additionalProperties: false
      },
      execute: async (args, exec) => {
        requireFs()
        const policy = policyFrom(exec && exec.agent && exec.agent.session ? exec.agent.session : undefined)
        const root = rootFrom(policy)
        if (!root) throw new Error('无法确定工作区根目录')
        const id = slugify(args && args.name)
        const sp = statePathOf(root, id)
        let state = await readJson(sp)
        const existed = !!state
        if (!state || (args && args.reset === true)) {
          state = { title: String(args && args.name ? args.name : id), id, ts: Date.now(), createdAt: nowText(), updatedAt: nowText(), sections: {} }
          if (args && typeof args.positioning === 'string' && args.positioning.trim()) state.sections.productSummary = args.positioning.trim()
          if (args && typeof args.audience === 'string' && args.audience.trim()) state.sections.audience = args.audience.trim()
          await writeJson(sp, state, exec && exec.signal, policy)
        }
        lastManualId = id
        lastRoot = root
        knownDirs[id] = dirOf(root, id)
        await writePointer(root, id, exec && exec.signal, policy)
        const st = statusOf(state, id, root)
        st.message = existed ? '已存在同名手册，保留原有内容（如需重来请传 reset=true）' : '手册已创建：' + st.dir
        return st
      }
    }),
    makeTool({
      name: 'manual_update',
      description: '把本轮访谈确认的内容写入手册章节（Markdown）。只传确认过的章节；传空字符串表示清空该章。返回进度、缺失章节和下一个建议问题。manualId 可省略（自动定位当前手册）。',
      parameters: {
        type: 'object',
        properties: {
          manualId: { type: 'string', description: '手册 id（可省略，自动定位最近一次使用的手册）' },
          sections: {
            type: 'object',
            description: '要写入的章节，键为章节 key，值为 Markdown 文本',
            properties: {
              productSummary: { type: 'string' },
              audience: { type: 'string' },
              scenarios: { type: 'string' },
              features: { type: 'string' },
              details: { type: 'string' },
              nonFunctional: { type: 'string' },
              outOfScope: { type: 'string' },
              techRoute: { type: 'string' }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      execute: async (args, exec) => {
        requireFs()
        const policy = policyFrom(exec && exec.agent && exec.agent.session ? exec.agent.session : undefined)
        const cur = await resolveCurrent(policy)
        const root = cur.root
        const id = String((args && args.manualId) || cur.id || '')
        if (!id) {
          const avail = root ? await listManualIds(root) : []
          throw new Error(avail.length ? ('没有选中手册；已有手册：' + avail.join('、') + '。请传 manualId 指定') : '还没有当前手册：请先调用 manual_start 创建')
        }
        const sp = statePathOf(root, id)
        const state = await readJson(sp)
        if (!state) {
          const avail = await listManualIds(root)
          throw new Error('找不到手册 ' + id + (avail.length ? '；已有手册：' + avail.join('、') : ''))
        }
        const sections = args && args.sections && typeof args.sections === 'object' ? args.sections : {}
        const touched = []
        for (const s of SECTIONS) {
          if (!Object.prototype.hasOwnProperty.call(sections, s.key)) continue
          const v = sections[s.key]
          if (typeof v !== 'string') continue
          if (v.trim() === '') delete state.sections[s.key]
          else state.sections[s.key] = v.trim()
          touched.push(s.key)
        }
        if (touched.length === 0) throw new Error('sections 里没有可写入的章节内容')
        state.updatedAt = nowText()
        state.ts = Date.now()
        await writeJson(sp, state, exec && exec.signal, policy)
        lastManualId = id
        lastRoot = root
        knownDirs[id] = dirOf(root, id)
        await writePointer(root, id, exec && exec.signal, policy)
        const st = statusOf(state, id, root)
        st.message = '已更新 ' + touched.join('、') + '；已填 ' + st.filledCount + '/' + st.totalSections + ' 章' + (st.missing.length ? '，还缺：' + st.missing.join('、') : '') + (st.ready ? '。章节已齐，可以 manual_render' : '')
        return st
      }
    }),
    makeTool({
      name: 'manual_research',
      description: '检索同类产品作为启发：看看别人是怎么做某个功能的、为什么这样做。可反复调用、可换角度。结果自动去重累积，并写进手册附录“参考案例”。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词，建议用中文产品场景词，如“校友 小程序 找同学”“校友会 小程序”' },
          sources: { type: 'array', items: { type: 'string', enum: ['github', 'wechat', 'zhihu', 'web'] }, description: '检索方向：github=开源项目，wechat=微信小程序/公众号案例，zhihu=产品讨论，web=普通网页（默认 github+web）' },
          limit: { type: 'number', description: '每个查询最多返回条数，默认 5' },
          note: { type: 'string', description: '本轮研究得到的启发或结论，会作为附录里一组的标题' }
        },
        required: ['query'],
        additionalProperties: false
      },
      timeoutMs: 180000,
      execute: async (args, exec) => {
        requireFs()
        const policy = policyFrom(exec && exec.agent && exec.agent.session ? exec.agent.session : undefined)
        const cur = await resolveCurrent(policy)
        const root = cur.root
        const id = cur.id
        if (!root || !id) return { ok: false, message: '还没有当前手册：请先调用 manual_start' }
        const state = await readJson(statePathOf(root, id))
        if (!state) return { ok: false, message: '手册 ' + id + ' 不存在' }
        const base = String(args && args.query ? args.query : '').trim()
        if (!base) return { ok: false, message: 'query 不能为空' }
        const limit = args && typeof args.limit === 'number' && args.limit > 0 ? Math.min(8, Math.floor(args.limit)) : 5
        const sites = { github: ' site:github.com', wechat: ' site:mp.weixin.qq.com', zhihu: ' site:zhihu.com', web: '' }
        const srcs = args && Array.isArray(args.sources) && args.sources.length ? args.sources.map(String) : ['github', 'web']
        const queries = []
        for (const s of srcs) {
          const site = Object.prototype.hasOwnProperty.call(sites, s) ? sites[s] : ''
          const q = base + site
          if (queries.indexOf(q) < 0) queries.push(q)
        }
        const refs = Array.isArray(state.references) ? state.references : []
        const seen = {}
        for (const r of refs) if (r && r.url) seen[r.url] = true
        const added = []
        const notes = []
        const errors = []
        const signal = exec && exec.signal
        const noteText = String(args && args.note ? args.note : '')
        const collect = (list, q, withPublished) => {
          for (const s of list) {
            if (!s || !s.url || seen[s.url]) continue
            seen[s.url] = true
            const ref = { url: String(s.url), title: String(s.title || s.url), snippet: String(s.snippet || ''), publishedAt: withPublished && s.publishedAt ? String(s.publishedAt) : '', query: q, note: noteText, at: nowText() }
            refs.push(ref)
            added.push(ref)
          }
        }

        // 1) 平台 web 搜索（质量最好，覆盖 微信/知乎/网页）。
        if (web !== undefined) {
          for (const q of queries) {
            try {
              const res = await web.search({ query: q, maxResults: limit }, signal)
              if (res && res.content) notes.push(String(res.content).slice(0, 400))
              collect(res && Array.isArray(res.sources) ? res.sources : [], q, true)
            } catch (e) {
              errors.push(q + '：' + (e && e.message ? e.message : String(e)))
            }
          }
        }

        // 2) GitHub 内置检索：不依赖任何宿主服务，可作补强或兜底。
        if (srcs.indexOf('github') >= 0) {
          try {
            const items = await githubSearch(base, limit, signal)
            collect(items, base + ' (GitHub API)', false)
          } catch (e) {
            errors.push('github：' + (e && e.message ? e.message : String(e)))
          }
        }

        if (web === undefined && srcs.indexOf('github') < 0) {
          errors.push('未配置平台 web 搜索：非 github 方向不可用；请改用 sources 包含 "github"，或启用 web 搜索 provider')
        }
        const MAX = 60
        while (refs.length > MAX) refs.shift()
        state.references = refs
        state.updatedAt = nowText()
        state.ts = Date.now()
        await writeJson(statePathOf(root, id), state, exec && exec.signal, policy)
        lastManualId = id
        lastRoot = root
        knownDirs[id] = dirOf(root, id)
        await writePointer(root, id, exec && exec.signal, policy)
        return {
          ok: true,
          manualId: id,
          added: added.length,
          total: refs.length,
          results: added.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
          notes,
          message: '检索到 ' + added.length + ' 条新参考（共 ' + refs.length + ' 条）' + (errors.length ? '；部分查询失败：' + errors.join('；') : '')
        }
      }
    }),
    makeTool({
      name: 'manual_onepager',
      description: '基于手册生成“一页纸”PDF 简介（A4 单页，带图标与装饰）：给普通读者看，截图就能转发给领导/朋友。只讲主要功能亮点，文案正向、大白话，不写限制/异常/技术细节。可用 headline/tagline/who/highlights/steps 覆盖文案，不传则从手册自动提炼。highlights 最多 6 个（建议写满），steps 可给 2-4 步上手流程，把一页纸写满。PDF 文件名自动用中文（产品名-一页纸.pdf）。',
      parameters: {
        type: 'object',
        properties: {
          manualId: { type: 'string', description: '手册 id（可省略，自动定位当前手册）' },
          headline: { type: 'string', description: '大标题（默认用产品名）' },
          tagline: { type: 'string', description: '一句话卖点（默认从产品定位提炼；建议 15-45 字，大白话）' },
          who: { type: 'string', description: '适合谁（默认从目标用户提炼）' },
          highlights: {
            type: 'array',
            description: '3-6 个功能亮点，每个 {title, desc, icon?}；desc 一句话、正向，不含异常边界；icon 可给一个 emoji',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                desc: { type: 'string' },
                icon: { type: 'string' }
              },
              additionalProperties: false
            }
          },
          steps: { type: 'array', items: { type: 'string' }, description: '2-4 步上手流程，如“注册：老同学发你邀请码，填好资料就加入”' }
        },
        additionalProperties: false
      },
      timeoutMs: 180000,
      execute: async (args, exec) => {
        return await renderOnePager((args && args.manualId) || '', args, exec && exec.signal, exec && exec.agent && exec.agent.session ? exec.agent.session : undefined)
      }
    }),
    makeTool({
      name: 'manual_feedback',
      description: '记录读者（用户）看了一页纸或完整手册后提出的改进意见，用于持续迭代：可反复调用。记录后应根据意见更新对应章节或一页纸文案，并重新生成。',
      parameters: {
        type: 'object',
        properties: {
          manualId: { type: 'string', description: '手册 id（可省略，自动定位当前手册）' },
          text: { type: 'string', description: '一条改进意见（尽量短，一句话）' },
          source: { type: 'string', description: '来源：chat（对话里说的）或 panel（面板提交）' }
        },
        required: ['text'],
        additionalProperties: false
      },
      execute: async (args, exec) => {
        return await addFeedback(args && args.text, args && args.source === 'panel' ? 'panel' : 'chat', exec && exec.agent && exec.agent.session ? exec.agent.session : undefined)
      }
    }),
    makeTool({
      name: 'manual_status',
      description: '查看当前手册的进度：已填 / 缺失章节列表、完成度、下一个建议问题、参考案例数、改进意见条数，以及最近一次生成的 md / pdf 路径。',
      parameters: {
        type: 'object',
        properties: { manualId: { type: 'string', description: '手册 id（可省略，自动定位当前手册）' } },
        additionalProperties: false
      },
      execute: async (args, exec) => {
        requireFs()
        const policy = policyFrom(exec && exec.agent && exec.agent.session ? exec.agent.session : undefined)
        const cur = await resolveCurrent(policy)
        const id = String((args && args.manualId) || cur.id || '')
        if (!id || !cur.root) return emptyStatus({ manualId: id, message: '还没有开始的手册。请先调用 manual_start 记录产品名与定位。' })
        const state = await readJson(statePathOf(cur.root, id))
        if (!state) return emptyStatus({ manualId: id, message: '手册 ' + id + ' 不存在。' })
        lastManualId = id
        lastRoot = cur.root
        knownDirs[id] = dirOf(cur.root, id)
        const st = statusOf(state, id, cur.root)
        st.message = '已填 ' + st.filledCount + '/' + st.totalSections + ' 章' + (st.missing.length ? '；还缺：' + st.missing.join('、') : '；章节已齐，可以 manual_render')
        return st
      }
    }),
    makeTool({
      name: 'manual_render',
      description: '把当前手册渲染成 Markdown 文档并生成 PDF（用本机 Edge 无头打印），含附录参考案例与改进意见。PDF 文件名直接是产品名（如“中学校友小程序.pdf”）。返回 md / pdf 文件路径，以及一个可以在浏览器里直接打开的 pdfUrl。未填章节会以“待补充”呈现。',
      parameters: {
        type: 'object',
        properties: {
          manualId: { type: 'string', description: '手册 id（可省略，自动定位当前手册）' },
          includePdf: { type: 'boolean', description: 'false 时只生成 Markdown，跳过 PDF' }
        },
        additionalProperties: false
      },
      timeoutMs: 180000,
      execute: async (args, exec) => {
        return await renderManual((args && args.manualId) || '', args && args.includePdf !== false, exec && exec.signal, exec && exec.agent && exec.agent.session ? exec.agent.session : undefined)
      }
    }),
    makeTool({
      name: 'pm_diag',
      description: '诊断工具：报告插件当前可见的宿主服务与运行状态（排查"fs 不可用"类问题）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        ensureServices()
        const report = {
          fs: typeof fs,
          subprocess: typeof subprocess,
          sandboxPolicy: typeof sandboxPolicy,
          systemPrompt: typeof systemPrompt,
          webServer: typeof webServer,
          timer: typeof timer,
          web: typeof web,
          toolsRegistered: toolsList.length,
          route: ROUTE
        }
        return { ok: true, message: JSON.stringify(report), diag: report }
      }
    })
  ]

  for (const tool of toolsList) tools.register(tool)
}
