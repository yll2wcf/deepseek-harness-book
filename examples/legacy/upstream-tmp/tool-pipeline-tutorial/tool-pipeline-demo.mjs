import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as timeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'

const workspace = resolve('tmp/tool-pipeline-tutorial/workspace')

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function multiCallResponse(calls) {
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
      inputModalities: ['text'],
    })
  }

  async * stream(options) {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

async function createHarness(script, options = {}) {
  const adapter = new ScriptedAdapter(script)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  if (options.timeout === true) await ctx.plugin(timeoutPolicy)
  await ctx.plugin(AgentRegistry)
  if (options.approval === true) await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AgentLoop, {
    agents: [],
    ...(options.maxParallelToolCalls === undefined
      ? {}
      : { maxParallelToolCalls: options.maxParallelToolCalls }),
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

function userMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function resultText(event) {
  const block = event.data.message.content.find(item => item.type === 'tool-result')
  assert.ok(block !== undefined)
  return block.content.map(item => item.type === 'text' ? item.text : item.type).join('|')
}

function toolResults(agent) {
  const names = new Map(agent.session.events.flatMap(event => event.type === 'tool/call'
    ? [[String(event.data.callId), event.data.name]]
    : []))
  return agent.session.events.flatMap(event => {
    if (event.type !== 'tool/result') return []
    const callId = String(event.data.message.source.callId)
    const block = event.data.message.content.find(item => item.type === 'tool-result')
    assert.ok(block !== undefined)
    return [{
      callId,
      name: names.get(callId),
      isError: block.isError,
      code: event.data.error?.code ?? null,
      text: resultText(event),
    }]
  })
}

function durableSummary(agent) {
  return agent.session.events.flatMap(event => {
    if (event.type === 'tool/call') return [`${event.seq}:tool/call ${event.data.callId}:${event.data.name}`]
    if (event.type === 'tool/result') {
      return [`${event.seq}:tool/result ${event.data.message.source.callId}:${event.data.error?.code ?? (event.data.message.content[0]?.isError ? 'ERROR' : 'OK')}`]
    }
    if (event.type === 'approval/asked') return [`${event.seq}:approval/asked ${event.data.callId}`]
    if (event.type === 'approval/decided') return [`${event.seq}:approval/decided ${event.data.outcome}`]
    if (event.type === 'step/end') return [`${event.seq}:step/end ${event.data.turn}.${event.data.step}`]
    if (event.type === 'turn/end') return [`${event.seq}:turn/end ${event.data.turn}:${event.data.reason.kind}`]
    return []
  })
}

function assertCallResultPairs(agent) {
  const calls = agent.session.events.flatMap(event => event.type === 'tool/call'
    ? [String(event.data.callId)]
    : [])
  const results = agent.session.events.flatMap(event => event.type === 'tool/result'
    ? [String(event.data.message.source.callId)]
    : [])
  assert.deepEqual(results, calls)
  return { calls: calls.length, results: results.length, ids: results }
}

function stringTool({ name, description, parameters = {}, timeoutMs, isConcurrencySafe, execute, finalizeContent }) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(isConcurrencySafe === undefined ? {} : { isConcurrencySafe }),
    execute,
    ...(finalizeContent === undefined ? {} : { finalizeContent }),
  })
}

