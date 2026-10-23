// 端到端验证：无 web 服务时，GitHub 内置检索能否兜底。
import * as plugin from 'file:///E:/dsh/agent/plugins/dsh-plugin-product-manual/lib/index.js'

const files = new Map()
const fsStub = {
  async resolve(p) { return { path: String(p).replace(/\\/g, '/') } },
  processPath(t) { return t.path },
  fileUrl(t) { return 'file:///' + t.path },
  async stat(t) { return files.has(t.path) ? { size: files.get(t.path).length } : undefined },
  async readText(t) { return files.get(t.path) },
  async writeText(t, text) { files.set(t.path, text); return {} },
  async readBytes() { throw new Error('unsupported') },
  async listDir() { return [] }
}

const registered = []
const fakeCtx = {
  get(n) {
    if (n === 'tools') return { register(tool) { registered.push(tool); return () => {} } }
    if (n === 'sandboxPolicy') return { resolve() { return { workspaceRoot: 'C:/tmp/test-ws', mode: 'workspace-write' } } }
    if (n === 'fs') return fsStub
    if (n === 'systemPrompt') return { section() { return () => {} } }
    if (n === 'webServer') return { register() { return () => {} } }
    if (n === 'timer') return { timeout() { return Promise.resolve() } }
    return undefined // web / subprocess 均缺失：模拟"没有平台搜索、没有 subprocess"
  },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} }
}

plugin.apply(fakeCtx)
console.log('tools:', registered.map((t) => t.name).join(','))
const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const exec = { signal: undefined, agent: undefined }

const s = await byName.manual_start.execute({ name: '测试产品', positioning: '一句话定位' }, exec)
console.log('start:', s.manualId, '|', s.filledCount + '/' + s.totalSections)

const r = await byName.manual_research.execute({ query: '校友 小程序', sources: ['github'], note: '测试兜底' }, exec)
console.log('research:', JSON.stringify({ added: r.added, total: r.total, message: String(r.message || '').slice(0, 120) }))
if (r.results && r.results[0]) console.log('first:', r.results[0].title, '|', r.results[0].url)

const st = await byName.manual_status.execute({}, exec)
console.log('status referenceCount:', st.referenceCount)
