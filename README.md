# dsh-reasoning-loop-guard

DSH 插件：抑制 DeepSeek 思考模式的**复读循环**。

> 症状：开启思考模式后，模型在思维链里反复绕同一句话（"我需要再确认一次…"
> 无限重复），思考停不下来，必须手动打断。

---

## 问题是什么

思考模式下 DeepSeek 系模型每一轮都会返回 `reasoning_content`（思维链）。
DSH 的适配器会把**历史所有轮次**的思维链原样回灌给下一次请求，于是模型每轮
都读到自己的旧思维链。某轮出现自我怀疑式的句子后，下一轮在同一语义位置继续
生成，形成正反馈自激——这就是复读循环。

附带代价：历史思维链会持续撑大请求前缀，并破坏 KV Cache 的字节级复用。

### 官方文档的说法并不精确

[DeepSeek 思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)
说携带 `tools` 时"必须完整回传 `reasoning_content`"。实测（官方
`api.deepseek.com`）表明真实约束更窄：

| 场景 | 结果 |
| --- | --- |
| 剥离**跨轮**历史 reasoning，保留当前轮 | **200 通过** |
| 剥离**当前轮**（最后一个用户提问之后）的 reasoning | **400** `The reasoning_content in the thinking mode must be passed back to the API.` |
| 请求末尾是 user（历史全剥离） | **200 通过** |

所以正确策略是：**以最后一个真实用户提问为界，之前的剥离、之后的保留。**
按文档字面全保留则治不了复读；激进全剥离则必然 400。

---

## 插件做什么

在 `llm/stream` 这个**所有适配器共用的入口**上挂一个 waterfall 监听器，
在请求送达适配器之前，把已完成轮次的 `reasoning` 内容块摘掉。

```
agent-loop ──► ctx.llm.stream(request)
                      │
                      ▼
              ctx.waterfall('llm/stream', options, …)   ◄── 本插件在此剥离
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
  dsh-llm-deepseek         dsh-llm-pi-ai
   （官方直连）              （中转站 / 多 provider）
```

一份插件同时覆盖两条适配器路径，**不修改 DSH 打包产物**，因此升级不会被覆盖。

### 两个容易踩错的细节

**其一，工具结果不算新的用户轮次。** DSH 把工具结果放在 `user` 角色的消息里
（内容块类型为 `tool-result`）。若把它当成新的用户提问，边界会落到工具循环
中间，导致本该保留的活跃轮 reasoning 被剥离，服务端立刻返回 400。插件因此
只把"含非 `tool-result` 块"的 user 消息视为真实轮次。

**其二，中转站只能靠 model id 识别。** 官方适配器的 provider 是
`deepseek-official`、baseURL 是 `api.deepseek.com`，很好认；但中转站（如
`gm010` + `hk.ziyelian.site`）provider 名与域名都是自己的，两者都不匹配
`deepseek`。实测这类中转站同样返回 `reasoning_content`，回灌历史同样会复读，
所以判定必须补上 model id 这一路。

非 DeepSeek 模型（GLM / Kimi / Qwen 等）**完全不做改动**——它们的 provider
可能依赖历史 reasoning 维持上下文，剥离属于越界行为。

---

## 安装

```bash
cd ~/.dsh/profiles/desktop
pnpm add github:ddddd-ren/dsh-reasoning-loop-guard
```

然后把插件加进该 profile `package.json` 的 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-reasoning-loop-guard"
      ],
      "patchReload": "live"
    }
  }
}
```

重启 DSH 生效。

### 本地开发

```bash
pnpm add file:C:/Users/<you>/dsh-plugins/dsh-reasoning-loop-guard
```

---

## 配置

**无需配置。** 插件自动识别 DeepSeek 系路由，其余路由一概不动。

---

## 验证

```bash
node --test "test/*.test.mjs"
```

18 项测试，含用真实 `dsh-llm` `LlmRuntime` 装载的集成测试（验证拦截确实
把剥离后的 messages 送到了适配器，且不递归、不改写入参）。

集成测试需要能找到 `dsh-llm`；找不到时自动跳过，可用环境变量指定：

```bash
DSH_LLM_PATH=/path/to/dsh-llm/lib/index.js node --test "test/*.test.mjs"
```

### 确认它在工作

插件命中时会打一条限频日志（30 秒内最多一条）：

```
dsh-reasoning-loop-guard: 已剥离历史思维链 4 块（provider=gm010 model=deepseek-v4.1-flash，累计 7 次请求）
```

---

## 已知边界

- **只治"历史回灌"这一条成因。** 如果模型在**同一轮内**自己生成出病态重复
  （而非被历史思维链诱发），本插件管不了——那需要流式层的周期检测主动打断。
- **依赖 `llm/stream` waterfall 这一未文档化的内部扩展点。** 它在
  `dsh-llm` 的 `streamWithRegistration()` 里，DSH 大版本升级后若改名，插件会
  静默失效（不报错，只是不再剥离）。升级后建议看一眼上面的日志确认仍在工作。
- **活跃轮的思维链仍然完整回传**，这是服务端的硬要求，也是 KV Cache 的代价。

---

## 工作原理（实现细节）

`llm/stream` 的 options 是**深度冻结**的（`deepFreeze`），waterfall 的 `next()`
也不接收参数，所以无法就地改写。插件采用"返回新流"的写法：

```js
ctx.on('llm/stream', (options, next) => {
  if (options[STRIPPED]) return next()          // 已处理，放行
  const stripped = stripHistoricalReasoning(options.messages)
  if (stripped === options.messages) return next()
  return ctx.llm.stream({ ...options, [STRIPPED]: true, messages: stripped })
})
```

`STRIPPED` 是一个模块级 `Symbol`，保证重入时走放行分支，不会无限递归。

剥离时**新建数组与新消息对象**，绝不就地修改：请求对象是会话日志的一部分，
就地改写会污染持久化记录。

---

## License

MIT
