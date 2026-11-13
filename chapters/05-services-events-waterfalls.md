# 第5章 服务、事件与 Waterfall 怎样协作

> 本章源码基线：DeepSeek Harness `0.2.2-rc.2`，提交 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`。本轮核对Service、依赖卸载、事件分发及Agent作用域包装；所有终端输出来自旧提交 `cd5ef8148158c3a752a658978873241fdf8e2bbc`，未在新版重跑。当前Node.js要求 `>=24.9.0`。

上一章的插件可以独立加载和卸载，但真实 Agent 不会由一群互不相干的插件组成。工具插件要调用工具注册表，Agent Loop 要取得 LLM 和 Session，审批策略要观察执行请求，界面还要接收状态变化。问题从“一个插件怎样活着”变成“多个插件怎样协作，却不把彼此锁死”。

最容易犯的错误，是把所有协作都写成函数调用，或者把所有协作都丢进事件总线。前一种做法让消费方直接依赖具体实现，提供方很难替换；后一种做法把本应有明确结果的请求变成广播，调用者不知道谁负责回答，也不知道什么时候算完成。

Cordis 提供的不是一个万能通信接口，而是几种责任不同的机制：Service 表达稳定、可直接调用的能力；`inject` 表达插件没有这项能力就不能运行；Event 表达通知或协作点；不同分发模式决定是否等待、是否收集结果、何时停止；Waterfall 让监听器包装、改写或截断一个有默认行为的流程。

读完本章，你应该能根据问题选择 Service、普通 Event 或 Waterfall，解释服务出现和消失时 Fiber 为什么会重新决议，并能一眼识别“忘记调用 `next()`”这种不会抛异常、却足以截断 Agent 流程的错误。

第一次阅读先只区分三类关系：需要一个明确结果时直接调用 Service；只想通知零个或多个观察者时发送 Event；围绕一个默认行为作出单一决定时使用 Waterfall。`emit`、`parallel`、`serial` 和 `bail` 是第二层细节，不要一开始把五个方法当成五套彼此无关的机制背诵。

## 先用一个判断问题选择通信方式

假设我们要给设备异常 Agent 增加三项能力：查询设备状态、统计每次查询、在高风险设备上阻止查询。它们看起来都与一次查询有关，却不应使用同一种机制。

- 查询设备状态有一个明确的能力所有者，调用方需要返回值和失败信息，适合 Service 方法。
- 统计查询次数不改变查询结果，可能有零个或多个观察者，适合普通 Event。
- 高风险策略需要让多个插件检查同一请求，并且可以阻止默认查询，适合 Waterfall。

判断时先问“谁必须给结果”。如果有一个稳定提供者，先考虑 Service；如果发送方不关心有谁监听，考虑 Event；如果存在默认行为，监听器还要在前后包装或拥有否决权，考虑 Waterfall。

这三种机制都不是为了减少几行 import，而是为了把所有权写清楚。能力由谁提供，事实由谁观察，决定由谁拥有，直接影响插件卸载、测试和故障诊断。

## Service 是挂在稳定名称上的能力

配套实验定义了一个 `GreeterService`：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}

export class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet(who: string): string {
    return `Hello, ${who}!`
  }
}
```

`super(ctx, 'greeter')` 完成运行时注册：这个实例占据 `greeter` 服务键，消费方通过 `ctx.greeter` 取得它。消费方知道的是能力名称和公开方法，不需要导入“本地实现”“远程实现”或“测试实现”中的某一个。

`declare module` 完成的是另一件事：TypeScript 声明合并把 `greeter` 加入 `Context` 接口，让编辑器和编译器知道 `ctx.greeter` 的类型。它不会生成运行时代码，也不会替你注册服务。反过来，只做运行时注册而不做声明合并，程序可能运行，跨包消费却会失去类型检查。

这正是大型 Agent 系统需要的可替换点。Shell Consumer 可以依赖稳定的 `shell` Service，而 Profile 决定装入本地 Bash、PowerShell 或另一种 Provider。消费方的业务代码不需要因为部署环境变化而改 import。

Service 适合具有这些特征的协作：方法调用有明确接收者；调用方需要结果、异常或取消语义；能力通常有状态或资源；不同部署可能替换实现。它不适合表达“某件事已经发生，愿意关心的人都可以观察”，那是事件的职责。

## `inject` 不只是启动前检查一次

