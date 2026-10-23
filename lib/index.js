/**
 * dsh-plugin-product-manual — product manual generator (host-side plugin)
 *
 * This is a Cordis plugin row (referenced by an agent preset's agent.cordis.yml):
 *  - registers 7 manual_* tools (interview / chapter read-write / competitor research / one-pager / feedback / status / render)
 *  - registers a "product interviewer" system prompt protocol (order 150)
 *  - registers a per-instance isolated PDF service route (/product-manuals-<rand>/<manualId>/<filename>)
 *
 * Design constraints:
 *  - zero external imports: only ctx and built-in capabilities, to avoid host-side dependency resolution issues;
 *  - tool definitions are hand-written ToolDefinitions (parameters use standard JSON Schema), not defineTool;
 *  - each plugin instance uses its own URL prefix, so multiple sessions can mount this row without conflicts.
 */

import { spawn } from 'node:child_process'

const SECTIONS = [
  { key: 'productSummary', title: '1. Product Positioning and One-Liner', hint: 'Who it is for, what pain it solves, why it beats current practice', question: 'Describe this product in one sentence: who is it for, and what trouble does it solve for them?' },
  { key: 'audience', title: '2. Target Users', hint: 'Who the users are, their skill level, the environment they work in', question: 'Who will use it? What are their roles, skill levels, and usage environments?' },
  { key: 'scenarios', title: '3. Typical Usage Scenarios', hint: 'When they open it, and how they complete one task end to end', question: 'Can you give a concrete example: in what situation do they open it, and how do they use it from start to finish?' },
  { key: 'features', title: '4. Feature List', hint: 'A feature table prioritized as P0/P1/P2', question: 'What are the three most essential things? Please rank the other features you want by importance.' },
  { key: 'details', title: '5. Detailed Feature Requirements', hint: 'Inputs, actions, outputs, boundaries, and acceptance criteria for each core feature', question: 'Pick the most important feature and break it down: what goes in, where do they click, what do they see, and what counts as success?' },
  { key: 'nonFunctional', title: '6. Non-Functional Requirements', hint: 'User-facing expectations for speed, privacy, stability, and availability', question: 'What are your requirements for speed and stability? Which experience issues would users least tolerate?' },
  { key: 'outOfScope', title: '7. Explicitly Out of Scope', hint: 'What this version deliberately skips, to avoid scope creep', question: 'What is explicitly out of scope for this version? Which ideas should wait?' },
  { key: 'techRoute', title: '8. Technical Route', hint: 'The implementation route and trade-offs derived backwards from functional requirements', question: 'Given the features above, what are the hard technical requirements (data volume, latency, offline, security, cost, team size)?' }
]

const DIR = 'product-manuals'
/** Per-instance route prefix so several sessions can mount this row without colliding. */
const ROUTE = '/product-manuals-' + Math.random().toString(36).slice(2, 8)

