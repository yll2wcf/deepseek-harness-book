import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

function textResponse(text) {
  const split = Math.ceil(text.length / 2)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: text.slice(0, split) },
    { type: 'text-delta', index: 0, text: text.slice(split) },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(rawCallId, name, args, text) {
  const id = ToolCallId(rawCallId)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
    { type: 'usage', usage: { inputTokens: 18, outputTokens: 6 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
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
      context: { contextWindow: 4096 },
      inputModalities: ['text'],
    })
  }

  async * stream(options) {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    const chunks = Array.isArray(entry) ? entry : entry.hangAfter
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
    if (!Array.isArray(entry)) {
      if (options.signal === undefined) throw new Error('hanging response requires a signal')
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
      options.signal.throwIfAborted()
    }
  }
}

async function createHarness(script) {
  const adapter = new ScriptedAdapter(script)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

function message(text, source = { kind: 'user' }) {
  return createUserMessage({ content: [{ type: 'text', text }], source })
}

function blockText(block) {
  if (block.type === 'text' || block.type === 'reasoning') return block.text
  if (block.type === 'tool-call') return `${block.name}(${block.arguments})`
  if (block.type === 'tool-result') {
    return block.content.map(item => item.type === 'text' ? item.text : item.type).join('|')
  }
  return block.type
}

function messageText(item) {
  return item.content.map(blockText).join(' + ')
}

function sourceText(source) {
  if (source.kind === 'plugin') return `plugin:${source.plugin}`
  if (source.kind === 'tool') return `tool:${source.callId}`
  return source.kind
}

function eventLabel(event) {
  if (event.type === 'assistant/chunk') return `${event.seq}:assistant/chunk`
  if (event.type === 'agent/inbox/spliced') {
    const removed = event.data.removedCount ?? 0
    const outcome = event.data.outcome === undefined ? '' : `:${event.data.outcome}`
    return `${event.seq}:inbox/${event.data.target} +${event.data.inserted.length} -${removed}${outcome}`
  }
  if (event.type === 'turn/start' || event.type === 'step/start' || event.type === 'step/end') {
    return `${event.seq}:${event.type} ${event.data.turn}${'step' in event.data ? `.${event.data.step}` : ''}`
  }
  if (event.type === 'turn/end') return `${event.seq}:turn/end ${event.data.turn}:${event.data.reason.kind}`
  if (event.type === 'user/message') return `${event.seq}:user/message ${sourceText(event.data.source)}:${messageText(event.data)}`
  if (event.type === 'assistant/message') {
    return `${event.seq}:assistant/message ${event.data.interrupted === true ? 'interrupted:' : ''}${messageText(event.data.message)}`
  }
  if (event.type === 'tool/call') return `${event.seq}:tool/call ${event.data.name}`
  if (event.type === 'tool/result') return `${event.seq}:tool/result ${messageText(event.data.message)}`
  return `${event.seq}:${event.type}`
}

function eventTrace(agent) {
  const labels = agent.session.events.map(eventLabel)
  const compressed = []
  for (const label of labels) {
    const isChunk = label.endsWith(':assistant/chunk')
    const previous = compressed.at(-1)
    if (isChunk && previous?.kind === 'chunks') {
      previous.last = Number(label.split(':', 1)[0])
      previous.count += 1
    } else if (isChunk) {
      compressed.push({ kind: 'chunks', first: Number(label.split(':', 1)[0]), last: Number(label.split(':', 1)[0]), count: 1 })
    } else {
      compressed.push({ kind: 'label', value: label })
    }
  }
  return compressed.map(item => item.kind === 'label'
    ? item.value
    : `${item.first}～${item.last}:assistant/chunk ×${item.count}`)
}

function observeAgent(ctx, agent) {
  const live = []
  ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent) live.push(`status:${status}`)
  })
  ctx.on('agent/inbox/inserted', ({ agent: subject, message: item }) => {
    if (subject === agent) live.push(`inserted:${messageText(item)}`)
  })
  ctx.on('agent/inbox/claimed', ({ agent: subject, message: item, turn }) => {
    if (subject === agent) live.push(`claimed@turn${turn}:${messageText(item)}`)
  })
  ctx.on('agent/inbox/discarded', ({ agent: subject, message: item }) => {
    if (subject === agent) live.push(`discarded:${messageText(item)}`)
  })
  ctx.on('agent/turn-stopping', ({ agent: subject, turn }) => {
    if (subject === agent) live.push(`turn-stopping:${turn}`)
  })
  return live
}