消费插件这样声明硬依赖：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from './greeter.ts'

export const inject = ['greeter']

export function apply(ctx: Context): void {
  console.log(ctx.greeter.greet('world'))
}
```

`import type {}` 只让编译器看见 `greeter.ts` 中的声明合并，不会在运行时偷偷装入提供方。真正决定提供方是否存在的是插件树。`inject = ['greeter']` 则告诉 Cordis：没有 `greeter`，这个插件不具备运行前提。

旧实验故意把消费方写在YAML提供方之前，仍输出 `Hello, world!`。当前源码也不把YAML位置当成依赖启动顺序：加载可以并发，消费方必须等全部所需服务可用才从 `PENDING` 进入 `LOADING`。历史输出帮助理解这一关系，当前运行结果仍要单独取得。

旧实验移除提供方后没有输出，以状态码0结束，消费Fiber保持 `PENDING`，没有执行apply。这不能推出所有PENDING Fiber都没有资源：当前内部观察者可能在激活前登记Effect，dispose仍须排空这些工作。对于这个最小例子，没有额外活动资源才使进程自然结束；PENDING只描述等待运行条件。

`inject` 还会在加载后持续跟踪依赖。提供方因配置更新或热替换而消失时，消费方会卸载，撤销自己注册的监听器和资源；提供方回来以后，消费方再重新加载。这样它不会长期保存一个已经失效的 Service 引用。

这是一项很强的生命周期约定：服务可替换不只意味着“接口类型相同”，还意味着依赖它的插件能随提供方离开和回来。一个 Provider 若在卸载时没有释放端口或连接，新的 Provider 即使实现相同接口也无法接管。

如果依赖确实是可选的，不要把它写进 `inject` 再想办法绕过。可以在使用处调用 `ctx.get('greeter')`：

```ts
export function apply(ctx: Context): void {
  const greeter = ctx.get('greeter')
  console.log(greeter?.greet('maybe') ?? 'no greeter available')
}
```

选择硬依赖还是可选依赖，不是类型技巧，而是产品行为。缺少能力时，如果插件继续运行会产生误导、丢失安全检查或只能完成半项任务，就应使用 `inject` 并让它等待；只有降级路径仍然完整、可解释时，才适合 `ctx.get()`。

> 核心建议
> 不要用 YAML 顺序表达依赖，也不要在 `apply()` 开头用一串 `if (!ctx.xxx) return` 静默跳过。硬依赖写进 `inject`，可选能力在使用处明确降级。

## 服务出现和消失时发生了什么

可以把 Service 与 Fiber 的关系分成四步观察：

1. 提供方加载并在当前作用域注册服务键。
2. Registry 重新判断等待该键的 Fiber，满足全部 `inject` 后启动它们。
3. 提供方离开ACTIVE，依赖Fiber先卸载；提供方等这些消费方收束后，再撤销自己的服务及其他Effect。
4. 新提供方注册同名能力，依赖 Fiber 使用新的 Context 重新加载。

这四步解释了为什么注册必须属于 Effect。若服务键在提供方卸载后仍残留，Registry 会误以为依赖仍然满足；消费方继续工作时拿到的却是指向旧连接、旧配置或已释放资源的对象。

还要区分等待依赖与自身加载失败。因依赖不可用而等待的消费方可以随服务重新出现而决议；已经FAILED的Fiber保留失败状态，需要显式更新或重启。补齐一个Provider不代表自动修复所有加载错误。

在 DeepSeek Harness 中，能力通常被拆成 Service Definition、Service Provider 和 Consumer 三种角色。Definition 拥有名称、接口与事件约定；Provider 提供具体实现；Consumer 把能力变成工具、命令或上层流程。它们共同构成一条完整的 Capability Seam。第3章从 Bash 追踪到 Shell 与 Subprocess 时已经见过这种拆法，本章给出了它能够成立的运行机制。

排查“插件明明写进配置却没有运行”时，可以枚举 `ctx.registry` 中的Fiber状态。旧版 `diagnose.ts` 实验记录输出：

```text
needs-timer is PENDING — a required service is missing
```

加入 timer Provider 后，同一消费插件输出 `needs-timer loaded`。正式产品的诊断应进一步指出缺失键和作用域；学习阶段至少要先把“没有日志”从成功、等待与失败三种情况中分开。

## Event 让发送方不必知道监听者

Service 调用要求发送方知道服务名称和方法。Event 的方向相反：发送方只声明“发生了什么”或“这里存在一个协作点”，不需要知道有几个插件关心它。

下面的声明把 `stats/report` 事件加入 Cordis 的 `Events` 接口：

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'stats/report'(name: string, count: number): void
  }
}
```

