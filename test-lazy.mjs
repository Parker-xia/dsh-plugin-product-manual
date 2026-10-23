// Simulates "host composition load order is not guaranteed": fs/sandboxPolicy are absent at apply time, available only at execution time.
import * as plugin from './lib/index.js'

const files = new Map()
const services = new Map() // starts empty: fs and friends are not ready yet

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
    // Real cordis: injected services appear on the callback ctx; this is a minimal mock.
    const injected = {
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
      systemPrompt: { section() { return () => {} } },
      webServer: { register() { return () => {} } }
    }
    cb(injected)
  }
}

plugin.apply(fakeCtx) // fs is undefined at this point

// Services become ready "later"
services.set('fs', fsStub)
services.set('sandboxPolicy', { resolve() { return { workspaceRoot: 'C:/tmp/lazy-ws', mode: 'workspace-write' } } })

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const exec = { signal: undefined, agent: undefined }

const s = await byName.manual_start.execute({ name: 'Lazy Load Test', positioning: 'Works even when services arrive late' }, exec)
console.log('start:', s.manualId, '|', s.filledCount + '/' + s.totalSections)
const st = await byName.manual_status.execute({}, exec)
console.log('status manualId:', st.manualId, '| hasState:', st.hasState)
console.log('OK: lazy service resolution at execution time works')