function turns(agent) {
  return agent.session.events.flatMap(event => event.type === 'turn/end'
    ? [{ turn: event.data.turn, reason: event.data.reason }]
    : [])
}

function steps(agent) {
  return agent.session.events.flatMap(event => event.type === 'step/start'
    ? [`${event.data.turn}.${event.data.step}`]
    : [])
}

function requestMessages(adapter) {
  return adapter.requests.map((request, index) => ({
    request: index + 1,
    messages: request.messages.map(item => `${item.role}:${messageText(item)}`),
  }))
}

function waitForSessionEvent(ctx, session, predicate) {
  return new Promise(resolve => {
    const dispose = ctx.on('session/event', (subject, event) => {
      if (subject !== session || !predicate(event)) return
      dispose()
      resolve(event)
    })
  })
}

function section(title, value) {
  console.log(`\n## ${title}`)
  console.log(JSON.stringify(value, null, 2))
}

async function directAnswerScenario() {
  const { ctx, adapter } = await createHarness([textResponse('直接回答完成。')])
  const agent = ctx.agentLoop.create(SessionId('week-06-direct'), { provider: 'mock', model: 'mock-loop' })
  const live = observeAgent(ctx, agent)

  agent.inject(message('库存快照：轴承剩余 18 件。', { kind: 'plugin', plugin: 'inventory-watcher' }))
  const staged = {
    status: agent.status,
    turns: turns(agent).length,
    requests: adapter.requests.length,
    nextStep: agent.inbox.nextStep.map(messageText),
  }
  agent.followup(message('告诉我当前库存。'))
  await agent.whenIdle()

  assert.deepEqual(staged, {
    status: 'idle',
    turns: 0,
    requests: 0,
    nextStep: ['库存快照：轴承剩余 18 件。'],
  })
  assert.deepEqual(steps(agent), ['1.1'])
  assert.equal(adapter.requests.length, 1)

  const result = {
    stagedAfterIdleInject: staged,
    turns: turns(agent),
    steps: steps(agent),
    requests: requestMessages(adapter),
    live,
    durableTrace: eventTrace(agent),
  }
  await ctx.fiber.dispose()
  return result
}

async function rejectedStepScenario() {
  const { ctx, adapter } = await createHarness([])
  const agent = ctx.agentLoop.create(SessionId('week-06-rejected'), { provider: 'mock', model: 'mock-loop' })
  const live = observeAgent(ctx, agent)
  ctx.on('agent/pre-step', ({ agent: subject }, next) => subject === agent
    ? Promise.resolve({ kind: 'reject' })
    : next())

  agent.followup(message('这条输入会被准入策略拒绝。'))
  await agent.whenIdle()

  assert.equal(adapter.requests.length, 0)
  assert.deepEqual(steps(agent), [])
  assert.equal(turns(agent)[0]?.reason.kind, 'blocked')

  const result = {
    turns: turns(agent),
    steps: steps(agent),
    adapterRequests: adapter.requests.length,
    live,
    durableTrace: eventTrace(agent),
  }
  await ctx.fiber.dispose()
  return result
}