此后 `ctx.emit('stats/report', name, count)` 和 `ctx.on('stats/report', listener)` 都获得参数类型检查。事件名采用 `namespace/action`，是在扁平命名空间中避免碰撞的一种约定。

监听器通过 `ctx.on()` 注册，本身就是 Effect。拥有监听器的插件卸载后，它不会继续收到事件，也不需要开发者维护另一份 `removeListener` 列表。这与 Service 撤销采用同一原则：注册和注销必须属于同一个 Fiber。

配套统计实验连续发送三次事件，实际输出：

```text
[stats] tool_call -> 1
[stats] tool_call -> 2
[stats] prompt -> 1
```

这个结果证明发送、类型约定和观察者已经连接起来，但它没有证明事件已持久化。Cordis Event 是进程内协作机制，DeepSeek Harness 的 Session Event 才是会话中的持久事实。名称里都含 Event，不代表生命周期和用途相同；第7章会专门区分二者。

## 进程内通知不是会话事实

Cordis Event 的监听者只存在于当前插件树。进程结束、监听插件卸载或事件错过以后，后来者不能自动重放过去的通知。它适合协调当下的运行行为，却不能独自支撑会话恢复、历史审计或界面刷新。

如果一项信息到达模型请求，或恢复后必须解释“当时发生了什么”，DeepSeek Harness 的原则是把它写成 Session Event，再由 Projection 重建视图。运行中仍可以同时发 Cordis Event 通知观察者，但持久日志才是跨 Context 的事实来源。两者可能描述同一动作，拥有不同生命周期。

设计新功能时可以问两个问题：在线监听者是否需要立即响应；未来恢复者是否必须知道。只有前者为真，可以只用进程内事件；后者为真，就要先定义持久事件及其投影，不能指望某个监听器顺手保存一份私有状态。

如果二者都为真，先追加 Session Event，再发运行通知或让 Projection 驱动界面。这样重连后的客户端与当时在线的客户端能从同一事实得到一致结果。

## 五种分发模式回答五类问题

Cordis 的事件不是全部由 `emit()` 发送。同一个事件应选定一种模式，因为调用者是否等待、监听器是否并发、返回值是否能停止后续处理，都是公开行为的一部分。

可以先把五个名字收进三只抽屉：`emit` 与 `parallel` 都面向多个观察者，区别是调用者是否等待；`serial` 与 `bail` 都寻找首个有效回答，区别是异步还是同步；`waterfall` 则围绕默认行为逐层委托。先判断问题属于哪只抽屉，再选择具体方法。

| 模式 | 调用方式 | 适合的问题 | 返回与停止 |
|---|---|---|---|
| `emit` | `ctx.emit(...)` | “这件事发生了，通知观察者” | 不等待，也不收集结果 |
| `parallel` | `await ctx.parallel(...)` | “这些独立观察者都完成后我才能继续” | 并发等待全部监听器，无业务返回值 |
| `serial` | `await ctx.serial(...)` | “按顺序询问，首个有效回答者胜出” | 依次等待，遇到首个 bail 值停止 |
| `bail` | `ctx.bail(...)` | `serial` 的同步版本 | 同步遇到首个 bail 值停止 |
| `waterfall` | `ctx.waterfall(..., next)` | “围绕默认行为逐层包装或否决” | 返回组合结果；是否异步由事件签名决定 |

`serial` 和 `bail` 中，非 `null`、非 `false`、非 `undefined` 的返回值会成为 bail 值。不要用它们广播必须让所有监听器看到的事实，否则一个监听器返回普通真值就可能阻止后续监听。

`emit`不会等待监听器返回的Promise，但这不意味着普通Cordis通知绝对不会影响发送方：同步抛错仍会向外传播，并阻止后续监听器。若业务要求“所有审计记录已经写完才能提交”，应选择可等待模式或直接调用持久化Service；也不能把emit当成自动隔离错误的后台队列。`parallel`则等待全部监听器结算，再以AggregateError汇总拒绝。

