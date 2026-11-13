import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'

const runtimeRoot = resolve('tmp/agent-continuity-tutorial/runtime')
const sessionId = SessionId('week-08-continuity')
const continuityStateSchema = {
  parse(value) {
    if (typeof value !== 'object' || value === null
      || !Number.isInteger(value.turns) || !Number.isInteger(value.compactions)) {
      throw new Error('invalid tutorial continuity projection state')
    }
    return value
  },
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 24, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
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
      context: { contextWindow: 16_384 },
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

class DeterministicCompactionEngine extends BasicCompactionEngine {
  calls = []

  async summarize(input, _agent, signal) {
    signal?.throwIfAborted()
    this.calls.push(input)
    return {
      summary: [{
        type: 'text',
        text: '设备 P-101 曾出现振动异常；已确认先隔离、后复核轴承与润滑记录。',
      }],
      provider: 'tutorial',
      model: 'deterministic-summary',
      maxTokens: 128,
      usage: { inputTokens: 96, outputTokens: 28 },
    }
  }
}

const continuityProjection = () => ({
  key: 'tutorial/continuity',
  stateSchema: continuityStateSchema,
  init: () => ({ turns: 0, compactions: 0 }),
  apply(state, event) {
    if (event.type === 'turn/end') return { ...state, turns: state.turns + 1 }
    if (event.type === 'compaction/summary') {
      return { ...state, compactions: state.compactions + 1 }
    }
    return state
  },
  wire: {
    viewSchema: continuityStateSchema,
    view: state => state,
  },
  stateVersion: 1,
})

function userMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function messageText(message) {
  return message.content.flatMap((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return [block.text]
    if (block.type === 'tool-call') return [`${block.name}(${block.arguments})`]
    if (block.type === 'tool-result') {
      return block.content.flatMap(item => item.type === 'text' ? [item.text] : [])
    }
    return []
  }).join(' ')
}

function surfaceText(session) {
  return session.deriveMessages().map(message => `${message.role}:${messageText(message)}`)
}

function eventCounts(session) {
  return Object.fromEntries([...session.events.reduce((counts, event) => {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
    return counts
  }, new Map()).entries()].sort())
}

function projection(ctx, session) {
  return ctx.sessionProjections.snapshot(session).values['tutorial/continuity']
}

async function mountHarness(root, responses, collaboration = false) {
  const adapter = new ScriptedAdapter(responses)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(continuityProjection())
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  ctx.llm.registerAdapter(['mock'], adapter)
  if (collaboration) {
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn' })
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('week-08-tutorial')
    await ctx.plugin(DeterministicCompactionEngine, {
      auto: false,
      retainTokens: 80,
    })
  }
  return { ctx, adapter }
}

async function runTurn(agent, prompt) {
  agent.followup(userMessage(prompt))
  await agent.whenIdle()
}

function registerMockInvestigator(ctx) {
  const lifecycle = []
  let disposed = false
  ctx.on('subagent/start', info => void lifecycle.push(`start:${info.provider}`))
  ctx.on('subagent/end', info => void lifecycle.push(`end:${info.stopReason}`))
  ctx.subagents.registerProvider({
    name: 'mock-investigator',
    capabilities: {
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    },
    inheritsParentContext: false,
    start: request => Promise.resolve({
      id: SessionId(`mock-child:${request.parent.id}`),
      localAgent: undefined,
      result: Promise.resolve({
        output: [{ type: 'text', text: '轴承更换记录与振动峰值时间重合，建议检查装配偏差。' }],
        stopReason: 'completed',
      }),
      async dispose() { disposed = true },
    }),
  })
  return { lifecycle, isDisposed: () => disposed }
}

async function runSubagent(ctx, parent) {
  const observer = registerMockInvestigator(ctx)
  const run = await ctx.subagents.start('mock-investigator', {
    prompt: [{ type: 'text', text: '独立核对 P-101 的维修记录与振动趋势。' }],
    parent,
    signal: new AbortController().signal,
  })
  const result = await run.result
  await run.dispose()
  await new Promise(resolveTick => setTimeout(resolveTick, 0))
  assert.equal(result.stopReason, 'completed')
  assert.equal(observer.isDisposed(), true)
  assert.deepEqual(observer.lifecycle, ['start:mock-investigator', 'end:completed'])
  return {
    childId: String(run.id),
    stopReason: result.stopReason,
    output: result.output.map(item => item.type === 'text' ? item.text : item.type).join(' '),
    lifecycle: [...observer.lifecycle],
    disposed: observer.isDisposed(),
  }
}

async function runJob(ctx) {
  const done = Promise.withResolvers()
  const timer = setTimeout(() => {
    done.resolve({
      status: 'completed',
      detail: '3 records compared',
      output: '点检、维修和振动三类记录已完成对齐。',
    })
  }, 20)
  const id = ctx.jobs.start({
    kind: 'bash',
    label: 'compare-maintenance-records',
    run: () => ({
      cancel: () => {
        clearTimeout(timer)
        done.resolve({ status: 'killed', detail: 'cancelled by tutorial' })
      },
      done: done.promise,
    }),
  })
  const running = ctx.jobs.get(id)
  const settled = await ctx.jobs.wait(id, 2_000)
  const read = ctx.jobs.read(id)
  assert.equal(running.status, 'running')
  assert.equal(settled.status, 'completed')
  assert.equal(read.text, '点检、维修和振动三类记录已完成对齐。')
  return {
    id: String(id),
    before: running.status,
    after: settled.status,
    detail: settled.detail,
    output: read.text,
  }
}

async function runWorkflow(ctx, parent) {
  const events = []
  const childIds = []
  for (const name of [
    'workflow/start',
    'workflow/phase',
    'workflow/log',
    'workflow/agent-start',
    'workflow/agent-end',
    'workflow/end',
  ]) {
    ctx.on(name, (...payload) => {
      events.push(name)
      if (name === 'workflow/agent-start') childIds.push(String(payload[1].childId))
    })
  }
  const run = ctx.workflowEngine.start({
    meta: {
      name: 'equipment-evidence-workflow',
      description: 'run one deterministic investigation phase through a child agent',
      phases: [{ title: 'Investigate' }],
    },
    script: `phase('Investigate')
log('delegating evidence review')
const report = await agent('核对 P-101 的三类历史记录，只返回一句结论。')
return { report, decision: 'await-human-confirmation' }`,
    parent,
  })
  const result = await run.result
  await run.dispose()
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.agentsStarted, 1)
  assert.equal(childIds.length, 1)
  assert.equal(ctx.agents.get(SessionId(childIds[0])), undefined)
  assert.equal(events[0], 'workflow/start')
  assert.equal(events.at(-1), 'workflow/end')
  return {
    stopReason: result.stopReason,
    agentsStarted: result.agentsStarted,
    value: result.value,
    events,
    childDisposed: ctx.agents.get(SessionId(childIds[0])) === undefined,
  }
}