async function removeIfPresent(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function matrixScenario() {
  await mkdir(workspace, { recursive: true })
  const approvedPath = join(workspace, 'approved-note.txt')
  const deniedPath = join(workspace, 'denied-note.txt')
  await removeIfPresent(approvedPath)
  await removeIfPresent(deniedPath)
  const beforeFiles = await readdir(workspace)

  const calls = [
    { id: 'matrix-success', name: 'read_device_log', arguments: { device: 'PRESS-07' } },
    { id: 'matrix-invalid', name: 'read_device_log', arguments: {} },
    { id: 'matrix-pre-deny', name: 'pre_denied_probe', arguments: {} },
    { id: 'matrix-guard-deny', name: 'guard_denied_probe', arguments: {} },
    { id: 'matrix-post-block', name: 'post_blocked_probe', arguments: {} },
    { id: 'approval-deny', name: 'write_maintenance_note', arguments: { file: 'denied-note.txt', text: '不得写入' } },
    { id: 'approval-allow', name: 'write_maintenance_note', arguments: { file: 'approved-note.txt', text: 'PRESS-07：检查油压。' } },
    { id: 'matrix-throw', name: 'throwing_probe', arguments: {} },
    { id: 'matrix-timeout', name: 'slow_probe', arguments: {} },
  ]
  const { ctx, adapter } = await createHarness([
    multiCallResponse(calls),
    textResponse('工具矩阵已经结算。'),
  ], { approval: true, timeout: true })
  const agent = ctx.agentLoop.create(SessionId('week-07-matrix'), {
    provider: 'mock',
    model: 'mock-tools',
  })
  const stages = []
  const bodies = new Map()
  const approvals = []
  const countBody = (name) => bodies.set(name, (bodies.get(name) ?? 0) + 1)
  const markBody = (name, exec) => {
    countBody(name)
    stages.push(`${exec.callId}:body`)
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    stages.push(`${exec.callId}:pre`)
    if (exec.name === 'pre_denied_probe') {
      return { kind: 'deny', reason: 'pre policy denied this probe' }
    }
    if (exec.name === 'write_maintenance_note') {
      return { kind: 'ask', reason: `write ${exec.arguments.file}` }
    }
    return next()
  })
  ctx.tools.guard((exec) => {
    stages.push(`${exec.callId}:guard`)
    return exec.name === 'guard_denied_probe'
      ? 'owner guard denied this probe'
      : undefined
  })
  ctx.on('tools/execute', async (exec, next) => {
    stages.push(`${exec.callId}:around-before`)
    const result = await next()
    stages.push(`${exec.callId}:around-after`)
    return result
  })
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    stages.push(`${exec.callId}:post`)
    if (exec.name === 'post_blocked_probe') {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: 'Error: post policy hid the tool output' }],
      }
    }
    return next()
  })
  ctx.on('tools/result', (exec) => {
    stages.push(`${exec.callId}:result`)
  })
  ctx.on('approval/request', (request) => {
    const outcome = String(request.callId) === 'approval-allow'
      ? 'allowed-once'
      : 'rejected'
    approvals.push({ callId: String(request.callId), outcome })
    return Promise.resolve(outcome)
  })

  ctx.tools.register(stringTool({
    name: 'read_device_log',
    description: 'Read a deterministic device log sample.',
    parameters: { device: { type: 'string', required: true } },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      markBody('read_device_log', exec)
      return `${args.device}: pressure=normal`
    },
    finalizeContent(exec, result) {
      stages.push(`${exec.callId}:finalize`)
      if (result.isError) return undefined
      return [...result.content, { type: 'text', text: 'source=mock-device-log' }]
    },
  }))
  ctx.tools.register(stringTool({
    name: 'pre_denied_probe',
    description: 'Must be denied by pre policy.',
    async execute(_args, exec) {
      markBody('pre_denied_probe', exec)
      return 'must not run'
    },
  }))
  ctx.tools.register(stringTool({
    name: 'guard_denied_probe',
    description: 'Must be denied by an owner guard.',
    async execute(_args, exec) {
      markBody('guard_denied_probe', exec)
      return 'must not run'
    },
  }))
  ctx.tools.register(stringTool({
    name: 'post_blocked_probe',
    description: 'Runs, then has its output blocked.',
    async execute(_args, exec) {
      markBody('post_blocked_probe', exec)
      return 'sensitive raw result'
    },
  }))
  ctx.tools.register(stringTool({
    name: 'write_maintenance_note',
    description: 'Write one maintenance note in the tutorial workspace.',
    parameters: {
      file: { type: 'string', required: true },
      text: { type: 'string', required: true },
    },
    async execute(args, exec) {
      markBody('write_maintenance_note', exec)
      if (!['approved-note.txt', 'denied-note.txt'].includes(args.file)) {
        throw new Error('tutorial write target is outside the allowlist')
      }
      await writeFile(join(workspace, args.file), args.text, 'utf8')
      return `workspace/${args.file}`
    },
  }))
  ctx.tools.register(stringTool({
    name: 'throwing_probe',
    description: 'Throw a controlled provider error.',
    async execute(_args, exec) {
      markBody('throwing_probe', exec)
      throw new Error('sensor backend failed')
    },
  }))
  ctx.tools.register(stringTool({
    name: 'slow_probe',
    description: 'Cooperatively stop when its timeout signal aborts.',
    timeoutMs: 40,
    async execute(_args, exec) {
      markBody('slow_probe', exec)
      if (!exec.signal.aborted) {
        await new Promise(resolveAbort => exec.signal.addEventListener('abort', resolveAbort, { once: true }))
      }
      return 'stopped cooperatively'
    },
  }))

  agent.followup(userMessage('运行工具成功与失败矩阵。'))
  await agent.whenIdle()

  const pairs = assertCallResultPairs(agent)
  const results = toolResults(agent)
  const afterFiles = await readdir(workspace)
  assert.equal(pairs.calls, calls.length)
  assert.equal(bodies.get('read_device_log'), 1)
  assert.equal(bodies.get('pre_denied_probe') ?? 0, 0)
  assert.equal(bodies.get('guard_denied_probe') ?? 0, 0)
  assert.equal(bodies.get('post_blocked_probe'), 1)
  assert.equal(bodies.get('write_maintenance_note'), 1)
  assert.equal(bodies.get('throwing_probe'), 1)
  assert.equal(bodies.get('slow_probe'), 1)
  assert.equal(results.find(item => item.callId === 'matrix-invalid')?.code, 'INVALID_ARGS')
  assert.equal(results.find(item => item.callId === 'matrix-timeout')?.code, 'TOOL_TIMEOUT')
  assert.equal(results.find(item => item.callId === 'matrix-post-block')?.isError, true)
  assert.deepEqual(approvals, [
    { callId: 'approval-deny', outcome: 'rejected' },
    { callId: 'approval-allow', outcome: 'allowed-once' },
  ])
  assert.equal(afterFiles.includes('denied-note.txt'), false)
  assert.equal(await readFile(approvedPath, 'utf8'), 'PRESS-07：检查油压。')

  const result = {
    beforeFiles,
    afterFiles,
    bodies: Object.fromEntries([...bodies.entries()].sort()),
    approvals,
    callResultPairs: pairs,
    results,
    successPipeline: stages.filter(stage => stage.startsWith('matrix-success:')),
    selectedFailureStages: Object.fromEntries([
      'matrix-invalid',
      'matrix-pre-deny',
      'matrix-guard-deny',
      'matrix-post-block',
      'approval-deny',
      'approval-allow',
      'matrix-timeout',
    ].map(id => [id, stages.filter(stage => stage.startsWith(`${id}:`))])),
    durableSummary: durableSummary(agent),
    adapterRequests: adapter.requests.length,
  }
  await ctx.fiber.dispose()
  return result
}