DeepSeek Harness 在 [`agentEvents()`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/core/agent/src/dispatch.ts) 中还对 Agent 作用域的 `emit` 做了专门包装：它把 Agent 主体与作用域载体绑定，并分别容纳监听器的同步异常与 Promise 拒绝，避免一项非否决通知阻止后面的观察者收到事件。这是 Harness 对具体事件族的加强，不应误写成普通 Cordis `emit` 的普遍保证。

## 并发与顺序必须由调用者说清楚

`parallel` 看起来总比逐个等待快，但它只适合彼此独立的监听器。如果两个监听器都会修改同一个请求对象，或第二个依赖第一个写入的字段，并发只会把依赖变成时序竞态。此时应选择有明确顺序的 Service 调用、`serial`，或把修改组织进 Waterfall 的嵌套返回值。

`serial` 也不等于“保证所有监听器依次完成”。它会在首个 bail 值处停止，所以监听器返回 `0`、空字符串或对象时要理解这些值是否会触发终止。根据当前约定，`null`、`false` 和 `undefined` 不构成 bail，其他值可以成为结果。若目标只是依次完成所有副作用，更直接的 Service 方法往往比借用首答事件清楚。

监听器注册顺序同样不应被用作隐含业务优先级。普通情况下按注册顺序分发，但插件加载由依赖关系和组合决定，未来增加 Bundle 或重载 Provider 后，读者很难仅从源码位置推导顺序。只有确实需要抢在普通监听器前运行时才使用 `prepend: true`，并在事件约定中说明原因。

为并发事件写测试时，至少断言“全部都完成”和“一个失败怎样影响调用者”；为顺序事件写测试时，至少断言调用顺序、bail 值与未调用的后续监听器。只断言最终结果，会漏掉一次多执行或少执行的观察者。

## Waterfall 的 `next()` 是一份委托

Waterfall 最适合从外向内理解。调用者提供一个默认行为，多个监听器像中间件一样包在它外面。每个监听器拿到原参数和 `next()`：调用 `next()` 表示把决定交给下游；等待结果后再返回，可以包装或改写下游结果；不调用而直接返回，表示当前层拥有最终决定，后面的监听器和默认行为都不会运行。

配套实验有两层监听器：

```ts
ctx.on('demo/transform', async (_input, next) => {
  const downstream = await next()
  return downstream.toUpperCase()
})

ctx.on('demo/transform', async (input, next) => {
  if (input.includes('blocked')) return '** blocked **'
  return next()
})
```

输入 `hello` 时，第一层调用第二层，第二层继续调用默认行为，结果在返回途中被第一层转为大写，所以得到 `HELLO`。输入 `blocked words` 时，第二层直接返回 `** blocked **`，默认行为未执行；返回经过第一层后成为 `** BLOCKED **`。

这不是普通的“依次调用监听器”。监听器1进入后暂停在 `await next()`，下游全部完成，控制权才沿调用栈返回。于是它既能在前置阶段修改请求，也能在后置阶段观察或包装结果。

Waterfall 的关键规则只有一句：只负责观察、补充或允许继续的监听器必须调用 `next()`；只有明确拥有最终结果或拒绝决定的监听器才直接返回。

> 踩坑提醒
> 忘记 `next()` 不会自动抛错。对 Waterfall 来说，“开发者忘了委托”和“策略有意否决”具有相同的控制效果，必须靠测试区分。

## 一个安静得危险的错误

错误实验中的第一个监听器只是想记录输入，却直接返回了原字符串：

```ts
ctx.on('demo/broken', async (input, _next) => {
  console.log(`observer saw: ${input}`)
  return input
})
```

下游还有一个监听器和默认行为，但实际输出只有：

```text
observer saw: hello
final result: hello
```

`downstream listener ran` 与 `default behavior ran` 都没有出现，进程状态码仍为0。这个错误危险之处不在于程序崩溃，而在于程序看起来完成了，还返回一个貌似合理的值。

在 Agent 系统里，相同错误可能让模型请求没有发出、审批没有显示、工具策略不再执行。排查时不要只看有没有异常，而要为每个协作式 Waterfall 测试两条路径：正常条件必须到达默认行为；明确拒绝条件必须证明默认行为没有执行，并返回可解释的拒绝结果。

仓库规则把这个要求写得很明确：Waterfall 监听器必须调用 `next()` 委托，直接返回会短路。阅读 `agent/request`、`agent/pre-step` 或 `approval/request` 一类事件时，遇到未调用 `next()` 的分支，第一问题应是“它是否真的拥有这次决定”。

