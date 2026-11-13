# 第2章 跟着一条消息走完整个系统

在 Web 页面里输入一句“查询 A-17 库存并给出建议”，按下发送以后，界面很快出现模型文字、工具卡片和最终回答。

从用户视角看，这像是一轮对话。从源码视角看，它至少经历了输入入队、Agent 唤醒、Turn 打开、Step 准入、模型请求、流式分片、工具调用、结果回写、第二个 Step 和 Turn 结算。

如果把这些动作都叫作“一轮”，后面阅读源码时会不断迷路：工具调用属于模型响应还是独立执行？一次模型请求结束以后，为什么 Agent 还在运行？界面显示的流式文字和恢复时读取的历史是不是同一份数据？

这一章先建立一张全局地图。我们暂时不研究每个分支的实现，只给 Turn、Step、Inbox、模型请求、工具结果和 Session Event 找到位置。读完以后，你应该能够从一条用户消息一路追到 `turn/end`，并知道下一步应该去哪个包寻找证据。

## 先给六个概念找到位置

DeepSeek Harness 的轮次主线可以压缩成下面这张图：

~~~text
用户或应用
  │ followup(message)
  ▼
Agent Inbox
  │ 唤醒驱动器、领取输入
  ▼
Turn
  │ 一个或多个 Step
  ▼
Step ──► 模型请求 ──► Assistant 流
  │                         │
  │                         └─ 可能产生工具调用
  ▼
ToolsService + ToolExecutor ──► tool/result
  │
  └─ 仍欠模型解释时，进入下一个 Step