const PROMPT_TEXT = [
  '## Product Manual (manual_* tools)',
  '',
  'Use these tools when the user wants to turn a vague idea into a buildable product, or wants to write a product manual / requirements document. Your role is a product interviewer: through multi-turn dialogue, turn the user\'s spoken, fragmented, imprecise description into structured functional requirements, and finally generate a Markdown manual and a PDF.',
  '',
  'Interview rules:',
  '1. Ask only 1-2 questions per turn. First restate and confirm what the user said in the previous turn, then ask the next question. Use everyday language and avoid jargon.',
  '2. Always ask about user-facing functionality: who uses it, in what scenario, what they need to accomplish, what they input, what result they see, and how success or failure is judged. Never proactively ask about tech stack, frameworks, databases, cloud services, or deployment.',
  '3. For questions that can be covered by 2-4 concrete options, prefer the ask_user_question tool so the user can click (single or multi select) instead of typing; use free-text questions only for open-ended topics. If the user says "whatever / either is fine / you decide", you must still offer concrete options to help them choose.',
  '4. For every feature, clarify at least: trigger scenario, inputs, core actions, outputs, edge cases and exceptions, and acceptance criteria.',
  '5. Do not fabricate anything that was not asked. Prefer leaving it blank and let the user fill it in next turn.',
  '6. Sub-headings inside a chapter must be level-3 headings (start with ###), never level-2 (##) — level-2 is reserved for chapter titles, and generation automatically demotes in-chapter ## to ###.',
  '',
  'Tools and flow:',
  '- Start with manual_start to record the product name and positioning.',
  '- At the end of each interview turn, call manual_update to write the confirmed content into the corresponding chapters (Markdown).',
  '- When the user is vague, or unsure whether a feature is worth building, call manual_research to see how others do it (repeatable, from different angles: github open-source projects / wechat mini-program cases / zhihu product discussions / web). Explain "how others do it" with 2-3 concrete examples, then use ask_user_question to let the user choose; record the takeaway in note, which goes into the appendix "Reference Cases".',
  '- Use manual_status to see what is missing and what to ask next.',
  '- When the interview is complete, call manual_render to generate Markdown and PDF (the PDF filename is simply the product name, e.g. "Alumni Mini Program.pdf"), and tell the user the pdfUrl link and file path; afterwards the user can keep iterating: make changes, then call manual_update + manual_render again.',
  '- When the user wants a "one-pager / screenshot to forward / something to show the boss or friends", call manual_onepager to generate a single-page PDF: cover only the main feature highlights, with positive plain-language copy, and no limitations / exceptions / technical details. Use highlights for 3-6 highlights and steps for a 2-4 step getting-started flow to fill the page.',
  '- When the user gives feedback after reading the PDF, first call manual_feedback to record it (multiple entries allowed), then update the corresponding chapters or one-pager copy accordingly, and regenerate.',
  '',
  'Chapter structure: productSummary product positioning / audience target users / scenarios typical usage scenarios / features feature list (P0/P1/P2 table) / details detailed feature requirements / nonFunctional non-functional requirements / outOfScope explicitly out of scope / techRoute technical route. Reference products found during research go into the "Appendix", not the first seven chapters.',
  '',
  'Order requirement: the first seven chapters only describe user-facing functionality and acceptance criteria; no technology choices. Only the last chapter techRoute covers the technical route, and it must be derived backwards from the functional requirements above — first distill the hard technical requirements implied by the features (data volume, latency, offline, security, cost, team size), then propose the technical route, why it was chosen, and the trade-offs against alternatives. Technology is downstream of functionality; never let technology constrain functionality.'
].join('\n')

/* ────────────────────────── small helpers ────────────────────────── */

function slugify(name) {
  let s = String(name == null ? '' : name).toLowerCase()
  s = s.replace(/[^a-z0-9]+/g, '-')
  s = s.replace(/^-+|-+$/g, '')
  if (s === '') s = 'manual-' + Date.now()
  if (s.length > 48) s = s.slice(0, 48)
  return s
}

function baseNameOf(state) {
  let s = String(state && state.title ? state.title : 'Product Manual').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) s = 'Product Manual'
  if (s.length > 40) s = s.slice(0, 40)
  return s
}

function nowText() {
  try { return new Date().toLocaleString('en-US', { hour12: false }) } catch (e) { return new Date().toISOString() }
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
  'body { font-family: "Segoe UI", "Helvetica Neue", Arial, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif; font-size: 10.5pt; line-height: 1.75; color: #1f2328; }',
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
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title><style>' + PRINT_CSS + '</style></head><body><article>' + body + '</article></body></html>'
}

const ONEPAGER_CSS = [
  '@page { size: A4; margin: 0; }',
  '* { box-sizing: border-box; }',
  'html, body { margin: 0; padding: 0; }',
  'body { font-family: "Segoe UI", "Helvetica Neue", Arial, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif; color: #1f2328; -webkit-print-color-adjust: exact; }',
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
    [/find|search|lookup|discover/i, '🔍'],
    [/contact|privacy|apply|dignity/i, '🔒'],
    [/help|referral|job|mutual|assist/i, '🤝'],
    [/event|signup|sign up|meetup|talk|match/i, '📅'],
    [/remind|notify|alert|message/i, '🔔'],
    [/trust|report|block|safe|clean/i, '🛡️'],
    [/register|invite|join/i, '✉️'],
    [/chat|dm|communicate/i, '💬'],
    [/stats|data|report|summary/i, '📊'],
    [/photo|image|upload/i, '🖼️']
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
    headline: String(state.title || 'Product'),
    tagline: tagline || 'One line that explains this product',
    highlights,
    steps: [],
    who: who.length > 90 ? who.slice(0, 90) + '…' : who
  }
}