## 把审批请求看成一条 Waterfall

假设工具准备写入一条维修工单，最内层默认行为是向用户展示审批界面并等待回答。外面可以有几种插件：审计插件记录请求但必须委托；只读策略对读取动作自动放行并直接返回；高风险策略为危险动作补充说明后继续委托；测试插件在隔离环境中提供确定回答。

这种结构比“依次发四个事件”更准确，因为最终只需要一个审批决定。自动放行策略拥有决定时可以短路，默认界面就不应出现；审计插件不拥有决定，忘记 `next()` 就会截断请求；补充说明的插件可以在调用 `next()` 前修改一份受控请求，并在返回后记录最终选择。

测试这条链时需要覆盖三种结果：无策略命中时默认界面被调用；自动策略命中时默认界面没有调用；策略自身失败时系统按公开约定拒绝、报错或继续，不能凭空猜一种降级。对会产生现实后果的动作，异常时静默放行通常是最危险的选择。

DeepSeek Harness 的具体审批、工具策略和持久记录会在第10、11章展开。本章先掌握结构：Waterfall 适合“有一个内置答案，同时允许插件包装或替代”的问题，不适合广播事实，也不适合让多个互不相干的监听器争相执行写操作。

## 类型声明合并把跨包协作接起来

Service 的 `Context` 扩展与 Event 的 `Events` 扩展使用同一种 TypeScript 机制，但负责不同信息：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    equipment: EquipmentService
  }

  interface Events {
    'equipment/queried'(id: string, status: string): void
  }
}
```

Definition 包应拥有这些声明，Provider 实现 Service，Consumer 通过 `import type {}` 让声明进入编译图。这样服务键、方法参数、事件名和监听器签名都能跨包检查。

声明合并也有边界。它只能证明编译时可见的 TypeScript 调用符合接口，不能证明配置一定装入 Provider；运行时是否存在仍由 Profile、Bundle 和 `inject` 决定。它也不能验证来自 JSON、模型工具参数、文件或网络的数据，那些输入进入系统时仍需 Schema 或解析器。

事件约定还应明确分发模式。DeepSeek Harness 的类型化事件在 JSDoc 中用 `@mode` 标记，并由文档生成与校验工具交叉检查声明和调用点。否则同一个事件若有时 `emit`、有时 `waterfall`，监听器无法知道最后一个参数是否为 `next()`，也无法判断返回值是否有意义。

## 注册必须能够撤销

服务、事件和 Waterfall 最终都回到第4章的生命周期问题。`ctx.on()` 返回 disposer，Service 注册属于 Effect，Harness 注册表通常也返回 disposer。下面的工具注册没有把 disposer 存进全局数组：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['tools']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet the named person.',
    parameters: {
      name: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

这项注册归调用插件所有。插件卸载时，工具应从注册表中消失；否则模型下一次请求仍可能看到旧 Schema，工具执行层却找不到正确实现。仓库约定“注册返回 disposer”不仅为了代码风格，而是保证能力清单、运行实现和生命周期不会分叉。

旧版无Key实验曾直接调用当时的 `ctx.tools.execute()`，观察 `tools/result` 和 `[tool-logger] greet -> Hello, Cordis!`。那证明的是旧提交中的工具注册、执行与渲染，本轮未重跑。当前ToolsService的execute接收ToolBatchInput并选择插件提供的ToolExecutor，不能把旧单调用脚本当成当前API教程。上段只演示注册；批次、准入和持久结果归属见第10章。

如果自己设计注册表，至少要回答四个问题：同名注册怎样冲突；注册属于哪个作用域；disposer 重复调用会怎样；正在执行的调用与注册撤销相遇时如何结算。只提供 `register()` 而没有可等待的撤销路径，热替换迟早会暴露竞态。

## 在真实 Agent 流程里寻找三种协作

带着选择标准回到 DeepSeek Harness，可以更快读懂事件名背后的责任：

- `ctx.llm`、`ctx.tools`、`ctx.sessions` 和 `ctx.agents` 是稳定能力，适合 Service 方法。
- 状态更新、工具结果等需要多个观察者获知的事实，可使用通知型事件；是否持久化还要看它是否同时写入 Session。
- `agent/pre-step` 和 `approval/request` 允许插件包装或回答一个决定，使用Waterfall。旧 `agent/request` 仍存在但已deprecated，不能再用它重新选择本Step模型或修改消息。

[`agentEvents()`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/core/agent/src/dispatch.ts)还做了一件容易忽略的事：它同时绑定 Agent 主体与作用域载体，再向 Cordis 分发。这样“事件 payload 里的 Agent”和“寻找监听器时使用的作用域”不会指向两个对象。多 Agent 系统若只把 `agentId` 放进 payload，却仍在全局作用域分发，很容易让一个 Agent 的策略或工具观察到另一个 Agent 的事件。

阅读一项协作时，可以沿三个方向核对：事件或 Service 在哪里声明；谁提供或发出；谁消费或监听。只找到其中一个文件，不足以解释完整行为。第3章介绍的 Definition、Provider、Consumer 三角色，在这里可以直接落到类型、运行实例和调用点上。

## 先跑通两个对照，再实现文本服务

写综合实验以前，可用两个历史案例校准观察方式。下列命令只适用于旧提交checkout，需先复制随书legacy源码并按旧要求安装构建；它们不是新版Harness应用入口，也未在本轮重跑。每段命令从旧仓库根目录开始，不需要API Key。研究新版时，应从dsh profile挂载自己的插件，并按当前事件测试取得新证据。

先运行 Service 对照：

```sh
cd tmp/cordis-tutorial/03-services/ready
env TSX_TSCONFIG_PATH="$PWD/../../../../tsconfig.base.json" \
  node --import tsx ../../../../vendor/cordis/bin.js