所有持久事实 ──► Session Event 日志
实时状态与控制 ──► agent/*、tools/* 等事件
~~~

先用白话给六个概念下定义：

| 概念 | 它解决的问题 | 结束点 |
|---|---|---|
| Inbox | 尚未被当前运行领取的输入放在哪里 | 输入被领取、丢弃或取消 |
| Turn | 一项用户能够理解的工作何时开始和结算 | 系统确认不再欠工作 |
| Step | 一次模型请求和它直接产生的工具处理怎样结算 | 请求失败，或模型和工具处理完成 |
| 模型请求 | 本次给模型看什么配置、提示词、历史和工具 | 模型适配器（Adapter）结束流式输出或报错 |
| 工具调用 | 模型提出的动作怎样被校验、限制和执行 | 每个调用形成结果 |
| Session Event | 哪些已发生事实必须可回放和恢复 | 只追加，不覆盖旧事实 |

这里最重要的区分是：Turn 不等于一次模型请求。一个 Turn 可以没有 Step，也可以包含多个 Step。一个Step组织一次逻辑模型步骤及其工具处理，内部还可能重试多个请求attempt。

第一次读这一章，只需抓住三条线：输入先进入 Inbox；一个 Turn 可以包含多个 Step；需要恢复的事实进入 Session Event。Header、Surface、Waterfall 和各种事件名先把它们当作地图坐标，后面章节会逐项展开。

> 核心建议
> 阅读任何 Agent 运行日志时，先标出 Turn 边界，再标 Step 边界，最后把模型调用和工具调用放进去。边界没有画清楚，就不要急着追异步函数。

## 消息先进入 Inbox，不会直接调用模型

具体 Agent Loop 实现通过 `Agent` 句柄对外提供操作。应用创建或恢复 Agent 以后，可以调用 `followup()`、`steer()`、`inject()`、`cancel()` 和 `whenIdle()`。

本章按当前提交核对公开类型与实现。早期学习脚本仍保留在随书资料中，但它们面向旧基线；下面涉及最新事件格式的说明，以源码和当前测试断言为准，不沿用旧脚本的事件总数。

普通用户任务使用 `followup()`。它把消息送到 Inbox 的 `next-turn` 队列，并在 Agent 空闲时唤醒驱动器。消息没有绕过队列直接进入 `llm.stream()`，因为系统还需要记录来源、建立 Turn，并给准入扩展一个拒绝或改写的机会。

Inbox 还有一条 `next-step` 队列，用于中途引导和插件注入的上下文。两条队列的差别不是消息长什么样，而是它们应该进入哪个运行边界：

- `followup()` 进入 `next-turn`，表示一项普通后续工作，并会唤醒 Agent。
- `steer()` 进入 `next-step`，表示在下一个 Step 边界调整当前方向，并会唤醒 Agent。
- `inject()` 也进入 `next-step`，但只暂存背景，不会独自唤醒空闲 Agent。

Agent Loop 第一次为一个 Turn 领取输入时，先取得当前全部 `next-step` 内容，再取得一条 `next-turn` 消息。后续 Step 只领取 `next-step`，不会把已经排队的普通 followup 偷进当前 Turn。

这个顺序保证请求拥有稳定输入。模型正在流式输出时，即使又收到一条 steering，当前请求也不会在构建到一半时被修改。新内容要等到下一个明确的 Step 边界。

Inbox 的变化本身也需要记录。`agent/inbox/spliced` 是持久事件，用插入和删除描述队列变化；`agent/inbox/inserted`、`agent/inbox/claimed` 和 `agent/inbox/discarded` 是实时通知，用于界面或协调插件观察当前动作。

这已经展示了一个贯穿全书的分工：持久事实负责恢复，实时事件负责当前进程里的控制和观察。

## Turn 在领取输入以前打开

驱动器被唤醒以后，Agent 状态从 idle 进入 running，然后 Session 先追加 `turn/start`，再从 Inbox 领取输入。

为什么不是领取成功以后才开始 Turn？因为“系统尝试处理这批输入”本身就是需要结算的事实。输入领取以后还要经过 `agent/pre-step` 准入。监听器可以放行、改写，也可以拒绝。

如果第一批输入被拒绝，日志仍然需要说明它发生过。当前 `turn()` 实现保留以下顺序：

~~~text
agent/inbox/spliced   插入一条 next-turn 输入
turn/start            打开 Turn 1
agent/inbox/spliced   从 Inbox 领取输入
turn/end              Turn 1: blocked
~~~

这条路径不追加 `step/start`，也不进入模型流调用，因此Turn可以包含零个Step。新版还有另一种零Step路径：唤醒消息在领取前被移除，或准入将初始消息改为空，Turn仍以 `completed` 结算。不要把“没有Step”一律解释成策略拒绝。

这不是多余的空记录。如果系统在领取输入后直接消失，恢复时就无法区分“消息仍在排队”“消息已经被策略拒绝”和“程序处理中途崩溃”。`turn/end: blocked` 为这次尝试提供了明确终态。

Turn 也不与 Agent 的 running 状态一一对应。驱动器可以在一次连续活动里处理多个排队 Turn，直到没有新工作才回到 idle。`whenIdle()` 等待的是整个 Agent 完全停稳，不是某条 followup 专属的答案 Promise。

## Step 从准入以后开始

新版在 `agent/pre-step` 之前捕获当前模型选择、解析工具集合并完成提示词组装；准入返回允许以后才追加 `step/start`。Step内再准备请求，按适配器能力提交 `system/message` 与已准入的 `user/message`，从Session派生历史，然后发起模型流。组装、准入和持久提交是不同检查点；准备期间取消，不应留下尚未准入的输入。

成功请求的持久主线是：

~~~text
step/start
system/message*（按本次提示词投影决定）
user/message*
request/header / request/context（需要时）
assistant/message（成功内容与内嵌stream）
tool/call* / tool/result*（如果模型请求工具）
step/end
~~~

新版不再把每个分片追加为独立的 `assistant/chunk` Session事件。运行中通过 `agent/assistant-stream` 发布start、chunk与end帧，流结束后一次提交带内嵌 `stream` 的 `assistant/message`；失败或没有可见内容的取消尝试使用 `assistant/attempt` 保存流。实时帧负责立即显示，最终持久事件负责重放，两者不能重复拼成两份回答。

模型返回普通文本且没有工具债务时，Step 结束，Agent Loop 进入 Turn 的最终停止检查。没有新的 `next-step` 输入，`agent/turn-stopping` 也没有增加工作，Session 最后追加 `turn/end`。

用最小场景理解直接回答：一次idle `inject()` 先暂存“库存快照：轴承剩余18件”，不会打开Turn；后来 `followup()` 发送“告诉我当前库存”，两条内容在首次领取时一起进入Step 1.1。模型没有提出工具调用时，Step完成，再由停止检查决定Turn能否结算。

旧实验曾产生19条持久事件，其中包含6条独立chunk；这属于旧格式记录。新版把分片嵌入结算事件，并增加提示词投影等事实，事件总数不能直接对照。比较两版时，应先比较输入、请求、结果和终态这些关系，再比较具体计数。

## 模型请求不只有 messages

很多模型 SDK 把注意力集中在 `messages` 数组上，但 Agent 请求还要决定 Provider、model、system prompt、工具 Schema、输出限制和运行时上下文。只记录消息，恢复时就可能把同一段历史交给另一套工具或另一份系统提示词。

DeepSeek Harness把模型配置、适配器默认值与工具定义写进 `request/header`。系统提示词通过 `system/message` 保存并由Session派生到模型历史，已不属于Header的 `system` 字段。解析后的Provider、模型身份、上下文窗口及提示词更新方式进入 `request/context`。这些记录共同决定本次请求，不是只读Header就能还原全部输入。

可以把一次请求理解成三部分：

~~~text
请求封装：config + adapterDefaults + tools
模型历史：deriveMessages(session)
持久内容：system/message、developer/message、user/message等
~~~

三部分都必须能够从Session重建。首次请求记录Header；恢复、配置变化或新请求序列有各自的Header原因。系统提示词的变化由其投影处理；工具增删还可能形成 `developer/message`。不要把所有变化都归成“重新写一份system字符串”。

系统提示词不是每个插件随手拼接一段字符串。System Prompt服务组装有序内容，Agent Loop在准入前取得同一步使用的模型与工具集合。模型选择通过 `agent.model.select()` 在Step准备前记录。`agent/request` 仍存在，但已经标为deprecated；现有监听器只能调整允许的请求控制，必须保留已捕获的Provider、model与reasoning effort，不能改消息。新扩展不应继续依赖它选择模型。

LLM Runtime根据Provider路由找到Adapter。Adapter把统一消息翻译成提供方协议，再产生统一 `StreamChunk`。Agent Loop不解析某家厂商的SSE字段，而是用公共流词汇组装内容、用量和完成原因；这些分片由本次流尝试对象同时用于实时发布与最终持久结算。

这条分层为排障提供了清楚顺序：历史不对，先看 Session 投影；工具列表不对，先看 System Prompt 与 Tool Registry；模型路由不对，先看 Header 和 Adapter 注册；HTTP 字段不对，最后进入具体 Provider。

同一个最终回答可能来自不同请求封装。只保存 Assistant 文本，无法证明模型当时拥有哪些工具。对可恢复 Agent 来说，请求配置也是事实。

## 工具结果会让同一个 Turn 继续

再看“查询 A-17 库存并给建议”。第一个模型请求没有直接结束任务，而是返回 `lookup_stock` 工具调用。

模型调用和工具执行之间还有一条受控流水线。Agent Loop先保存收束后的 `assistant/message`，其中包含模型提出的tool-call block；再把调用批次交给 `ctx.tools.execute()`。工具执行批次负责提交 `tool/call` 与有序 `tool/result`，执行器和Provider完成策略、执行与结果处理。Agent Loop拥有Step续行，不直接拥有每个普通工具结果的提交。

工具结果已经回答了“库存是多少”，却还没有回答用户要的“给出建议”。因此，Step 1.1 结束以后，当前 Turn 仍欠模型一次解释，Agent Loop 打开 Step 1.2。

实验中的顺序是：

~~~text
Turn 1
├─ Step 1.1
│  ├─ user/message：查询 A-17 库存并给建议
│  ├─ assistant/message：提出 lookup_stock
│  ├─ tool/call：lookup_stock
│  ├─ tool/result：库存18件，安全库存12件
│  └─ step/end
└─ Step 1.2
   ├─ user/message：补充明天领用5件
   ├─ user/message：建议控制在一句话
   ├─ assistant/message：给出简短建议
   └─ step/end
turn/end：completed
~~~

补充背景和 steering 在工具运行时进入 `next-step`，但它们没有插到工具调用和结果之间。工具执行器及共享批次先完成 `tool/result`，然后 Agent Loop 在第二个 Step 领取补充内容。第二次模型请求按顺序看到原问题、Assistant 工具调用、工具结果和两条新输入。

这条教学路径包含两个Step；具体持久事件数受当前提示词投影、请求序列和流结算格式影响。旧实验的33条事件不构成新版预期值。决定是否继续的，是Agent Loop对工具结果、下一步输入与停止检查的共同判断。

工具可以在特定情况下明确结束 Turn，准入或停止监听器也可以改变后续工作，但普通工具结果通常意味着模型还要阅读结果并回应用户。第9章会进入这些分支；本章只要记住：工具调用不会自动创建一个新 Turn，它通常推动当前 Turn 的下一个 Step。

## 一次工具意图为什么留下三种记录

沿事件看工具时，会遇到一个看似重复的现象：`assistant/message` 里已经有 tool-call block，为什么还需要 `tool/call`，后面又有 `tool/result`？

它们分别拥有不同事实。

`assistant/message` 记录模型这次成功响应的完整内容。对下一次模型请求来说，“Assistant 提出了某个工具调用”属于对话历史的一部分。模型需要看到自己先前使用的调用 id、工具名和参数。

`tool/call` 记录 Harness 准备实际分发的执行事实。策略、审批、并发调度和界面工具卡片可以用调用 id 追踪它。模型产生一段看起来像工具的文字，不会自动成为 `tool/call`；只有经过流式组装并被 Agent Loop 接受的 tool-call block 才进入执行主线。

`tool/result` 记录调用最终怎样结算。普通工具路径的成功、参数错误、策略拒绝、工具异常与取消都需要形成可解释结果；当前结果能否提交还取决于日志写入是否成功。模型历史把结果投影为与调用id配对的消息，因此下一Step知道执行事实。不要把“已经执行”和“结果已持久化”合成一个检查点。

三者的关系是：

~~~text
assistant/message：模型提出了什么
tool/call：系统实际分发什么
tool/result：执行最终发生了什么
~~~

这个区分能挡住一个常见误判。Assistant 写出“我已经创建工单”，只证明模型生成过这句话；只有 `tool/call` 与成功 `tool/result`，再加上业务 Provider 的权威 id，才能证明动作执行。模型文本不能代替业务事实。

工具结果也不一定意味着业务理想。查询成功但列表为空，可以是成功的规范值；数据库无法访问，应是错误结果；人工拒绝写入，同样形成可被模型理解的结果。把这些情况都压成一句“工具失败”，下一步就无法选择正确处理方式。

## Session Event 比模型消息更丰富

如果 Session 只保存 user 和 assistant 两种消息，上面的很多事实会消失：我们不知道工具什么时候实际执行，不知道请求使用哪个模型，也不知道 Turn 为什么结束。

用一条简化天气查询主线观察当前记录关系：

~~~text
turn/start → step/start → user/message
→ request/header → request/context
→ assistant/message（stream内含分片）
→ tool/call → tool/result → step/end → turn/end
~~~

忽略可选的系统与开发者内容，这条主线可派生出用户提问、包含工具调用的Assistant消息与工具结果三类模型消息。Turn/Step边界、请求元数据和内嵌流的每个分片不会各自变成普通模型消息。旧第4周实验的“12事件→3消息”是旧格式的固定输入案例，不能当成新版事件数量公式。

`deriveMessages()` 不是过滤掉“没用的数据”，而是为模型生成一种特定视图。其他 Consumer 有不同需要：

- 模型历史需要 user、收束后的 assistant 和工具结果。
- Web UI需要实时流帧、最终持久流记录、工具调用和状态更新。
- 持久化 Provider 关心每个已提交事件。
- Fork 和恢复需要一段合法、自洽的事件前缀。
- 遥测需要请求、工具与生命周期的时间和终态。

所以，Session Event 是事实来源，模型消息只是其中一种投影。后面的压缩也不会删除旧事件，而是改变模型当前看到的 Surface。

“模型可见即已记录”要求完整请求可从Session重建。当前系统提示词进入 `system/message` 并参与消息派生；工具Schema与路由配置通过Header等记录恢复。分析时既要检查消息内容，也要检查请求元数据与工具历史。

## 实时事件和持久事件不要混用

一次任务同时存在两类观察面。

持久 Session Event 描述已经发生并需要重放的事实，例如 `turn/start`、`user/message`、`assistant/message`、`tool/result` 和 `turn/end`。它们通过 `session/event` 向当前进程广播，已取得的持久化写句柄把事件交给后端。日志提交与耐久写入仍要区分，后者依赖完成的flush检查点，第12章再展开。

实时 `agent/*` 事件携带活跃 Agent 和当前信号，例如状态变化、输入领取、Step 准入和请求改写。工具策略使用自己的 `tools/*` 扩展点。它们适合界面更新、拦截和当前运行协调，但不会自动变成持久日志。

如果一个 UI 只监听实时事件，它能看到当前 Agent 从 running 回到 idle，却无法在重启后重放旧会话。如果一个恢复程序只读持久日志，它能重建历史，却不能用旧 `agent/status` 继续控制一个已经消失的进程。

SDK 或界面要提供可恢复 Transcript，应以 Session Event 为依据，再订阅新增事件；需要取消、steering 或显示当前状态时，才使用活跃 Agent API。内容和控制来自相关但不同的通道。

> 踩坑提醒
> 看到名字里都有 `agent` 或 `session`，不代表它们拥有相同生命周期。先问“进程退出后还需要这个事实吗”。需要就进入 Session；只描述当前协调，就留在实时事件。

## 用户看到一个页面，系统维护两条时间线

Web UI 把流式文字、工具卡片和运行状态放在同一页面，很容易让人误以为它们来自同一数组。实际可以把它们理解成两条相互配合的时间线。

第一条是Session序号时间线。每个持久事件拥有连续seq，事件一旦提交就固定在日志中。`assistant/message` 或 `assistant/attempt` 保存内嵌流，供刷新与恢复后重放；`tool/call` 与 `tool/result` 通过调用id配对；`turn/end` 说明工作怎样结算。实时流帧的chunk index与持久事件seq是两种坐标，不能混用。

第二条是当前进程的活跃时间线。`agent/status` 告诉界面 Agent 是 idle 还是 running，Inbox 通知说明某条输入刚被接受或领取，审批请求等待人的决定，取消操作作用于当前活动。这些对象带有活跃句柄和信号，离开原进程就不能拿旧引用继续控制。

一个可恢复界面先取得Session已有事件，再订阅新增事实，并在实时通道显示尚未结算的流。最终提交到达时，应按attempt identity把实时内容与持久流合并，避免显示两份；`agent/*` 或控制API另外提供运行与取消状态。只订阅实时流，刷新后会失去历史；只读取持久日志，又会缺少结算前的即时输出。

工具卡片也说明两条时间线怎样汇合。模型调用形成 `tool/call` 后，界面可以显示 pending 状态；最终 `tool/result` 到达后，卡片转成成功、错误或拒绝。当前运行的动画属于表现层，调用参数、结果和错误状态属于可回放事实。即使界面换一种样式，也不应该改变 Session 中记录的执行结果。

不要用墙上时钟代替 Session 顺序。两个网络请求完成时间接近、界面渲染异步或日志输出交错时，肉眼看到的先后不一定是模型历史顺序。对单个 Session 的因果分析应先看 seq、Turn、Step 和 callId，再用时间戳分析性能。

这也解释了为什么 `followup()` 的返回不能被当成最终答案。它最多证明消息已经被接受或排队；真正终态要从 Turn 结算、Agent idle 或拥有明确运行句柄的协议结果中判断。输入回执、内容输出和生命周期结算是三件事。

## 失败和取消也必须走到边界

只看成功主线，很容易把 Agent Loop 写成“调用模型，发现工具就继续”的短循环。真正检验生命周期的是失败和取消。

模型请求可能在连接前失败，也可能已经输出部分内容后以错误结束。Step 需要保存已经发生的分片和请求终态，再由错误处理扩展决定是否重试、压缩上下文或保留原错误。不能在 catch 中直接跳回循环开头，否则同一请求可能没有 `step/end`，恢复时也无法判断失败发生在哪个边界。

工具异常通常不是整个 Agent 立即崩溃。共享工具流水线把主体异常收束为错误结果，执行批次提交 `tool/result`，Agent Loop 可以进入下一 Step，让模型解释数据不足或改用其他工具。是否继续属于运行策略，错误结果本身必须先成为事实。

取消更能看出边界价值。根据当前实现，在Adapter已经输出可见文本后取消，应核对以下关系：

1. 为未领取的 `next-step` 和 `next-turn` 输入记录 canceled outcome。
2. 中止当前请求信号。
3. 有可见前缀时，提交带 `interrupted: true` 与内嵌stream的 `assistant/message`；没有可见块时，提交 `assistant/attempt`。
4. 追加 `step/end`。
5. 以 `turn/end: aborted` 结算 Turn。
6. 等待 Agent 回到 idle。

随后发送的新followup可以打开下一Turn。若使用 `cancel(cause, { keepInbox: true })`，排队输入会保留；默认取消则清除待处理输入。中断前缀不能冒充完整成功回答，失败尝试也不能伪造成一条成功Assistant消息。

工具运行中的取消还要等待工具观察 `AbortSignal` 并释放资源；尚未分发的调用与已经运行的调用需要不同结果。第10章再展开工具调度，第12章再讨论恢复。本章只保留一条原则：开始过的工作必须到达可解释终态。

失败路径因此至少要回答四个问题：哪个边界已经打开、哪些事实已经对用户可见、还有什么工作尚未兑现、最终原因记录在哪里。只要这四项不明确，重试就可能重复动作，取消也可能留下后台资源。

## 用一张追踪表读完一条消息

以后分析任何入口，都可以填写下面这张表：

| 阶段 | 要找的事实 | 典型所有者 |
|---|---|---|
| 输入 | 谁调用 `followup()`，消息来源是什么 | Web Controller、Headless Runner、SDK 或插件 |
| 入队 | 进入 next-turn 还是 next-step，是否唤醒 | `Agent` 与 Inbox |
| Turn | 哪个输入打开 Turn，最终原因是什么 | Agent Loop 与 Session |
| Step | 准入决定是什么，本次领取哪些消息 | `agent/pre-step` 与 Agent Loop |
| 请求 | Provider、model、system、tools 和历史是什么 | System Prompt、LLM Runtime、Session |
| 响应 | stream保存哪些帧，最终是否形成消息 | Adapter、流尝试对象、Session |
| 工具 | 调用与结果是否配对，策略是否允许 | ToolsService、ToolExecutor、共享流水线与Provider |
| 续步 | 为什么还欠一次请求，新增输入在哪里 | Agent Loop 与 Inbox |
| 结算 | Step 和 Turn 怎样结束，Agent 何时 idle | Agent Loop |

调试也按这个顺序进行。没有 `turn/start`，先看消息是否入队和唤醒；有 Turn 没有 Step，先看准入决定；有 `assistant/message` 没有 `tool/result`，沿调用 id 检查工具流水线；有结果却没有下一 Step，再检查是否仍欠请求、是否有终止决定；重启后历史不同，则回到 Session 和持久化，而不是修改提示词。

## 读源码时只沿五个入口

掌握全局地图以后，不需要马上通读 Agent Loop。先沿五个公开入口核对主线：

| 阅读入口 | 第一轮只回答什么 |
|---|---|
| [`packages/core/agent/src/runtime-types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/core/agent/src/runtime-types.ts) | Agent 句柄承诺哪些发送、取消和等待语义 |
| [`packages/core/agent-loop/src/inbox.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/core/agent-loop/src/inbox.ts) | next-turn 与 next-step 怎样插入、领取和取消 |
| [`packages/core/agent-loop/src/agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/core/agent-loop/src/agent.ts) 的 `kick()` | 输入怎样让空闲 Agent 获得驱动活动 |
| 同一文件的 `turn()` 与 `step()` | Turn/Step 在何处打开、续步和结算 |
| [`packages/core/session/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/core/session/src/types.ts) | 哪些状态被定义为持久事件 |

先阅读包 README 和公开类型，再找测试标题，最后进入方法实现。`loop.spec.ts` 适合观察普通回答、零 Step、steering 和取消；`tool-calls.spec.ts` 适合观察调用结果与续步；`interception.spec.ts` 适合观察 Step 准入和 Turn 停止扩展。

本次还核对了 `cancel.spec.ts`、`input-lifecycle.spec.ts`、`request-reconstruction.spec.ts` 与 `system-prompt-projection.spec.ts` 的存在和分工。旧稿记录的4个文件、106项通过来自旧基线；当前依赖尚未完成安装与构建，本次没有重新运行这些测试。

读 `turn()` 时，可以在纸上维护一份“工作账”：当前 Inbox 有什么、是否已经打开 Step、模型是否欠结果、工具是否欠结算、停止检查是否增加了输入。不要把注意力放在每个局部变量名上。只要工作账能和事件顺序对应，就已经抓住主循环。

第一轮也应该主动停止。请求错误恢复、并发工具屏障、Compaction、Subagent 与持久化恢复都有各自章节。本章只建立坐标，不把后面所有分支提前塞进来。

## 亲手跑两条路径

随书保留两组旧版无Key实验，命令如下。它们使用旧公开接口和独立chunk事件，只适合在旧基线学习历史实现；不要在最新checkout直接运行后把接口错误解释成Agent设计问题：

~~~sh
node --import tsx/esm tmp/session-event-tutorial/session-event-demo.mjs
node --import tsx/esm tmp/agent-loop-tutorial/agent-loop-demo.mjs
~~~

第一组打印旧格式的原始事件、Surface与模型消息；第二组包含单Step、零Step、工具两Step与取消。若要复现原数字，请使用资料说明中锁定的旧提交，并保持运行环境隔离。

学习新版时，优先按当前 `loop.spec.ts`、`tool-calls.spec.ts`、`cancel.spec.ts` 的测试场景观察相同关系。先完成第1章的新版环境准备，再运行聚焦测试；本次未取得新版测试成功输出，因此不预先承诺状态码和事件总数。验收仍是解释零Step、单Step、工具续步与取消四类终态。

然后做三次修改：

1. 在直接回答路径中增加一条 idle `inject()`，确认它只入队、不独自打开 Turn。
2. 把工具路径的最终文本改成再次调用工具，观察同一 Turn 怎样出现第三个 Step。
3. 在追踪输出中分别隐藏实时事件和 Session Event，写下每种情况下你无法回答的问题。

## 本章回顾

这章的验收不是背出所有事件名。关闭源码以后，只要能画出 `followup → Inbox → Turn → Step → 模型 → 工具 → 下一 Step → turn/end`，并能说明哪些事实需要持久化，就已经建立了全书最重要的坐标系。

下一章我们暂时离开运行时，从仓库地图出发学习定位。因为知道一条消息经过哪些责任以后，面对数百个包时，我们终于可以带着问题找所有者，而不是从第一个文件读到最后一个。
