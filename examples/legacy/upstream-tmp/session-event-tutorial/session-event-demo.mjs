import { Context } from '@deepseek-ai/cordis'
import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import SessionStore, {
  isAppendSurfaceEvent,
  Session,
  SessionForkError,
  SessionId,
} from '@deepseek-ai/dsh-session'

function blockLabel(block) {
  switch (block.type) {
    case 'text':
      return block.text
    case 'tool-call':
      return `tool-call:${block.name}#${block.id}`
    case 'tool-result': {
      const content = block.content
        .map(item => item.type === 'text' ? item.text : item.type)
        .join('|')
      return `tool-result:${block.toolCallId}:${content}`
    }
    default:
      return block.type
  }
}

function messageLabel(message) {
  return `${message.role} | ${message.content.map(blockLabel).join(' + ')}`
}

function section(title, value) {
  console.log(`\n## ${title}`)
  console.log(value)
}

const ctx = new Context()
const created = []
const published = []

ctx.on('session/created', session => void created.push(session.id))
ctx.on('session/event', (session, event) => {
  published.push(`${session.id}:${event.seq}:${event.type}`)
})
await ctx.plugin(SessionStore)

const parent = ctx.sessions.create(SessionId('week-04-parent'), {
  meta: { cwd: '/workspace/week-04' },
})
const callId = ToolCallId('weather-1')

parent.append('turn/start', { turn: 1 })
parent.append('step/start', { turn: 1, step: 1 })
parent.append('user/message', createUserMessage({
  content: [{ type: 'text', text: '北京今天需要带伞吗？' }],
  source: { kind: 'user' },
}), { surfaceOp: 'append' })
parent.append('request/header', {
  header: {
    config: { provider: 'mock', model: 'mock-weather' },
    system: '你是一个天气助手。',
    tools: [{
      name: 'weather',
      description: '查询城市天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    }],
  },
  reason: 'initial',
})
parent.append('request/context', {
  provider: 'mock',
  model: 'mock-weather',
  contextWindow: 128_000,
})
const chunkSeqs = [
  parent.append('assistant/chunk', {
    turn: 1,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: '我先' },
  }).seq,
  parent.append('assistant/chunk', {
    turn: 1,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: '查一下。' },
  }).seq,
]
parent.append('assistant/message', {
  turn: 1,
  step: 1,
  message: createMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: '我先查一下。' },
      { type: 'tool-call', id: callId, name: 'weather', arguments: '{"city":"北京"}' },
    ],
    source: { kind: 'model', provider: 'mock', model: 'mock-weather' },
  }),
}, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
const call = parent.append('tool/call', {
  turn: 1,
  step: 1,
  callId,
  name: 'weather',
  arguments: '{"city":"北京"}',
})
parent.append('tool/result', {
  turn: 1,
  step: 1,
  message: createToolResultMessage({
    callId,
    content: [{ type: 'text', text: '小雨，降水概率70%' }],
    isError: false,
  }),
}, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
parent.append('step/end', { turn: 1, step: 1 })
parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

const initialEvents = [...parent.events]
const initialSurface = [...parent.surface.nodes]
const initialMessages = parent.deriveMessages()
const transcript = initialEvents
  .filter(isAppendSurfaceEvent)
  .map(event => `${event.seq}:${event.type}`)

section('原始事件', initialEvents.map(event => `${event.seq}:${event.type}`).join('\n'))
section('Surface 节点', JSON.stringify(initialSurface))
section('模型消息', initialMessages.map(messageLabel).join('\n'))
section('面向人的追加来源', transcript.join('\n'))
section('请求状态', JSON.stringify({
  header: parent.requestHeader(),
  context: parent.requestContext(),
}, null, 2))

const invalid = Session.create(SessionId('week-04-invalid-surface'))
const invalidSeqBefore = invalid.seq
let surfaceFailure
try {
  invalid.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '缺少 Surface 标记' }],
    source: { kind: 'user' },
  }))
} catch (error) {
  surfaceFailure = {
    message: error instanceof Error ? error.message : String(error),
    logUnchanged: invalid.seq === invalidSeqBefore,
  }
}
section('Surface 校验失败', JSON.stringify(surfaceFailure, null, 2))

const summary = parent.append('user/message', createUserMessage({
  content: [{ type: 'text', text: '此前对话摘要：用户询问北京天气，助手查询到小雨。' }],
  source: { kind: 'plugin', plugin: 'week-04-summary' },
}), {
  surfaceOp: {
    op: 'replace',
    start: initialSurface[0],
    end: initialSurface.at(-1),
  },
  sourceEventSeqs: initialSurface,
})

section('Surface 替换后', JSON.stringify({
  rawEventCount: parent.events.length,
  replacementSeq: summary.seq,
  surfaceNodes: parent.surface.nodes,
  modelMessages: parent.deriveMessages().map(messageLabel),
  appendTranscriptNodes: parent.events.filter(isAppendSurfaceEvent).map(event => event.seq),
}, null, 2))

const replay = Session.create(SessionId('week-04-replay'), parent.events)
section('Seed 回放', JSON.stringify({
  inheritedEvents: parent.events.length,
  replayEvents: replay.events.length,
  marker: replay.events.at(-1)?.type,
  firstLiveSeq: replay.firstLiveSeq,
  sameDerivedMessages: JSON.stringify(replay.deriveMessages()) === JSON.stringify(parent.deriveMessages()),
}, null, 2))

const child = ctx.sessions.fork(parent, undefined, SessionId('week-04-child'))
section('合法 Fork', JSON.stringify({
  parentSession: child.header.parentSession,
  seedLength: child.header.seedLength,
  childLastEvent: child.events.at(-1)?.type,
  copiedEventIdentity: child.events[0] !== parent.events[0],
  sameDerivedMessages: JSON.stringify(child.deriveMessages()) === JSON.stringify(parent.deriveMessages()),
}, null, 2))

parent.append('turn/start', { turn: 2 })
parent.append('step/start', { turn: 2, step: 1 })
const openUser = parent.append('user/message', createUserMessage({
  content: [{ type: 'text', text: '那上海呢？' }],
  source: { kind: 'user' },
}), { surfaceOp: 'append' })

let forkFailure
try {
  ctx.sessions.fork(parent, openUser.seq, SessionId('week-04-invalid-child'))
} catch (error) {
  if (error instanceof SessionForkError) {
    forkFailure = { name: error.name, code: error.code, message: error.message }
  } else {
    throw error
  }
}
parent.append('step/end', { turn: 2, step: 1 })
parent.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

section('Fork 失败对照', JSON.stringify(forkFailure, null, 2))
section('父子后续分离', JSON.stringify({
  parentMessages: parent.deriveMessages().map(messageLabel),
  childMessages: child.deriveMessages().map(messageLabel),
}, null, 2))
section('实时通知', JSON.stringify({
  created,
  publishedCount: published.length,
  childSeedEventsPublished: published.some(item => item.startsWith('week-04-child:')),
  firstThree: published.slice(0, 3),
  lastThree: published.slice(-3),
}, null, 2))