```

命令应以状态码0结束，并只输出 `Hello, world!`。这个结果证明消费方取得了服务；把 Provider 从配置中移除以后，命令仍可能以状态码0结束，但消费方保持 `PENDING` 且没有输出，所以状态码0不能单独证明依赖已经满足。

再从仓库根目录运行遗漏 `next()` 的对照：

```sh
cd tmp/cordis-tutorial/04-events/broken-waterfall
env TSX_TSCONFIG_PATH="$PWD/../../../../tsconfig.base.json" \
  node --import tsx ../../../../vendor/cordis/bin.js
```

错误版本同样以状态码0结束，却只出现 `observer saw: hello` 和 `final result: hello`。把第一个监听器改成 `return next()` 后，`downstream listener ran` 与 `default behavior ran` 都应恢复，最终结果变为 `default result`。验收重点是两行下游证据从缺失变为出现，不是退出码从失败变成成功。

接下来把本章机制组合成一个文本服务。`TextService` 只负责规范化文本，调用方通过 `inject = ['text']` 取得它；`demo/text-request` Waterfall 负责围绕这项默认行为叠加上下文和拒绝策略。

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    text: TextService
  }
  interface Events {
    'demo/text-request'(
      request: { input: string; source: string },
      next: () => Promise<string>,
    ): Promise<string>
  }
}
```

第一层监听器可以把来源写入日志，然后 `return next()`；第二层检查输入是否包含禁止词，命中时直接返回 `REQUEST_BLOCKED`，否则继续委托；最内层默认行为调用 `ctx.text.normalize(request.input)`。

综合实验应以状态码0完成，并至少断言四件事：普通输入到达 Service；普通输入依次经过两层监听器；禁止输入返回 `REQUEST_BLOCKED` 且没有调用 Service；卸载策略插件后，普通 Service 仍可运行，策略监听器不再出现。最后一项把本章重新接回生命周期：协作机制只有可以撤销，才真正具备插件化价值。这组无 Key 对照只验证进程内协作，不证明事件已经持久化，也不证明真人审批界面已经工作。

## 服务与事件选择表

| 需求 | 首选机制 | 理由 | 需要警惕 |
|---|---|---|---|
| 查询或修改一项有所有者的能力 | Service 方法 | 调用者需要明确结果与错误 | 不要导入具体 Provider |
| 缺少能力时插件不能正确运行 | `inject` | 让 Fiber 等待并持续跟踪依赖 | 不要靠 YAML 顺序 |
| 能力可选且有完整降级 | `ctx.get()` | 插件可以在缺失时继续工作 | 降级不能静默损害安全 |
| 发送无需等待的通知 | `emit` | 发送方与观察者解耦 | 异步监听结果不会被等待 |
| 等全部独立监听器完成 | `parallel` | 并发等待所有观察者 | 监听器不应争夺单一结果 |
| 按顺序寻找首个回答 | `serial` / `bail` | 首个 bail 值停止链条 | 普通真值可能意外短路 |
| 包装、改写或否决默认行为 | `waterfall` | `next()` 显式表达委托 | 观察者忘记 `next()` 会截断下游 |