async function main() {
  await rm(runtimeRoot, { recursive: true, force: true })

  const first = await mountHarness(runtimeRoot, [
    textResponse(`第一次分析完成：P-101 振动值升高，需要先隔离设备。${' 历史记录待复核。'.repeat(30)}`),
  ])
  const firstHandle = await first.ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'mock', model: 'mock-continuity' },
    meta: { cwd: '/factory/demo' },
  })
  await runTurn(firstHandle.agent, `分析 P-101 的振动异常。${' 请保留关键事实。'.repeat(30)}`)
  await first.ctx.sessions.flush(firstHandle.agent.session)

  const beforeRestart = {
    sessionId: String(firstHandle.agent.session.id),
    events: firstHandle.agent.session.events.length,
    lastSeq: firstHandle.agent.session.events.at(-1)?.seq,
    surface: surfaceText(firstHandle.agent.session),
    projection: projection(first.ctx, firstHandle.agent.session),
  }
  assert.deepEqual(beforeRestart.projection, { turns: 1, compactions: 0 })
  await first.ctx.fiber.dispose()

  const second = await mountHarness(runtimeRoot, [
    textResponse(`第二次分析完成：复核轴承更换记录。${' 继续保留证据。'.repeat(25)}`),
    textResponse(`第三次分析完成：检查润滑记录。${' 继续保留证据。'.repeat(25)}`),
    textResponse(`第四次分析完成：形成待确认建议。${' 继续保留证据。'.repeat(25)}`),
    textResponse('子智能体结论：振动峰值与轴承更换后的装配偏差有关。'),
  ], true)
  const resumedHandle = await second.ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'mock', model: 'mock-continuity' },
  })
  const resumed = resumedHandle.agent
  const afterRestart = {
    sessionId: String(resumed.session.id),
    events: resumed.session.events.length,
    firstLiveSeq: resumed.session.firstLiveSeq,
    surface: surfaceText(resumed.session),
    projection: projection(second.ctx, resumed.session),
  }
  assert.equal(afterRestart.sessionId, beforeRestart.sessionId)
  assert.deepEqual(afterRestart.surface, beforeRestart.surface)
  assert.deepEqual(afterRestart.projection, { turns: 1, compactions: 0 })

  await runTurn(resumed, `继续分析轴承更换记录。${' 补充时间线。'.repeat(25)}`)
  await runTurn(resumed, `继续分析润滑记录。${' 补充时间线。'.repeat(25)}`)
  await runTurn(resumed, `给出需要人工确认的处置建议。${' 不要直接执行。'.repeat(25)}`)
  assert.deepEqual(projection(second.ctx, resumed.session), { turns: 4, compactions: 0 })

  const eventsBeforeCompaction = resumed.session.events.length
  const surfaceBeforeCompaction = surfaceText(resumed.session)
  const compaction = await second.ctx.compaction.compactNow(
    resumed,
    new AbortController().signal,
  )
  assert.notEqual(compaction, null)
  const surfaceAfterCompaction = surfaceText(resumed.session)
  assert.ok(resumed.session.events.length > eventsBeforeCompaction)
  assert.ok(surfaceAfterCompaction.length < surfaceBeforeCompaction.length)
  assert.deepEqual(projection(second.ctx, resumed.session), { turns: 4, compactions: 1 })
  assert.deepEqual(
    resumed.session.events.filter(event => event.type.startsWith('compaction/')).map(event => event.type),
    ['compaction/start', 'compaction/summary', 'compaction/end'],
  )

  const subagent = await runSubagent(second.ctx, resumed)
  const job = await runJob(second.ctx)
  const workflow = await runWorkflow(second.ctx, resumed)
  await second.ctx.sessions.flush(resumed.session)
  const durableSurface = surfaceText(resumed.session)
  const countsAfterCompaction = eventCounts(resumed.session)
  await second.ctx.fiber.dispose()

  const third = await mountHarness(runtimeRoot, [])
  const finalHandle = await third.ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'mock', model: 'mock-continuity' },
  })
  const finalReplay = {
    sessionId: String(finalHandle.agent.session.id),
    surfaceMatchesCheckpoint: JSON.stringify(surfaceText(finalHandle.agent.session)) === JSON.stringify(durableSurface),
    projection: projection(third.ctx, finalHandle.agent.session),
    originalTurnEventsRemain: finalHandle.agent.session.events.filter(event => event.type === 'turn/end').length,
    compactionEvents: finalHandle.agent.session.events
      .filter(event => event.type.startsWith('compaction/'))
      .map(event => event.type),
  }
  assert.equal(finalReplay.surfaceMatchesCheckpoint, true)
  assert.deepEqual(finalReplay.projection, { turns: 4, compactions: 1 })
  assert.equal(finalReplay.originalTurnEventsRemain, 4)
  await third.ctx.fiber.dispose()

  console.log(JSON.stringify({
    recovery: { beforeRestart, afterRestart, finalReplay },
    compaction: {
      eventsBefore: eventsBeforeCompaction,
      eventsAfter: Object.values(countsAfterCompaction).reduce((sum, count) => sum + count, 0),
      surfaceMessagesBefore: surfaceBeforeCompaction.length,
      surfaceMessagesAfter: surfaceAfterCompaction.length,
      shadowedSeqs: compaction.shadowedSeqs,
      transaction: ['compaction/start', 'compaction/summary', 'compaction/end'],
    },
    collaboration: { subagent, job, workflow },
  }, null, 2))
}

await main()
