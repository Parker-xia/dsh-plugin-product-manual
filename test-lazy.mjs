// 模拟"宿主组合装载顺序不确定"：apply 时 fs/sandboxPolicy 尚不存在，执行时才可用。
import * as plugin from 'file:///E:/dsh/agent/plugins/dsh-plugin-product-manual/lib/index.js'

const files = new Map()
const services = new Map() // 初始为空：fs 等还没就绪

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
    return services.get(n)
  },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  inject(_names, cb) {
    // 真实 cordis：注入服务出现在回调 ctx 上；这里给一个最小 mock
    const injected = {
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
      systemPrompt: { section() { return () => {} } },
      webServer: { register() { return () => {} } }
    }
    cb(injected)
  }
}

plugin.apply(fakeCtx) // 此刻 fs 为 undefined

// 服务"稍后"就绪
services.set('fs', fsStub)
services.set('sandboxPolicy', { resolve() { return { workspaceRoot: 'C:/tmp/lazy-ws', mode: 'workspace-write' } } })

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const exec = { signal: undefined, agent: undefined }

const s = await byName.manual_start.execute({ name: '懒加载测试', positioning: '服务晚到也能用' }, exec)
console.log('start:', s.manualId, '|', s.filledCount + '/' + s.totalSections)
const st = await byName.manual_status.execute({}, exec)
console.log('status manualId:', st.manualId, '| hasState:', st.hasState)
console.log('OK: 执行时惰性解析服务成功')