这张表不是绝对规则，但能迫使设计者先说清调用关系。若一项需求同时需要持久事实、直接查询和策略拦截，通常应拆成多个接口，而不是创造一个承担所有责任的“万能事件”。

## 排查协作问题的六步法

1. 记录服务键或事件名，不先搜索具体实现类名。
2. 找到声明合并位置，确认参数、返回值与事件分发模式。
3. 找 Provider 或发送方，确认它在哪个 Fiber、哪个作用域注册。
4. 找 Consumer 或监听器，核对 `inject`、`ctx.get()` 与 `next()` 分支。
5. 在运行时区分 `PENDING`、`FAILED` 和已激活但未收到事件。
6. 卸载提供方或监听插件，验证服务、监听器和注册贡献确实消失。

遇到“什么也没发生”，重点看依赖状态和作用域；遇到“只执行到一半”，重点看 bail 值和 Waterfall 是否委托；遇到“执行了两遍”，重点看旧 disposer 是否运行。把症状与机制对应，比在日志里盲目增加输出更有效。

## 本章源码阅读路线

1. [`服务教程`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/cordis-tutorial/03-services.zh.md)：观察 Service 注册、声明合并、`inject` 与 PENDING。
2. [`事件教程`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/cordis-tutorial/04-events.zh.md)：运行 `emit`、正常 Waterfall 与遗漏 `next()`。
3. [`Service API`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/cordis-api/service.zh.md)与[`Event API`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/cordis-api/events.zh.md)：核对返回、等待和撤销约定。
4. [`Cordis Primer`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/cordis-primer.zh.md)：只读分发模式与 Waterfall 语义。
5. [`agentEvents()`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/core/agent/src/dispatch.ts)与[Agent Loop 拦截测试](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/core/agent-loop/tests/interception.spec.ts)：观察 Agent 作用域中的 `emit`、`serial`、`waterfall` 和 `next()`。
6. 第2周实验记录：把声明与终端输出逐项对应。

第一轮不需要进入 Cordis 内部回调数组和 Fiber 调度算法。能够解释“谁拥有能力、谁等待能力、谁观察事实、谁拥有决定”，已经足以继续阅读 Harness 的插件组合。

## 动手练习

### 练习一：让服务中途消失

启动 `greeter` 与消费方后，显式 dispose 提供方。记录消费 Fiber 的状态和清理输出，再重新挂载提供方，确认消费方用新实例加载。不要只重启整个进程。

### 练习二：为五种模式各写一个断言

分别验证 `emit` 不等待异步结果、`parallel` 等全部监听器、`serial` 停在首个 bail 值、`bail` 只接受同步处理、Waterfall 的默认行为只在所有层委托后运行。断言调用次数与顺序，不只断言最终字符串。

### 练习三：修复遗漏的 `next()`

先运行 `broken-waterfall`，保存缺失的两行输出；再让观察监听器 `return next()`，确认下游和默认行为恢复。最后增加一个明确拒绝分支，证明短路行为只在该条件下发生。

### 练习四：给制造业 Agent 设计三类接口

为“查询设备状态、记录查询审计、拦截高风险写操作”分别写出 Service 方法、通知事件和 Waterfall 签名。标明每项能力的提供方、消费方、持久化要求、失败行为和 disposer。

## 本章回顾

Service 用稳定名称承载可直接调用的能力，`inject` 让依赖成为 Fiber 的持续运行条件；Event 让发送方与观察者解耦，五种分发模式分别表达通知、等待、首答和包装；Waterfall 用 `next()` 明确当前监听器是在委托还是拥有最终决定。TypeScript 声明合并连接编译时类型，注册返回的 disposer 则连接运行时生命周期。

一个 Agent 能否更换模型、工具、存储或审批策略，取决于这些协作关系是否都通过可撤销的注册表达。下一章将继续检查组合机制：不再研究插件之间怎样通信，而是追踪 `dsh` 如何用 Profile、Bundle 和 Patch 选择整棵插件树，决定某次启动究竟拥有哪一组能力。
