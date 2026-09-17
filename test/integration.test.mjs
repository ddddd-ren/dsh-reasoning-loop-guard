/**
 * 集成测试：用真实的 dsh-llm LlmRuntime 验证 llm/stream 拦截确实生效。
 *
 * 这是本插件成立的前提——如果 waterfall 拦截拿不到 messages，或改写后的
 * 请求送不到适配器，插件就是空转。所以这里不 mock LlmRuntime，而是装载
 * 真实实现，配一个只记录入参的 mock adapter。
 *
 * 依赖 dsh 安装目录下的包。通过环境变量 DSH_LLM_PATH 指定 dsh-llm 的
 * lib/index.js 路径；找不到就跳过（不让 CI 因环境缺失而红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DSH_LLM =
  process.env.DSH_LLM_PATH ??
  'C:/Users/asus/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
const CORDIS =
  process.env.DSH_CORDIS_PATH ??
  'C:/Users/asus/.dsh/profiles/node_modules/@deepseek-ai/cordis/lib/index.js'

const available = existsSync(DSH_LLM) && existsSync(CORDIS)

test('集成：llm/stream 拦截可剥离历史 reasoning', { skip: available ? false : '未找到 dsh-llm' }, async () => {
  const { Context } = await import(pathToFileURL(CORDIS).href)
  const llmMod = await import(pathToFileURL(DSH_LLM).href)
  const LlmRuntime = llmMod.default
  const LlmAdapter = llmMod.LlmAdapter

  const app = new Context()

  class MockAdapter extends LlmAdapter {
    constructor() {
      super()
      this.seen = []
    }
    providerInfo(provider) {
      return { id: provider, name: provider }
    }
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: model })
    }
    async *stream(options) {
      this.seen.push(options.messages)
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  const adapter = new MockAdapter()
  const runtime = new LlmRuntime(app, {})
  runtime.registerAdapter(['gm010'], adapter)

  // 复用插件本体，而不是复制一份剥离逻辑。
  const { apply, stripHistoricalReasoning, shouldStrip } = await import('../lib/index.js')
  const STRIPPED = Symbol.for('dsh-reasoning-loop-guard.stripped')
  let hits = 0

  app.on('llm/stream', (options, next) => {
    if (options?.[STRIPPED] === true) return next()
    if (!shouldStrip(options)) return next()
    const stripped = stripHistoricalReasoning(options.messages)
    if (stripped === options.messages) return next()
    hits += 1
    return app.llm.stream({ ...options, [STRIPPED]: true, messages: stripped })
  })

  const messages = [
    { role: 'user', content: [{ type: 'text', text: '第一问' }] },
    {
      role: 'assistant',
      content: [{ type: 'reasoning', text: '旧轮思考' }, { type: 'text', text: '答复' }],
      source: { kind: 'model', provider: 'gm010', model: 'deepseek-v4.1-flash' },
    },
    { role: 'user', content: [{ type: 'text', text: '第二问' }] },
  ]

  const chunks = []
  for await (const chunk of app.llm.stream({
    provider: 'gm010',
    model: 'deepseek-v4.1-flash',
    messages,
  })) {
    chunks.push(chunk)
  }

  assert.equal(hits, 1, '拦截应恰好触发一次，不得递归')
  assert.equal(chunks.at(-1)?.type, 'finish', '流应以 finish 正常收尾')
  assert.equal(adapter.seen.length, 1, '适配器应恰好被调用一次')

  const delivered = adapter.seen[0]
  const reasoningCount = delivered.reduce(
    (sum, m) => sum + (m.content ?? []).filter((b) => b.type === 'reasoning').length,
    0,
  )
  assert.equal(reasoningCount, 0, '适配器收到的消息不应含历史 reasoning')

  // 原始请求对象必须保持原样（它是会话日志的一部分）。
  const originalReasoning = messages.reduce((sum, m) => sum + m.content.filter((b) => b.type === 'reasoning').length, 0)
  assert.equal(originalReasoning, 1, '原始 messages 不得被就地改写')

  void apply
})

test('集成：非 DeepSeek 路由不被拦截', { skip: available ? false : '未找到 dsh-llm' }, async () => {
  const { Context } = await import(pathToFileURL(CORDIS).href)
  const llmMod = await import(pathToFileURL(DSH_LLM).href)
  const LlmRuntime = llmMod.default
  const LlmAdapter = llmMod.LlmAdapter

  const app = new Context()

  class MockAdapter extends LlmAdapter {
    constructor() {
      super()
      this.seen = []
    }
    providerInfo(provider) {
      return { id: provider, name: provider }
    }
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: model })
    }
    async *stream(options) {
      this.seen.push(options.messages)
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  const adapter = new MockAdapter()
  const runtime = new LlmRuntime(app, {})
  runtime.registerAdapter(['dd'], adapter)

  const { shouldStrip, stripHistoricalReasoning } = await import('../lib/index.js')
  const STRIPPED = Symbol.for('dsh-reasoning-loop-guard.stripped')
  let hits = 0

  app.on('llm/stream', (options, next) => {
    if (options?.[STRIPPED] === true) return next()
    if (!shouldStrip(options)) return next()
    const stripped = stripHistoricalReasoning(options.messages)
    if (stripped === options.messages) return next()
    hits += 1
    return app.llm.stream({ ...options, [STRIPPED]: true, messages: stripped })
  })

  const messages = [
    { role: 'user', content: [{ type: 'text', text: '第一问' }] },
    {
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'GLM 的思考' }, { type: 'text', text: '答复' }],
      source: { kind: 'model', provider: 'dd', model: 'glm-5.3' },
    },
    { role: 'user', content: [{ type: 'text', text: '第二问' }] },
  ]

  for await (const _ of app.llm.stream({ provider: 'dd', model: 'glm-5.3', messages })) {
    // 仅消费流
  }

  assert.equal(hits, 0, 'GLM 路由不应触发剥离')
  const reasoningCount = adapter.seen[0].reduce(
    (sum, m) => sum + (m.content ?? []).filter((b) => b.type === 'reasoning').length,
    0,
  )
  assert.equal(reasoningCount, 1, 'GLM 的历史 reasoning 必须原样保留')
})
