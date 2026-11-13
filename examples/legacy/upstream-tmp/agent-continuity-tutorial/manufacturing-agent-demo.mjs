import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'

const recoveryRoot = resolve('tmp/agent-continuity-tutorial/manufacturing-runtime')

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 16, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallsResponse(calls) {
  const chunks = []
  calls.forEach((call, index) => {
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(call.id),
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 20, outputTokens: calls.length * 4 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

class ScriptedAdapter extends LlmAdapter {
  constructor(script) {
    super()
    this.script = [...script]
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: `Mock ${model}`,
      context: { contextWindow: 8_192 },
      inputModalities: ['text'],
    })
  }

  async * stream(options) {
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

function stringTool({ name, description, parameters = {}, execute }) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute,
  })
}

function userMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

async function mountHarness(script, options = {}) {
  const ctx = new Context()
  const adapter = new ScriptedAdapter(script)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (options.approval === true) await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.persistenceRoot !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, {
      root: options.persistenceRoot,
      compression: 'none',
    })
  }
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function newAgent(ctx, id) {
  return ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock-manufacturing' })
}

async function runTurn(agent, text) {
  agent.followup(userMessage(text))
  await agent.whenIdle()
}

function toolResults(agent) {
  const calls = new Map(agent.session.events.flatMap(event => event.type === 'tool/call'
    ? [[String(event.data.callId), event.data.name]]
    : []))
  return agent.session.events.flatMap(event => {
    if (event.type !== 'tool/result') return []
    const callId = String(event.data.message.source.callId)
    const block = event.data.message.content.find(item => item.type === 'tool-result')
    assert.notEqual(block, undefined)
    return [{
      callId,
      name: calls.get(callId),
      isError: block.isError,
      code: event.data.error?.code,
    }]
  })
}

function turnReason(agent) {
  const end = agent.session.events.findLast(event => event.type === 'turn/end')
  return end?.type === 'turn/end' ? end.data.reason.kind : undefined
}

async function successCase() {
  const ctx = await mountHarness([
    toolCallsResponse([{ id: 'read-success', name: 'read_equipment_state', arguments: { equipment: 'P-101' } }]),
    textResponse('建议先隔离 P-101，再由人员确认是否创建维修工单。'),
  ])
  const agent = newAgent(ctx, 'manufacturing-success')
  let reads = 0
  ctx.tools.register(stringTool({
    name: 'read_equipment_state',
    description: 'Read one deterministic equipment status record.',
    parameters: { equipment: { type: 'string', required: true } },
    async execute(args) {
      reads += 1
      return `${args.equipment}: vibration=8.2mm/s, state=warning`
    },
  }))
  await runTurn(agent, '分析 P-101 振动报警，但不要直接执行写操作。')
  const results = toolResults(agent)
  assert.equal(reads, 1)
  assert.deepEqual(results, [{
    callId: 'read-success',
    name: 'read_equipment_state',
    isError: false,
    code: undefined,
  }])
  assert.equal(turnReason(agent), 'completed')
  await ctx.fiber.dispose()
  return { result: 'completed', toolResults: results, readBodies: reads }
}

async function rejectionCase() {
  const ctx = await mountHarness([
    toolCallsResponse([{
      id: 'order-rejected',
      name: 'create_maintenance_order',
      arguments: { equipment: 'P-101', action: 'inspect-bearing' },
    }]),
    textResponse('人工未批准创建工单，保持现状并返回待确认清单。'),
  ], { approval: true })
  const agent = newAgent(ctx, 'manufacturing-rejected')
  let writes = 0
  const approvals = []
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'create_maintenance_order') {
      return { kind: 'ask', reason: `create order for ${exec.arguments.equipment}` }
    }
    return next()
  })
  ctx.on('approval/request', (request) => {
    approvals.push({ callId: String(request.callId), decision: 'rejected' })
    return Promise.resolve('rejected')
  })
  ctx.tools.register(stringTool({
    name: 'create_maintenance_order',
    description: 'Create a maintenance order after explicit approval.',
    parameters: {
      equipment: { type: 'string', required: true },
      action: { type: 'string', required: true },
    },
    async execute() {
      writes += 1
      return 'MO-0001'
    },
  }))
  await runTurn(agent, '创建 P-101 轴承检查工单。')
  const results = toolResults(agent)
  assert.equal(writes, 0)
  assert.equal(results[0]?.isError, true)
  assert.deepEqual(approvals, [{ callId: 'order-rejected', decision: 'rejected' }])
  await ctx.fiber.dispose()
  return { result: 'completed-after-rejection', approvals, writeBodies: writes, toolResults: results }
}