async function toolAndSteeringScenario() {
  const { ctx, adapter } = await createHarness([
    toolCallResponse('stock-1', 'lookup_stock', { sku: 'A-17' }, '我先查询库存。'),
    textResponse('A-17 库存 18 件；已按补充要求给出简短建议。'),
  ])
  const agent = ctx.agentLoop.create(SessionId('week-06-tools'), { provider: 'mock', model: 'mock-loop' })
  const live = observeAgent(ctx, agent)
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()

  ctx.tools.register(defineTool({
    name: 'lookup_stock',
    description: '查询物料库存。',
    parameters: { sku: { type: 'string', required: true, description: '物料编码' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      started.resolve(args.sku)
      await release.promise
      return `${args.sku}：库存18件，安全库存12件`
    },
  }))

  agent.followup(message('查询 A-17 库存并给建议。'))
  assert.equal(await started.promise, 'A-17')
  agent.inject(message('补充背景：明天计划领用 5 件。', { kind: 'plugin', plugin: 'planning-board' }))
  agent.steer(message('建议控制在一句话。', { kind: 'plugin', plugin: 'operator' }))
  release.resolve()
  await agent.whenIdle()

  assert.deepEqual(steps(agent), ['1.1', '1.2'])
  assert.equal(turns(agent).length, 1)
  assert.equal(adapter.requests.length, 2)
  const secondRequest = JSON.stringify(adapter.requests[1].messages)
  assert.match(secondRequest, /补充背景：明天计划领用 5 件/)
  assert.match(secondRequest, /建议控制在一句话/)
  const toolResult = agent.session.events.find(event => event.type === 'tool/result')
  const injected = agent.session.events.find(event => event.type === 'user/message'
    && event.data.source.kind === 'plugin' && event.data.source.plugin === 'planning-board')
  assert.ok(toolResult !== undefined && injected !== undefined && toolResult.seq < injected.seq)

  const result = {
    turns: turns(agent),
    steps: steps(agent),
    requests: requestMessages(adapter),
    toolResultBeforeInjectedContext: toolResult.seq < injected.seq,
    live,
    durableTrace: eventTrace(agent),
  }
  await ctx.fiber.dispose()
  return result
}

async function cancellationScenario() {
  const { ctx, adapter } = await createHarness([
    {
      hangAfter: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '已经处理到一半' },
      ],
    },
    textResponse('取消后的新任务正常完成。'),
  ])
  const agent = ctx.agentLoop.create(SessionId('week-06-cancel'), { provider: 'mock', model: 'mock-loop' })
  const live = observeAgent(ctx, agent)
  const firstDelta = waitForSessionEvent(
    ctx,
    agent.session,
    event => event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta',
  )

  agent.followup(message('开始一个可以取消的长任务。'))
  await firstDelta
  agent.followup(message('排队但会被取消的后续任务。'))
  agent.inject(message('排队但会被取消的上下文。', { kind: 'plugin', plugin: 'watcher' }))
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()

  const interrupted = agent.session.events.find(event => event.type === 'assistant/message'
    && event.data.interrupted === true)
  assert.equal(interrupted?.type === 'assistant/message' ? messageText(interrupted.data.message) : undefined, '已经处理到一半')
  assert.deepEqual(agent.inbox.nextTurn, [])
  assert.deepEqual(agent.inbox.nextStep, [])
  assert.equal(turns(agent)[0]?.reason.kind, 'aborted')

  const firstTurnTrace = eventTrace(agent)
  agent.followup(message('取消已经结算，请执行新的任务。'))
  await agent.whenIdle()

  assert.deepEqual(steps(agent), ['1.1', '2.1'])
  assert.equal(turns(agent)[1]?.reason.kind, 'completed')
  assert.equal(adapter.requests.length, 2)
  assert.match(JSON.stringify(adapter.requests[1].messages), /已经处理到一半/)

  const result = {
    afterCancellation: {
      interruptedMessage: interrupted?.type === 'assistant/message'
        ? {
          text: messageText(interrupted.data.message),
          interrupted: interrupted.data.interrupted,
          sourceEventSeqs: interrupted.sourceEventSeqs,
        }
        : undefined,
      pendingNextTurn: 0,
      pendingNextStep: 0,
      firstTurn: turns(agent)[0],
      durableTrace: firstTurnTrace,
    },
    afterFreshFollowup: {
      turns: turns(agent),
      steps: steps(agent),
      requests: requestMessages(adapter),
    },
    live,
  }
  await ctx.fiber.dispose()
  return result
}

section('路径一：idle inject 不唤醒，followup 打开单 Step Turn', await directAnswerScenario())
section('路径二：pre-step 拒绝后，Turn 以零 Step 结算', await rejectedStepScenario())
section('路径三：工具、inject 与 steer 共同推动第二个 Step', await toolAndSteeringScenario())
section('路径四：取消保留可见前缀，清空排队工作，后来任务仍可运行', await cancellationScenario())
