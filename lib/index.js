/**
 * dsh-reasoning-loop-guard —— 抑制 DeepSeek 思考模式的"复读循环"。
 *
 * ## 问题
 *
 * 思考模式（thinking）下，DeepSeek 系模型每一轮都会返回 `reasoning_content`
 * （思维链）。DSH 的适配器会把**历史所有轮次**的思维链原样回灌给下一次请求，
 * 于是模型每轮都读到自己的旧思维链。某轮出现"我需要再确认一次…"之后，下一轮
 * 在同一语义位置继续生成，形成正反馈自激——表现为思考无限复读、停不下来。
 *
 * 实测（官方 api.deepseek.com）确认了 400 边界：
 *   - 剥离**跨轮**历史 reasoning：200 通过
 *   - 剥离**当前轮**（最后一个用户提问之后）的 reasoning：400
 *     `The reasoning_content in the thinking mode must be passed back to the API.`
 *
 * 因此正确策略是：以"最后一个真实用户提问"为界，**之前的剥离、之后的保留**。
 *
 * ## 为什么是插件而不是改 node_modules
 *
 * `ctx.llm.stream()` 内部走 `ctx.waterfall(this, 'llm/stream', options, ...)`，
 * 这是**所有适配器（dsh-llm-deepseek 与 dsh-llm-pi-ai）的统一入口**。监听该
 * waterfall 即可在请求送达适配器之前改写 messages，从而：
 *   - 一份插件覆盖两条适配器路径，不依赖具体适配器实现；
 *   - 不侵入 DSH 打包产物，**升级不被覆盖**。
 *
 * ## 递归改写
 *
 * `llm/stream` 的 options 是深度冻结的（`deepFreeze`），waterfall 的 `next()`
 * 也不接收参数，所以无法就地改写。这里采用"返回新流"的写法：剥离后带着
 * Symbol 标记重新调用 `ctx.llm.stream()`，监听器见到标记即放行，不会递归。
 *
 * @module dsh-reasoning-loop-guard
 */

/** 稳定的 Cordis 插件名。 */
export const name = 'dsh-reasoning-loop-guard'

/**
 * 本插件只读 `llm` 服务。
 *
 * 刻意不 inject `settings`：即便设置服务缺席，剥离逻辑也应照常工作——
 * 判定所需的 provider/model 信息都在请求本身上。
 */
export const inject = ['llm']

/** 标记"这条请求已剥离过"，防止递归改写。 */
const STRIPPED = Symbol.for('dsh-reasoning-loop-guard.stripped')

/**
 * 判断一条消息是否携带"真实用户输入"。
 *
 * DSH 把工具结果放在 `user` 角色的消息里（内容块类型为 `tool-result`），
 * 所以只含工具结果的 user 消息**不算**新的用户轮次——否则边界会被误判到
 * 工具循环中间，导致本该保留的活跃轮 reasoning 被剥离而触发 400。
 *
 * @param message - 一条 harness 消息。
 * @returns 该消息是否构成一次真实的用户提问。
 */
export function isGenuineUserTurn (message) {
  if (message?.role !== 'user') return false
  const content = message.content
  if (!Array.isArray(content) || content.length === 0) return true
  return content.some((block) => block?.type !== 'tool-result')
}

/**
 * 找到最后一次真实用户提问的下标。
 *
 * 下标之后的 assistant 消息属于**活跃轮**，其 reasoning 必须保留；
 * 之前的属于已完成轮次，其 reasoning 可以安全剥离。
 *
 * @param messages - harness 消息数组。
 * @returns 最后一次真实用户消息的下标；没有则返回 -1（此时全部视为活跃轮）。
 */
export function lastUserTurnIndex (messages) {
  if (!Array.isArray(messages)) return -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isGenuineUserTurn(messages[index])) return index
  }
  return -1
}