async function toolFailureCase() {
  const ctx = await mountHarness([
    toolCallsResponse([{ id: 'historian-failed', name: 'read_historian', arguments: { equipment: 'P-101' } }]),
    textResponse('历史数据库读取失败，不能据此给出处置结论。'),
  ])
  const agent = newAgent(ctx, 'manufacturing-tool-failure')
  let bodies = 0
  ctx.tools.register(stringTool({
    name: 'read_historian',
    description: 'Read equipment history from a controlled backend.',
    parameters: { equipment: { type: 'string', required: true } },
    async execute() {
      bodies += 1
      throw new Error('historian unavailable')
    },
  }))
  await runTurn(agent, '核对 P-101 最近两小时的振动历史。')
  const results = toolResults(agent)
  assert.equal(bodies, 1)
  assert.equal(results[0]?.isError, true)
  assert.equal(turnReason(agent), 'completed')
  await ctx.fiber.dispose()
  return { result: 'completed-with-tool-error', toolBodies: bodies, toolResults: results }
}

async function cancellationCase() {
  const ctx = await mountHarness([
    toolCallsResponse([
      { id: 'diagnosis-running', name: 'long_diagnosis', arguments: { equipment: 'P-101' } },
      { id: 'order-never-started', name: 'create_maintenance_order', arguments: { equipment: 'P-101' } },
    ]),
  ])
  const agent = newAgent(ctx, 'manufacturing-cancelled')
  const started = Promise.withResolvers()
  const lifecycle = []
  let orderStarted = false
  ctx.tools.register(stringTool({
    name: 'long_diagnosis',
    description: 'Run a cancellable diagnosis.',
    parameters: { equipment: { type: 'string', required: true } },
    async execute(_args, exec) {
      lifecycle.push('started')
      started.resolve()
      if (!exec.signal.aborted) {
        await new Promise(resolveAbort => exec.signal.addEventListener('abort', resolveAbort, { once: true }))
      }
      lifecycle.push('abort-observed')
      await new Promise(resolveCleanup => setTimeout(resolveCleanup, 10))
      lifecycle.push('cleanup-complete')
      return 'stopped'
    },
  }))
  ctx.tools.register(stringTool({
    name: 'create_maintenance_order',
    description: 'Must remain queued behind diagnosis in this case.',
    parameters: { equipment: { type: 'string', required: true } },
    async execute() {
      orderStarted = true
      return 'MO-NEVER'
    },
  }))
  agent.followup(userMessage('开始诊断；如果我取消，不得继续创建工单。'))
  await started.promise
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  const results = toolResults(agent)
  assert.deepEqual(lifecycle, ['started', 'abort-observed', 'cleanup-complete'])
  assert.equal(orderStarted, false)
  assert.deepEqual(results.map(item => item.code), ['ABORTED', 'ABORTED_BEFORE_DISPATCH'])
  assert.equal(turnReason(agent), 'aborted')
  await ctx.fiber.dispose()
  return { result: 'aborted', lifecycle, orderStarted, toolResults: results }
}

async function recoveryCase() {
  await rm(recoveryRoot, { recursive: true, force: true })
  const id = SessionId('manufacturing-recovery')
  const first = await mountHarness([
    textResponse('第一阶段已记录 P-101 报警事实，等待后续复核。'),
  ], { persistenceRoot: recoveryRoot })
  const firstHandle = await first.agents.create({
    sessionId: id,
    agentOptions: { provider: 'mock', model: 'mock-manufacturing' },
  })
  await runTurn(firstHandle.agent, '记录 P-101 当前报警，暂不处置。')
  await first.sessions.flush(firstHandle.agent.session)
  const oldSurface = JSON.stringify(firstHandle.agent.session.deriveMessages())
  const oldEvents = firstHandle.agent.session.events.length
  await first.fiber.dispose()

  const second = await mountHarness([
    textResponse('恢复后继续：已加入维修记录，仍需人工确认最终处置。'),
  ], { persistenceRoot: recoveryRoot })
  const resumed = (await second.agents.resume({
    resumeSessionId: id,
    agentOptions: { provider: 'mock', model: 'mock-manufacturing' },
  })).agent
  assert.equal(String(resumed.id), String(id))
  assert.equal(JSON.stringify(resumed.session.deriveMessages()), oldSurface)
  assert.equal(resumed.session.firstLiveSeq, oldEvents)
  await runTurn(resumed, '继续加入维修记录并给出待确认建议。')
  const turns = resumed.session.events.flatMap(event => event.type === 'turn/start' ? [event.data.turn] : [])
  assert.deepEqual(turns, [1, 2])
  await second.fiber.dispose()
  return {
    result: 'resumed-and-completed',
    sessionId: String(id),
    restoredSurface: true,
    firstLiveSeq: oldEvents,
    turns,
  }
}

const results = {
  success: await successCase(),
  humanRejection: await rejectionCase(),
  toolFailure: await toolFailureCase(),
  cancellation: await cancellationCase(),
  recovery: await recoveryCase(),
}

console.log(JSON.stringify(results, null, 2))
