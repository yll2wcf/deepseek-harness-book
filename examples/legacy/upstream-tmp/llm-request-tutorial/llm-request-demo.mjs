import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  LlmError,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

function textResponse(text) {
  const split = Math.ceil(text.length / 2)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: text.slice(0, split) },
    { type: 'text-delta', index: 0, text: text.slice(split) },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(rawCallId, name, args, text) {
  const id = ToolCallId(rawCallId)
  const json = JSON.stringify(args)
  const split = Math.ceil(json.length / 2)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id, name, argumentsDelta: json.slice(0, split) },
    { type: 'tool-call-delta', index: 1, id, argumentsDelta: json.slice(split) },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 30, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function fail(message, code) {
  return () => {
    throw new LlmError(message, code)
  }
}

class ScriptedAdapter extends LlmAdapter {
  requests = []

  constructor(script) {
    super()
    this.script = [...script]
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: `Mock ${model}`,
      context: { contextWindow: 8192 },
      defaultMaxTokens: 64,
      inputModalities: ['text'],
    })
  }

  async * stream(options) {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

function messageLabel(message) {
  const blocks = message.content.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return `${block.type}:${block.text}`
    if (block.type === 'tool-call') return `tool-call:${block.name}(${block.arguments})`
    if (block.type === 'tool-result') {
      const result = block.content.map(item => item.type === 'text' ? item.text : item.type).join('|')
      return `tool-result:${block.toolCallId}:${result}`
    }
    return block.type
  })
  return `${message.role} | ${blocks.join(' + ')}`
}

function chunkLabel(chunk) {
  if (chunk.type !== 'finish') return chunk.type
  return chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted'
    ? `finish:${chunk.reason.kind}:${chunk.reason.failure.code}`
    : `finish:${chunk.reason.kind}`
}

function section(title, value) {
  console.log(`\n## ${title}`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

const adapter = new ScriptedAdapter([
  textResponse('已收到第一条请求。'),
  toolCallResponse('quality-1', 'lookup_quality', { batch: 'B-17' }, '我先查询批次。'),
  textResponse('B-17 的不合格率为 3.2%，建议复检。'),
  fail('mock provider is busy', 'RATE_LIMIT'),
  textResponse('限流后重试成功。'),
  fail('mock credential rejected', 'AUTH'),
])

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
ctx.llm.registerAdapter(['mock'], adapter)

ctx.systemPrompt.variable('plant', () => '一号车间')
ctx.systemPrompt.section({
  name: 'tutorial:quality',
  order: 100,
  text: '你负责{{plant}}的质量异常分析。先引用已知数据，再给出建议。',
})

ctx.tools.register(defineTool({
  name: 'lookup_quality',
  description: '查询指定批次的质量数据。',
  parameters: {
    batch: { type: 'string', required: true, description: '批次编号' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  execute(args) {
    return Promise.resolve(`${args.batch}：抽检125件，不合格4件，不合格率3.2%`)
  },
}))

const recovery = []
const driverErrors = []
ctx.on('agent/request-error', async ({ turn, step, failure }, next) => {
  const action = failure.code === 'RATE_LIMIT' ? 'retry' : 'terminal'
  recovery.push({ turn, step, code: failure.code, action })
  return action === 'retry' ? { kind: 'retry' } : next()
})
ctx.on('agent/error', ({ turn, step, error }) => {
  driverErrors.push({
    turn,
    step,
    name: error instanceof Error ? error.name : typeof error,
    code: error instanceof LlmError ? error.code : 'UNKNOWN',
  })
})

const promptAssembly = await ctx.systemPrompt.assemble()
section('提示词组装', {
  sections: promptAssembly.sections.map(item => item.name),
  variables: promptAssembly.variables,
  rendered: renderPrompt(promptAssembly),
  tools: promptAssembly.tools.map(tool => ({ name: tool.name, required: tool.parameters.required })),
})

const agent = ctx.agentLoop.create(SessionId('week-05-agent'), {
  provider: 'mock',
  model: 'mock-quality',
})

async function send(text) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

await send('请确认系统提示词已经生效。')
await send('查询批次 B-17，并给出建议。')
await send('模拟一次可以恢复的限流错误。')
await send('模拟一次不能恢复的鉴权错误。')

section('Adapter 收到的6次请求', adapter.requests.map((request, index) => ({
  attempt: index + 1,
  provider: request.provider,
  model: request.model,
  maxTokens: request.maxTokens,
  frozen: Object.isFrozen(request) && Object.isFrozen(request.messages),
  system: request.system,
  tools: request.tools?.map(tool => tool.name) ?? [],
  messages: request.messages.map(messageLabel),
})))

const assistantChunks = agent.session.events.filter(event => event.type === 'assistant/chunk')
const assistantMessages = agent.session.events.filter(event => event.type === 'assistant/message')
const failedFinishes = assistantChunks.filter(event => {
  const chunk = event.data.chunk
  return chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
})
const recoveredMessage = assistantMessages.find(event => event.data.turn === 3)

section('流式分片与最终消息', {
  chunkCount: assistantChunks.length,
  chunkTypes: assistantChunks.map(event => `${event.seq}:${chunkLabel(event.data.chunk)}`),
  assistantMessages: assistantMessages.map(event => ({
    seq: event.seq,
    turn: event.data.turn,
    step: event.data.step,
    sourceEventSeqs: event.sourceEventSeqs,
    content: messageLabel(event.data.message),
  })),
  failedFinishSeqs: failedFinishes.map(event => event.seq),
  recoveredAnchorExcludesFailedFinish: recoveredMessage !== undefined
    && failedFinishes.every(event => !recoveredMessage.sourceEventSeqs?.includes(event.seq)),
})

section('请求快照', {
  headers: agent.session.events.flatMap(event => event.type === 'request/header'
    ? [{ seq: event.seq, reason: event.data.reason, header: event.data.header }]
    : []),
  contexts: agent.session.events.flatMap(event => event.type === 'request/context'
    ? [{ seq: event.seq, ...event.data }]
    : []),
})

section('工具与错误结算', {
  toolCalls: agent.session.events.filter(event => event.type === 'tool/call').length,
  toolResults: agent.session.events.flatMap(event => event.type === 'tool/result'
    ? [messageLabel(event.data.message)]
    : []),
  recovery,
  driverErrors,
  turnEnds: agent.session.events.flatMap(event => event.type === 'turn/end'
    ? [{ turn: event.data.turn, reason: event.data.reason }]
    : []),
})

section('关键数量', {
  requests: adapter.requests.length,
  requestHeaders: agent.session.events.filter(event => event.type === 'request/header').length,
  requestContexts: agent.session.events.filter(event => event.type === 'request/context').length,
  assistantChunks: assistantChunks.length,
  assistantMessages: assistantMessages.length,
  derivedMessages: agent.session.deriveMessages().length,
})