/**
 * 判断这条路由是否属于 DeepSeek 系（需要剥离历史 reasoning）。
 *
 * 覆盖三类真实形态：
 *   - 官方适配器：provider `deepseek-official`，baseURL `api.deepseek.com`；
 *   - pi-ai 官方直连：provider `deepseek`；
 *   - 中转站：provider 名与 baseURL 都是自己的域名（如 `gm010` /
 *     `hk.ziyelian.site`），**只能靠 model id 识别**。实测这类中转站同样返回
 *     `reasoning_content`，回灌历史同样会引发复读。
 *
 * 非 DeepSeek 模型（GLM / Kimi / Qwen 等）不做任何改动：它们的 provider 可能
 * 依赖历史 reasoning 维持上下文，剥离属于越界行为。
 *
 * @param options - llm/stream 的请求选项。
 * @returns 是否应对该请求剥离历史 reasoning。
 */
export function shouldStrip (options) {
  if (!options || typeof options !== 'object') return false
  const provider = String(options.provider ?? '')
  const model = String(options.model ?? '')
  if (/deepseek/i.test(provider) || /deepseek/i.test(model)) return true
  // 官方适配器可能以自定义 provider 名注册，但 baseURL 指向官方域名。
  const baseURL = String(options.baseURL ?? '')
  return /deepseek\.com/i.test(baseURL)
}

/**
 * 剥离已完成轮次的 reasoning 块。
 *
 * 只处理 `assistant` 消息，且只移除 `reasoning` 类型的内容块；text 与
 * tool-call 块原样保留。活跃轮（下标大于边界）不做任何改动。
 *
 * 返回新数组与新消息对象，绝不修改入参——请求对象是冻结的，且同一份
 * messages 会被会话日志复用，就地改写会污染持久化记录。
 *
 * @param messages - harness 消息数组。
 * @returns 剥离后的新数组；无需改动时原样返回入参。
 */
export function stripHistoricalReasoning (messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  const boundary = lastUserTurnIndex(messages)
  let changed = false
  const result = messages.map((message, index) => {
    // 活跃轮（边界之后）原样保留：服务端强制要求它的 reasoning。
    if (index > boundary) return message
    if (message?.role !== 'assistant') return message
    const content = message.content
    if (!Array.isArray(content)) return message
    if (!content.some((block) => block?.type === 'reasoning')) return message
    changed = true
    return {
      ...message,
      content: content.filter((block) => block?.type !== 'reasoning'),
    }
  })
  return changed ? result : messages
}

/**
 * 挂载 waterfall 监听器。
 *
 * @param ctx - 携带 `llm` 服务的 Cordis 上下文。
 */
export function apply (ctx) {
  let strippedRequests = 0
  let lastLogAt = 0

  const dispose = ctx.on('llm/stream', (options, next) => {
    // 已处理过：放行，避免递归。
    if (options?.[STRIPPED] === true) return next()

    let stripped
    try {
      if (!shouldStrip(options)) return next()
      stripped = stripHistoricalReasoning(options.messages)
    } catch {
      // 任何判定失败都不应影响正常请求：退回未改写路径。
      return next()
    }
    if (stripped === options.messages) return next()

    const dropped = options.messages.reduce(
      (sum, m) => sum + (Array.isArray(m?.content) ? m.content.filter((b) => b?.type === 'reasoning').length : 0),
      0,
    ) - stripped.reduce(
      (sum, m) => sum + (Array.isArray(m?.content) ? m.content.filter((b) => b?.type === 'reasoning').length : 0),
      0,
    )

    strippedRequests += 1
    // 限频记日志：长会话里每个 step 都会命中，逐条记录会淹没日志。
    const now = Date.now()
    if (now - lastLogAt > 30000) {
      lastLogAt = now
      try {
        ctx.logger?.info?.(
          'dsh-reasoning-loop-guard: 已剥离历史思维链 %d 块（provider=%s model=%s，累计 %d 次请求）',
          dropped,
          options.provider,
          options.model,
          strippedRequests,
        )
      } catch {
        // 记不了日志就算了，绝不能因此中断请求。
      }
    }

    // 用同一份请求重建，带标记重新进入服务，由监听器放行到真正的适配器。
    return ctx.llm.stream({
      ...options,
      [STRIPPED]: true,
      messages: stripped,
    })
  })

  // 随 fiber 一起释放；同时把统计暴露给调试用。
  ctx.effect(() => () => {
    dispose()
  }, 'dsh-reasoning-loop-guard: 剥离跨轮历史思维链')

  return { dispose }
}
