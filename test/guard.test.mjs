/**
 * dsh-reasoning-loop-guard 单元测试。
 *
 * 重点覆盖两类容易出错的地方：
 *   1. 轮次边界判定——DSH 把工具结果放在 user 角色消息里，若把它当成新的
 *      用户轮次，边界会落到工具循环中间，导致本该保留的活跃轮 reasoning
 *      被剥离，服务端随即返回 400。
 *   2. provider 判定——中转站的 provider 名与 baseURL 都是自己的域名，
 *      只能靠 model id 识别；而 GLM/Kimi 等非 DeepSeek 模型必须完全不动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isGenuineUserTurn,
  lastUserTurnIndex,
  shouldStrip,
  stripHistoricalReasoning,
} from '../lib/index.js'

const text = (value) => ({ type: 'text', text: value })
const reasoning = (value) => ({ type: 'reasoning', text: value })
const toolResult = (id) => ({ type: 'tool-result', toolCallId: id, content: [text('ok')] })
const user = (...content) => ({ role: 'user', content })
const assistant = (...content) => ({
  role: 'assistant',
  content,
  source: { kind: 'model', provider: 'gm010', model: 'deepseek-v4.1-flash' },
})

const countReasoning = (messages) =>
  messages.reduce(
    (sum, m) => sum + (Array.isArray(m?.content) ? m.content.filter((b) => b.type === 'reasoning').length : 0),
    0,
  )

test('isGenuineUserTurn：纯文本 user 消息算真实轮次', () => {
  assert.equal(isGenuineUserTurn(user(text('你好'))), true)
})

test('isGenuineUserTurn：只含工具结果的 user 消息不算新轮次', () => {
  assert.equal(isGenuineUserTurn(user(toolResult('c1'))), false)
})

test('isGenuineUserTurn：文本与工具结果混合时算真实轮次', () => {
  assert.equal(isGenuineUserTurn(user(toolResult('c1'), text('继续'))), true)
})

test('isGenuineUserTurn：assistant 与 system 恒为 false', () => {
  assert.equal(isGenuineUserTurn(assistant(text('答复'))), false)
  assert.equal(isGenuineUserTurn({ role: 'system', content: [text('sys')] }), false)
})

test('lastUserTurnIndex：取最后一次真实用户提问', () => {
  const messages = [
    user(text('第一问')),
    assistant(reasoning('旧轮'), text('答')),
    user(text('第二问')),
    assistant(reasoning('活跃轮'), text('答')),
  ]
  assert.equal(lastUserTurnIndex(messages), 2)
})

test('lastUserTurnIndex：末尾是纯工具结果时，边界回到真实提问处', () => {
  const messages = [
    user(text('第一问')),
    assistant(reasoning('思考'), { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }),
    user(toolResult('c1')),
  ]
  assert.equal(lastUserTurnIndex(messages), 0)
})

test('lastUserTurnIndex：没有用户消息时返回 -1', () => {
  assert.equal(lastUserTurnIndex([assistant(reasoning('独思'))]), -1)
})

test('shouldStrip：官方与中转站的 DeepSeek 模型都命中', () => {
  assert.equal(shouldStrip({ provider: 'deepseek-official', model: 'deepseek-flash' }), true)
  assert.equal(shouldStrip({ provider: 'deepseek', model: 'deepseek-v4-pro' }), true)
  // 中转站：provider 名与 baseURL 都不是 deepseek，只能靠 model id 识别。
  assert.equal(shouldStrip({ provider: 'gm010', model: 'deepseek-v4.1-flash' }), true)
  assert.equal(shouldStrip({ provider: 'ds001', model: 'deepseek-v4.1-flash' }), true)
  // baseURL 指向官方域名。
  assert.equal(shouldStrip({ provider: 'custom', model: 'x', baseURL: 'https://api.deepseek.com/v1' }), true)
})

test('shouldStrip：非 DeepSeek 模型一律不动', () => {
  assert.equal(shouldStrip({ provider: 'dd', model: 'glm-5.3' }), false)
  assert.equal(shouldStrip({ provider: 'g', model: 'kimi-k3' }), false)
  assert.equal(shouldStrip({ provider: 'gm', model: 'qwen3.8-max' }), false)
  assert.equal(shouldStrip(undefined), false)
})

test('stripHistoricalReasoning：剥离旧轮、保留活跃轮', () => {
  const messages = [
    user(text('第一问')),
    assistant(reasoning('旧轮思考'), text('答一')),
    user(text('第二问')),
    assistant(reasoning('活跃轮思考'), { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }),
  ]
  const out = stripHistoricalReasoning(messages)
  assert.equal(countReasoning(out), 1, '只应保留活跃轮那一条')
  assert.equal(out[3].content[0].type, 'reasoning', '保留的应是活跃轮的 reasoning')
  assert.equal(out[3].content[0].text, '活跃轮思考')
})

test('stripHistoricalReasoning：不改动入参（请求对象是冻结的）', () => {
  const messages = [user(text('问')), assistant(reasoning('思考'), text('答'))]
  const before = countReasoning(messages)
  stripHistoricalReasoning(messages)
  assert.equal(countReasoning(messages), before, '原始数组必须保持原样')
})

test('stripHistoricalReasoning：无需改动时返回同一引用', () => {
  const messages = [user(text('问')), assistant(text('答'))]
  assert.equal(stripHistoricalReasoning(messages), messages)
})

test('stripHistoricalReasoning：活跃轮内的多条 assistant 全部保留', () => {
  // 服务端要求活跃轮内每一条 assistant 都带 reasoning，漏一条就 400。
  const messages = [
    user(text('问')),
    assistant(reasoning('活跃一'), { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }),
    user(toolResult('c1')),
    assistant(reasoning('活跃二'), { type: 'tool-call', id: 'c2', name: 'x', arguments: '{}' }),
  ]
  const out = stripHistoricalReasoning(messages)
  assert.equal(countReasoning(out), 2, '活跃轮两条都必须保留')
})

test('stripHistoricalReasoning：无用户消息时全部保留（防 400）', () => {
  const messages = [assistant(reasoning('独思'), text('答'))]
  const out = stripHistoricalReasoning(messages)
  assert.equal(countReasoning(out), 1)
})

test('stripHistoricalReasoning：text 与 tool-call 块不受影响', () => {
  const messages = [
    user(text('问')),
    assistant(reasoning('旧思考'), text('答复'), { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }),
    user(text('再问')),
  ]
  const out = stripHistoricalReasoning(messages)
  assert.equal(out[1].content.length, 2, 'reasoning 移除后应剩 text 与 tool-call')
  assert.deepEqual(
    out[1].content.map((b) => b.type),
    ['text', 'tool-call'],
  )
})

test('stripHistoricalReasoning：空数组与非法输入安全返回', () => {
  assert.deepEqual(stripHistoricalReasoning([]), [])
  assert.equal(stripHistoricalReasoning(undefined), undefined)
})