async function until(predicate, description) {
  for (let index = 0; index < 1000; index += 1) {
    if (predicate()) return
    await new Promise(resolveTick => setTimeout(resolveTick, 0))
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function concurrencyScenario() {
  const calls = [
    { id: 'read-A', name: 'safe_read', arguments: { id: 'A' } },
    { id: 'read-B', name: 'safe_read', arguments: { id: 'B' } },
    { id: 'commit-C', name: 'exclusive_commit', arguments: { id: 'C' } },
  ]
  const { ctx } = await createHarness([
    multiCallResponse(calls),
    textResponse('并发批次已经结算。'),
  ], { maxParallelToolCalls: 2 })
  const agent = ctx.agentLoop.create(SessionId('week-07-concurrency'), {
    provider: 'mock',
    model: 'mock-tools',
  })
  const order = []
  const gates = new Map()
  let live = 0
  let peak = 0

  ctx.tools.register(stringTool({
    name: 'safe_read',
    description: 'A read-only call that may overlap siblings.',
    parameters: { id: { type: 'string', required: true } },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      order.push(`start:read:${args.id}`)
      live += 1
      peak = Math.max(peak, live)
      await new Promise((release) => {
        gates.set(args.id, release)
        exec.signal.addEventListener('abort', release, { once: true })
      })
      live -= 1
      order.push(`end:read:${args.id}`)
      return `read-${args.id}`
    },
  }))
  ctx.tools.register(stringTool({
    name: 'exclusive_commit',
    description: 'An exclusive in-memory commit.',
    parameters: { id: { type: 'string', required: true } },
    async execute(args) {
      order.push(`start:commit:${args.id}`)
      assert.equal(live, 0)
      order.push(`end:commit:${args.id}`)
      return `commit-${args.id}`
    },
  }))

  agent.followup(userMessage('运行两个并行读取和一个独占提交。'))
  await until(() => gates.size === 2, 'both safe reads to start')
  const whileReadsWaiting = [...order]
  assert.equal(peak, 2)
  assert.equal(order.some(item => item.startsWith('start:commit')), false)

  gates.get('B')()
  gates.delete('B')
  await until(() => order.includes('end:read:B'), 'read B to finish first')
  const afterFastRead = [...order]
  assert.equal(order.some(item => item.startsWith('start:commit')), false)

  gates.get('A')()
  gates.delete('A')
  await agent.whenIdle()

  const results = toolResults(agent)
  assert.deepEqual(results.map(item => item.callId), ['read-A', 'read-B', 'commit-C'])
  assert.ok(order.indexOf('end:read:A') < order.indexOf('start:commit:C'))
  assert.ok(order.indexOf('end:read:B') < order.indexOf('start:commit:C'))

  const result = {
    peakParallelBodies: peak,
    whileReadsWaiting,
    afterFastRead,
    finalBodyOrder: order,
    committedResultOrder: results.map(item => item.callId),
    callResultPairs: assertCallResultPairs(agent),
    durableSummary: durableSummary(agent),
  }
  await ctx.fiber.dispose()
  return result
}

async function cancellationScenario() {
  const calls = [
    { id: 'cancel-running', name: 'cancel_probe', arguments: {} },
    { id: 'cancel-unstarted', name: 'never_started', arguments: {} },
  ]
  const { ctx } = await createHarness([multiCallResponse(calls)])
  const agent = ctx.agentLoop.create(SessionId('week-07-cancel'), {
    provider: 'mock',
    model: 'mock-tools',
  })
  const started = Promise.withResolvers()
  const lifecycle = []
  let neverStarted = false

  ctx.tools.register(stringTool({
    name: 'cancel_probe',
    description: 'Settle after observing caller cancellation.',
    async execute(_args, exec) {
      lifecycle.push('body-start')
      started.resolve()
      if (!exec.signal.aborted) {
        await new Promise(resolveAbort => exec.signal.addEventListener('abort', resolveAbort, { once: true }))
      }
      lifecycle.push('abort-observed')
      await new Promise(resolveCleanup => setTimeout(resolveCleanup, 10))
      lifecycle.push('cleanup-complete')
      return 'stopped after cleanup'
    },
  }))
  ctx.tools.register(stringTool({
    name: 'never_started',
    description: 'Must remain queued behind the exclusive cancelled call.',
    async execute() {
      neverStarted = true
      return 'must not run'
    },
  }))

  agent.followup(userMessage('启动一个运行中工具和一个排队工具，然后取消。'))
  await started.promise
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()

  const results = toolResults(agent)
  assert.deepEqual(lifecycle, ['body-start', 'abort-observed', 'cleanup-complete'])
  assert.equal(neverStarted, false)
  assert.deepEqual(results.map(item => item.code), ['ABORTED', 'ABORTED_BEFORE_DISPATCH'])
  assert.equal(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'aborted')

  const result = {
    lifecycle,
    neverStarted,
    results,
    callResultPairs: assertCallResultPairs(agent),
    durableSummary: durableSummary(agent),
  }
  await ctx.fiber.dispose()
  return result
}

function section(title, value) {
  console.log(`\n## ${title}`)
  console.log(JSON.stringify(value, null, 2))
}

section('路径一：工具成功、拒绝、异常、超时与 Mock 审批矩阵', await matrixScenario())
section('路径二：两个并行安全读取与一个独占屏障', await concurrencyScenario())
section('路径三：取消等待运行中工具清理，并为未启动调用补齐结果', await cancellationScenario())