function onepagerHtml(state, content) {
  const c = content || {}
  const name = escapeHtml(c.headline || state.title || 'Product')
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
    const t = parts.length > 1 ? parts[0] : ('Step ' + String(i + 1))
    const d = parts.length > 1 ? parts.slice(1).join(':') : String(s)
    return '<div class="step"><div class="sn">' + escapeHtml(t) + '</div><div class="sd">' + escapeHtml(d) + '</div></div>'
  }).join('')
  const parts = [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>' + name + '</title><style>' + ONEPAGER_CSS + '</style></head><body><div class="sheet">',
    '<div class="band"><div><div class="name">' + name + '</div>' + (tag ? '<div class="tag">' + tag + '</div>' : '') + '</div>' + DECO_SVG + '</div>',
    hl.length ? '<div class="sec">HIGHLIGHTS</div><div class="grid">' + cards + '</div>' : '',
    stepHtml ? '<div class="sec">GET STARTED</div><div class="steps">' + stepHtml + '</div>' : '',
    who ? '<div class="who"><span class="wl">WHO IT IS FOR</span>' + who + '</div>' : '',
    '<div class="foot">Reader one-pager · Full details in the product manual</div>',
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
  lines.push('# ' + (state.title || 'Product Manual'))
  lines.push('')
  lines.push('> Compiled from a multi-turn interview · Updated ' + (state.updatedAt || nowText()))
  lines.push('')
  lines.push('## How to Read This Document')
  lines.push('')
  lines.push('- Chapters 1 to 7 describe only user-facing functional requirements and acceptance criteria; they contain no technology choices.')
  lines.push('- Chapter 8, "Technical Route", is derived backwards from the functional requirements: it explains why these features need the corresponding technology, and the trade-offs against alternatives.')
  lines.push('- Chapters marked "To be completed" are not confirmed yet; you can fill them in during the conversation and regenerate.')
  lines.push('')
  for (const s of SECTIONS) {
    lines.push('## ' + s.title)
    lines.push('')
    if (hasText(state, s.key)) lines.push(demoteHeadings(String(state.sections[s.key]).trim()))
    else lines.push('> To be completed: ' + s.hint + '.')
    lines.push('')
  }
  const refs = Array.isArray(state.references) ? state.references : []
  if (refs.length > 0) {
    lines.push('## Appendix: Reference Cases (Inspiration List)')
    lines.push('')
    lines.push('Below are similar products / open-source projects / discussions found during the interview. They explain "why others do it this way" and help confirm feature trade-offs.')
    lines.push('')
    const groups = {}
    const order = []
    for (const r of refs) {
      if (!r || !r.url) continue
      const noteText = r.note && String(r.note).trim() ? String(r.note).trim() : (r.query || 'Search results')
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
    lines.push('## Appendix: Improvement Feedback (Pending)')
    lines.push('')
    lines.push('Changes readers suggested after reviewing the current version; future iterations should follow these notes.')
    lines.push('')
    for (const f of fbs) lines.push('- ' + String(f.text || '') + (f.at ? ' (' + String(f.at) + ')' : ''))
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push('> Generated by the "Product Manual" plugin: functionality decides technology, not the other way around.')
  return lines.join('\n')
}

/** Model-facing text for one canonical tool value. */
function textOf(v) {
  if (!v || typeof v !== 'object') return String(v)
  const lines = []
  if (v.message) lines.push(String(v.message))
  if (typeof v.filledCount === 'number' && typeof v.totalSections === 'number') lines.push('Progress: ' + v.filledCount + '/' + v.totalSections + ' chapters')
  if (Array.isArray(v.missing) && v.missing.length) lines.push('Missing chapters: ' + v.missing.join(', '))
  if (v.nextQuestion) lines.push('Suggested next question: ' + v.nextQuestion)
  if (typeof v.referenceCount === 'number' && v.referenceCount > 0) lines.push('Reference cases: ' + v.referenceCount)
  if (typeof v.feedbackCount === 'number' && v.feedbackCount > 0) lines.push('Feedback items: ' + v.feedbackCount)
  if (Array.isArray(v.feedbackLatest) && v.feedbackLatest.length) lines.push('Latest feedback: ' + v.feedbackLatest.join('; '))
  if (v.pdfUrl) lines.push('PDF link: ' + v.pdfUrl)
  if (v.onepagerUrl) lines.push('One-pager link: ' + v.onepagerUrl)
  if (Array.isArray(v.warnings) && v.warnings.length) lines.push('Notes: ' + v.warnings.join('; '))
  if (Array.isArray(v.results) && v.results.length) {
    lines.push('Search results:')
    for (const r of v.results) lines.push('- ' + (r.title || r.url) + ' ' + r.url + (r.snippet ? ': ' + String(r.snippet).slice(0, 160) : ''))
  }
  if (Array.isArray(v.notes) && v.notes.length) lines.push('Summary: ' + v.notes.join(' '))
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

/* ────────────────────────── the plugin itself ────────────────────────── */

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

  /** Host composition load order is not guaranteed: services may arrive after this row, so re-resolve at execution time. */
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
    if (fs === undefined) throw new Error('Filesystem service fs is unavailable; cannot read or write manual files')
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
    // PATH fallback: msedge / chrome / chromium
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

  /** Built-in GitHub search: needs no host service and no key (optional GITHUB_TOKEN raises the rate limit). */
  async function githubSearch(query, limit, signal) {
    if (typeof fetch !== 'function') throw new Error('fetch is not available in the current runtime')
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

  /** Start one browser process: prefer the host subprocess service, fall back to node:child_process. */
  async function runBrowser(argv, cwd) {
    if (subprocess !== undefined) {
      const handle = subprocess.spawn({ argv, cwd, stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 16384 } }, graceMs: 4000 })
      let race
      try {
        race = timer !== undefined
          ? await Promise.race([handle.done.then((v) => ({ t: 'exit', v })), timer.timeout(45000).then(() => ({ t: 'timeout' }))])
          : await handle.done.then((v) => ({ t: 'exit', v }))
      } catch (e) {
        return { ok: false, detail: 'Process failed: ' + (e && e.message ? e.message : String(e)) }
      }
      if (race.t === 'timeout') {
        try { handle.terminate() } catch (e) {}
        return { ok: false, detail: 'Printing timed out (45s)' }
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
        resolve({ ok: false, detail: 'spawn failed: ' + (e && e.message ? e.message : String(e)) })
        return
      }
      const t = setTimeout(() => {
        try { child.kill() } catch (e) {}
        resolve({ ok: false, detail: 'Printing timed out (45s)' })
      }, 45000)
      child.stdout.on('data', (d) => { out += String(d) })
      child.stderr.on('data', (d) => { out += String(d) })
      child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, detail: 'spawn failed: ' + (e && e.message ? e.message : String(e)) }) })
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
      if (!r.ok) { detail = r.detail || 'Printing failed'; continue }
      try {
        const pdfTarget = await fs.resolve(pdfPath)
        const info = await fs.stat(pdfTarget)
        if (info && info.size > 0) return { ok: true }
      } catch (e) {}
      detail = ('exit=' + String(r.exitCode) + ' ' + (r.errText || r.outText || 'no PDF produced')).slice(0, 600).trim()
    }
    return { ok: false, detail }
  }

  async function renderManual(idArg, includePdf, signal, session) {
    requireFs()
    const policy = policyFrom(session)
    const cur = await resolveCurrent(policy)
    const root = cur.root
    const id = String(idArg || cur.id || '')
    if (!root) return { ok: false, message: 'Cannot determine the workspace root, so the manual file cannot be written' }
    if (!id) return { ok: false, message: 'No manual yet; please start the interview first (manual_start)' }
    const state = await readJson(statePathOf(root, id))
    if (!state) return { ok: false, message: 'Manual ' + id + ' does not exist' }
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
    if (missingKeys.length) warnings.push('These chapters are still empty: ' + missingKeys.join(', '))
    let pdfPath = ''
    let pdfName = ''
    if (includePdf) {
      if (subprocess === undefined) warnings.push('subprocess service unavailable; skipping PDF')
      else {
        const exe = await findBrowser()
        if (!exe) warnings.push('Edge or Chrome not found; cannot generate PDF (Markdown was generated)')
        else {
          const profileDir = dirOf(root, id) + '/.edge-profile'
          const target = dirOf(root, id) + '/' + base + '.pdf'
          const out = await printPdf(exe, htmlPath, target, profileDir, dirOf(root, id), signal)
          if (out.ok) { pdfPath = target; pdfName = base + '.pdf' }
          else warnings.push('PDF generation failed: ' + out.detail)
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
    st.onepagerUrl = state.onepager && state.onepager.pdfPath && webServer !== undefined ? ROUTE + '/' + id + '/' + encodeURIComponent(baseNameOf(state) + '-onepager.pdf') : ''
    st.warnings = warnings
    st.message = 'Generated: ' + mdPath + (pdfPath ? '; PDF: ' + pdfPath : '') + (warnings.length ? ' (' + warnings.join('; ') + ')' : '')
    return st
  }

  async function renderOnePager(idArg, content, signal, session) {
    requireFs()
    const policy = policyFrom(session)
    const cur = await resolveCurrent(policy)
    const root = cur.root
    const id = String(idArg || cur.id || '')
    if (!root) return { ok: false, message: 'Cannot determine the workspace root' }
    if (!id) return { ok: false, message: 'No manual yet; please call manual_start first' }
    const state = await readJson(statePathOf(root, id))
    if (!state) return { ok: false, message: 'Manual ' + id + ' does not exist' }
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
    const onepagerName = base + '-onepager.pdf'
    const htmlPath = dirOf(root, id) + '/' + base + '-onepager.html'
    await writeTextFile(htmlPath, html, signal, policy)
    const warnings = []
    let pdfPath = ''
    if (subprocess !== undefined) {
      const exe = await findBrowser()
      if (!exe) warnings.push('Edge or Chrome not found; cannot generate PDF')
      else {
        const profileDir = dirOf(root, id) + '/.edge-profile'
        const target = dirOf(root, id) + '/' + onepagerName
        const out = await printPdf(exe, htmlPath, target, profileDir, dirOf(root, id), signal)
        if (out.ok) pdfPath = target
        else warnings.push('One-pager PDF generation failed: ' + out.detail)
      }
    } else {
      warnings.push('subprocess service unavailable; skipping PDF')
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
    st.message = 'One-pager generated: ' + (pdfPath || htmlPath) + (warnings.length ? ' (' + warnings.join('; ') + ')' : '')
    return st
  }

  async function addFeedback(text, source, session) {
    requireFs()
    const policy = policyFrom(session)
    const cur = await resolveCurrent(policy)
    const id = cur.id
    if (!id) throw new Error('No manual yet; please start the interview first (manual_start)')
    const state = await readJson(statePathOf(cur.root, id))
    if (!state) throw new Error('Manual ' + id + ' does not exist')
    const t = String(text || '').trim()
    if (!t) throw new Error('Feedback cannot be empty')
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
    st.message = 'Feedback recorded (' + list.length + ' in total): ' + t.slice(0, 60)
    return st
  }

  /* ── system prompt protocol (deferred injection: systemPrompt may become ready after this row) ── */
  function registerPrompt(sctx) {
    sctx.effect(() => sctx.systemPrompt.section({ name: 'product-manual:interview', order: 150, text: PROMPT_TEXT }))
  }
  ctx.inject(['systemPrompt'], registerPrompt)

  /* ── PDF service route (unique prefix per instance; handler decides the type by file extension) ── */
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

  /* ── tool definitions (hand-written JSON Schema; execute validates arguments itself) ── */
  const toolsList = [
    makeTool({
      name: 'manual_start',
      description: 'Start a new product manual: record the product name (optionally positioning and target users), and return the chapter list, progress, and the next question to ask. If a manual with the same name exists, its content is kept (pass reset=true to clear and start over).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Product/project name, used to name the manual directory' },
          positioning: { type: 'string', description: 'One-line positioning (who it is for, what problem it solves)' },
          audience: { type: 'string', description: 'Brief description of target users' },
          reset: { type: 'boolean', description: 'true clears the old chapters of the same-named manual and starts over' }
        },
        required: ['name'],
        additionalProperties: false
      },
      execute: async (args, exec) => {
        requireFs()
        const policy = policyFrom(exec && exec.agent && exec.agent.session ? exec.agent.session : undefined)
        const root = rootFrom(policy)
        if (!root) throw new Error('Cannot determine the workspace root')
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
        st.message = existed ? 'A manual with the same name already exists; existing content kept (pass reset=true to start over)' : 'Manual created: ' + st.dir
        return st
      }
    }),
    makeTool({
      name: 'manual_update',
      description: 'Write the content confirmed in this interview turn into the manual chapters (Markdown). Pass only confirmed chapters; an empty string clears that chapter. Returns progress, missing chapters, and the next suggested question. manualId may be omitted (the current manual is located automatically).',
      parameters: {
        type: 'object',
        properties: {
          manualId: { type: 'string', description: 'Manual id (optional; the most recently used manual is located automatically)' },
          sections: {
            type: 'object',
            description: 'Chapters to write, keyed by chapter key, with Markdown text as the value',
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
          throw new Error(avail.length ? ('No manual selected; existing manuals: ' + avail.join(', ') + '. Pass manualId to choose one') : 'No current manual yet: call manual_start first')
        }
        const sp = statePathOf(root, id)
        const state = await readJson(sp)
        if (!state) {
          const avail = await listManualIds(root)
          throw new Error('Manual ' + id + ' not found' + (avail.length ? '; existing manuals: ' + avail.join(', ') : ''))
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
        if (touched.length === 0) throw new Error('No writable chapter content in sections')
        state.updatedAt = nowText()
        state.ts = Date.now()
        await writeJson(sp, state, exec && exec.signal, policy)
        lastManualId = id
        lastRoot = root
        knownDirs[id] = dirOf(root, id)
        await writePointer(root, id, exec && exec.signal, policy)
        const st = statusOf(state, id, root)
        st.message = 'Updated ' + touched.join(', ') + '; filled ' + st.filledCount + '/' + st.totalSections + ' chapters' + (st.missing.length ? '; still missing: ' + st.missing.join(', ') : '') + (st.ready ? '. All chapters are in place, ready for manual_render' : '')
        return st
      }
    }),
    makeTool({
      name: 'manual_research',
      description: 'Research similar products for inspiration: see how others implement a feature and why. Can be called repeatedly from different angles. Results are deduplicated and accumulated, then written into the manual appendix "Reference Cases".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms; product-scenario phrases work best, e.g. "alumni mini program find classmates" or "alumni association mini program"' },
          sources: { type: 'array', items: { type: 'string', enum: ['github', 'wechat', 'zhihu', 'web'] }, description: 'Search directions: github=open-source projects, wechat=WeChat mini-program/official-account cases, zhihu=product discussions, web=general web pages (default github+web)' },
          limit: { type: 'number', description: 'Maximum results per query, default 5' },
          note: { type: 'string', description: 'Inspiration or takeaway from this round of research; used as the title of a group in the appendix' }
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
        if (!root || !id) return { ok: false, message: 'No current manual yet: call manual_start first' }
        const state = await readJson(statePathOf(root, id))
        if (!state) return { ok: false, message: 'Manual ' + id + ' does not exist' }
        const base = String(args && args.query ? args.query : '').trim()
        if (!base) return { ok: false, message: 'query cannot be empty' }
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

        // 1) Platform web search (best quality; covers WeChat / Zhihu / general web).
        if (web !== undefined) {
          for (const q of queries) {
            try {
              const res = await web.search({ query: q, maxResults: limit }, signal)
              if (res && res.content) notes.push(String(res.content).slice(0, 400))
              collect(res && Array.isArray(res.sources) ? res.sources : [], q, true)
            } catch (e) {
              errors.push(q + ': ' + (e && e.message ? e.message : String(e)))
            }
          }
        }

        // 2) Built-in GitHub search: needs no host service; works as reinforcement or fallback.
        if (srcs.indexOf('github') >= 0) {
          try {
            const items = await githubSearch(base, limit, signal)
            collect(items, base + ' (GitHub API)', false)
          } catch (e) {
            errors.push('github: ' + (e && e.message ? e.message : String(e)))
          }
        }

        if (web === undefined && srcs.indexOf('github') < 0) {
          errors.push('No platform web search configured: non-GitHub directions are unavailable; include "github" in sources, or enable a web search provider')
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
          message: 'Found ' + added.length + ' new references (' + refs.length + ' in total)' + (errors.length ? '; some queries failed: ' + errors.join('; ') : '')
        }
      }
    }),
    makeTool({
      name: 'manual_onepager',
      description: 'Generate a "one-pager" PDF summary from the manual (single A4 page with icons and decoration): written for general readers, ready to screenshot and forward to a boss or friend. Cover only the main feature highlights with positive plain-language copy; no limitations/exceptions/technical details. Use headline/tagline/who/highlights/steps to override the copy; otherwise it is derived from the manual. Up to 6 highlights (fill them all if possible); steps can provide a 2-4 step getting-started flow to fill the page. The PDF filename uses the product name plus -onepager.pdf.',
      parameters: {
        type: 'object',
        properties: {
          manualId: { type: 'string', description: 'Manual id (optional; the current manual is located automatically)' },
          headline: { type: 'string', description: 'Main headline (defaults to the product name)' },
          tagline: { type: 'string', description: 'One-line selling point (defaults to the positioning; 15-45 words of plain language is ideal)' },
          who: { type: 'string', description: 'Who it is for (defaults to the target users)' },
          highlights: {
            type: 'array',
            description: '3-6 feature highlights, each {title, desc, icon?}; desc is one positive sentence without edge cases; icon may be an emoji',
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
          steps: { type: 'array', items: { type: 'string' }, description: '2-4 step getting-started flow, e.g. "Sign up: an old classmate sends you an invite code, fill in your profile and join"' }
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
      description: 'Record improvement feedback from readers (users) after they read the one-pager or the full manual, for continuous iteration: can be called repeatedly. After recording, update the corresponding chapters or one-pager copy and regenerate.',
      parameters: {
        type: 'object',
        properties: {
          manualId: { type: 'string', description: 'Manual id (optional; the current manual is located automatically)' },
          text: { type: 'string', description: 'One piece of feedback (as short as possible, one sentence)' },
          source: { type: 'string', description: 'Source: chat (said in conversation) or panel (submitted through a panel)' }
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
      description: 'Show the current manual progress: filled / missing chapters, completion, the next suggested question, reference case count, feedback count, and the paths of the latest md / pdf output.',
      parameters: {
        type: 'object',
        properties: { manualId: { type: 'string', description: 'Manual id (optional; the current manual is located automatically)' } },
        additionalProperties: false
      },
      execute: async (args, exec) => {
        requireFs()
        const policy = policyFrom(exec && exec.agent && exec.agent.session ? exec.agent.session : undefined)
        const cur = await resolveCurrent(policy)
        const id = String((args && args.manualId) || cur.id || '')
        if (!id || !cur.root) return emptyStatus({ manualId: id, message: 'No manual has been started. Call manual_start first to record the product name and positioning.' })
        const state = await readJson(statePathOf(cur.root, id))
        if (!state) return emptyStatus({ manualId: id, message: 'Manual ' + id + ' does not exist.' })
        lastManualId = id
        lastRoot = cur.root
        knownDirs[id] = dirOf(cur.root, id)
        const st = statusOf(state, id, cur.root)
        st.message = 'Filled ' + st.filledCount + '/' + st.totalSections + ' chapters' + (st.missing.length ? '; still missing: ' + st.missing.join(', ') : '; all chapters are in place, ready for manual_render')
        return st
      }
    }),
    makeTool({
      name: 'manual_render',
      description: 'Render the current manual as a Markdown document and generate a PDF (headless printing with the local Edge), including the appendix reference cases and feedback. The PDF filename is simply the product name (e.g. "Alumni Mini Program.pdf"). Returns the md / pdf file paths and a pdfUrl that can be opened directly in a browser. Chapters that are not filled appear as "To be completed".',
      parameters: {
        type: 'object',
        properties: {
          manualId: { type: 'string', description: 'Manual id (optional; the current manual is located automatically)' },
          includePdf: { type: 'boolean', description: 'When false, generate Markdown only and skip the PDF' }
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
      description: 'Diagnostic tool: reports the host services visible to the plugin and its runtime state (for troubleshooting "fs unavailable"-style problems).',
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
