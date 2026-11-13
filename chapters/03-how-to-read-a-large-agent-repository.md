# 第3章 大型仓库不是从第一个文件读到最后一个

第一次运行 `rg --files packages | wc -l`，终端会给出一个足以让人失去耐心的数字。继续打开 `packages/`，又能看到 core、llm、shell、fs、session、subagent、workflow、client、host 等一长串分组。

源码阅读经验不多时，我们很容易采用一种最勤奋、也最容易失败的方法：从目录第一项开始，一个文件接一个文件地读。看到 import 就跳到被导入文件，再顺着下一层 import 继续走。两小时以后，浏览器开了二十个标签，笔记里记满类型名，却回答不了“谁真正执行了 Bash”。

大型仓库不是一本按文件名排好页码的小说。它更像一座已经运行的工厂：目录告诉你车间在哪里，服务接口告诉你工序怎样交接，测试告诉你产品必须表现成什么样。阅读时要从问题出发，先找责任所有者，再进入实现。

这一章会建立一套五步定位法，并用“模型提出一条 Bash 命令以后，谁真正执行它”做完整练习。完成以后，你不必记住所有包，只要能够判断该看哪一层、在哪里停止。

## 先把仓库压缩成六个区域

根目录 [`AGENTS.md`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/AGENTS.md) 给出了完整布局，但第一次阅读不需要把每个目录展开。先保留六个区域：

| 区域 | 当前阶段要知道什么 | 阅读策略 |
|---|---|---|
| `apps/` | `cli` 是受支持的 Node 应用入口，`web` 是浏览器前端工程 | 追启动时进入，暂不读组件细节 |
| `packages/` | Harness 的服务、Provider、工具、Bundle 和客户端能力 | 按问题选择一个分组 |
| `docs/` | 架构、子系统、用户教程、Cookbook 和生成参考 | 先读地图，再进源码 |
| `scripts/` | 构建、生成器和仓库检查的所有者 | 只有命令或生成物有疑问时进入 |
| `python/` 与 `native/` | Python SDK/runtime 和平台本地能力 | 主线完成后定向阅读 |
| `.agents/` 与 `vendor/` | 当前决策记录、工作规范，以及固定版本的 Cordis 源码 | 查理由时定向进入；第一轮不进入 vendor |

`snapshots/`、`website/`、`config/` 等目录当然也有用途，但不必在第一张地图里拥有同样权重。地图的价值不是收录完整，而是告诉你现在可以不读什么。

再看 `packages/`，也不要把每个包抄进笔记。先按责任归成几类：

- `core/` 保存产品主干：Session、System Prompt、Tools、Agent 和 Agent Loop。
- `llm/` 负责模型能力词汇与不同 Provider Adapter。
- `shell/`、`subprocess/`、`fs/`、`sandbox/` 等分组负责真实执行能力。
- `session/`、`compaction/`、`context/` 等分组扩展持久数据和模型上下文。
- `subagent/`、`jobs/`、`workflow/` 负责不同形式的任务协作。
- `bundle/`、`boot/`、`preset/` 负责把能力装入应用或单个 Agent。
- `host/`、`client/`、`api/`、`sdk/` 和 `acp/` 负责不同访问和表现方式。
- `test-support/`、`runtime-diagnostics/`、`examples/` 和 `util/` 提供支持能力，不是第一轮业务主线。

这仍然不是需要背诵的清单。你只要知道“模型流去 llm，运行状态去 core，真实动作去能力分组，应用组合去 bundle/boot”，大多数问题就已经有了第一站。

## 把“我想读源码”改成一个可追踪问题

“我想读懂 Agent”太大，无法决定第一个文件。“为什么模型调用 Bash 后没有结果”就具体得多。

一个好问题通常包含四项：

1. 可观察现象：没有工具结果、权限被拒绝、消息没有唤醒或恢复后历史不同。
2. 输入：哪条命令、消息、配置或事件触发了它。
3. 期望输出：应该出现什么事件、返回值或状态。
4. 可能所有者：入口、注册表、Provider、策略、持久化或表现层。

例如，“Bash 是谁执行的”还可以继续缩小：

~~~text
模型看见哪个工具定义？
工具 Consumer 调用了哪个服务？
哪个 Provider 注册了这个服务？
Provider 怎样启动子进程？
沙箱在哪一步包装 argv？
最终结果由谁写回 Session？
~~~

这些问题天然形成一条阅读路径。相比“把 shell 目录读一遍”，它有明确结束条件：当我们能够画出工具、服务、Provider、子进程和沙箱之间的交接，阅读就可以停止。

> 核心建议
> 每次源码学习只写一个主问题。遇到旁支时记录路径和一句用途，不立刻展开。能够主动停下，是阅读大型项目最重要的能力之一。

## 五步定位法从文档开始

我把本书采用的方法压缩成五步。顺序可以因问题略作调整，但不要一上来就钻进最长的实现文件。

下面会提前出现三个英文角色。先记住白话版本就够了：Service Definition 规定调用方式，Provider 真正做事，Consumer 在产品场景里使用这项能力。三者的完整关系会在本章后半段展开。

### 第一步：读架构地图和分组 README

根[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/architecture.zh.md)回答“这项能力处在整套系统哪里”，[`packages/README.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/README.zh.md) 回答“应该先进入哪个包组”，分组 README 再回答“这个组内有哪些角色”。

比如 Bash 问题先查 [`packages/shell/README.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/shell/README.zh.md)。它直接告诉我们：`shell` 是 Service Definition，`bash-local` 与 `bash-sandbox` 是 Provider，`tool-bash` 是面向模型的 Consumer。到这里，我们已经避免误把工具包当成真正的进程执行器。

### 第二步：查看目标包的 package.json

包清单比实现文件更适合建立依赖方向。重点看：

- `name`：公开包名与能力身份。
- `type: module`：当前仓库统一使用 ESM。
- `peerDependencies`：包运行时依赖哪些 Harness 服务或插件。
- `dependencies`：包拥有的普通运行依赖，Bundle 也通过这里携带要分发的包。
- `exports`：哪些入口真正对外公开。
- `dsh` 字段：它是不是 Profile 或 Bundle，以及 Patch 在哪里。

生成的 [`docs/module-graph.md`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/module-graph.md) 使用 `peerDependencies` 作为包间运行依赖信号。图中 `a --> b` 表示 a 依赖 b，不表示函数调用一定从左到右发生，也不表示 b 知道 a 的存在。

例如 `@deepseek-ai/dsh-tool-bash` 的 peerDependencies 包含 shell、tools、agent、sandbox policy、approval 等能力。这个清单说明工具处在多项服务的交汇处，却没有证明每个请求都会调用全部服务。具体条件仍要看公开约定和测试。

依赖数量也不能直接代表实现复杂度。`dsh-base` 的 dependencies 很长，是因为 Bundle 要把一组可安装插件带进 Profile；它并没有在一个文件里重新实现这些能力。相反，一个零依赖工具库可能代码很短，却被许多关键包共同依赖。判断重要性要看它拥有的约定和下游消费者，不要按 package.json 行数排序。

跨包 import 使用公开包名，包内相对 import 才指向本地 `.ts` 文件。看到 `@deepseek-ai/dsh-shell` 时，先把它视为包接口；看到 `./resolve.ts` 时，再把它视为包内实现。这样可以避免把内部辅助函数误当成其他包能够依赖的公共 API。

### 第三步：先读公开类型和模块说明

进入 `src/` 后，先找导出的 Service、接口、配置和事件，不要从辅助函数开始。

常用命令是：

~~~sh
rg -n "export (class|function|interface)|export const" packages/<group>/<pkg>/src
rg -n "declare module '@deepseek-ai/cordis'|interface Context" packages/<group>/<pkg>/src
~~~

[`packages/shell/shell/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/shell/shell/src/index.ts) 导出抽象类 `ShellExecutor`，并把它注册为 `ctx.shell`。它用 `resolve(request)` 形成完整执行规格，再由 `execute(spec)` 返回包含结果与资源控制的 `ShellExecution`。`tool-bash` 只需要依赖 `ctx.shell`，不必知道当前挂载的是本地还是沙箱 Provider。

公共类型会告诉你调用方能依赖什么：参数、返回值、取消信号、失败方式和资源所有权。实现细节可能变化，调用方约定才是跨包协作的稳定入口。

### 第四步：读行为测试

类型告诉你“可以做什么”，测试告诉你“在什么条件下必须怎样表现”。搜索测试标题，不必先读全部准备代码：

~~~sh
rg -n "describe\(|it\(|test\(" packages/<group>/<pkg>/tests
~~~

围绕 Bash 问题，可以优先找前台结果、后台任务、取消、沙箱拒绝和敏感环境变量处理。围绕 Agent Loop，则找零 Step、工具续步、取消和恢复。测试标题能够迅速暴露维护者认为不能退化的行为。

阅读测试时不要逐句翻译。只记录三件事：给了什么输入、观察了哪个公开结果、保护了什么不变量。测试为了构造环境使用的 Mock、临时目录和等待器，不一定属于产品主线。

### 第五步：进入实现并做最小实验

有了责任图和行为预期，再进入具体方法。此时你不是通读文件，而是在回答已经写好的问题：`defineTool()` 的 `execute` 调了谁，Provider 在哪里形成 argv，AbortSignal 传到哪一层，结果怎样返回。

最后运行一个最小实验或聚焦测试。源码阅读只有和可观察行为对应起来，才不会变成类型名收藏。

五步可以记成：

~~~text
地图 → 清单 → 公开约定 → 行为测试 → 实现与实验
~~~

如果在第三步已经得到答案，可以停；如果测试和文档冲突，以当前基线的实际行为继续核对并在事实表记录差异。

## 不同证据回答不同问题

源码阅读不是寻找一份永远正确的说明，而是让不同证据互相校验。类型、测试、文档和运行输出各有盲区。

当前基线源码与 package.json 告诉我们代码实际声明了什么，但只读某个方法可能忽略外层配置和调用条件。行为测试把条件与结果固定下来，但测试只覆盖选择过的场景。架构文档给出责任地图，却不会重复每个字段。Agent Note 保存设计理由，不应代替当前实现。实际运行能证明某条组合路径成立，却不能覆盖所有平台和失败分支。

本书采用的核对顺序是：

1. 固定完整提交，确认正在读同一份源码；标签只作为辅助定位。
2. 从 package.json、公开类型和实现定位所有者。
3. 用行为测试确认输入、失败和终态。
4. 用架构、子系统文档与包 README 解释责任位置。
5. 只有需要理解取舍时，定向阅读仍有效的 Agent Note。
6. 运行最小实验，把代码结论与可观察输出对应起来。

这不是机械的权威排名。比如默认端口由配置源码声明，测试验证覆盖行为，真正启动才能证明当前主机可以监听；三项证据缺一项时，结论就要缩小。

遇到冲突也不要立即选自己更喜欢的说法。先检查版本是否一致、文档是否为生成物、测试是否走真实入口、运行环境是否被宿主沙箱限制。把“源码这样写”“测试这样断言”“当前环境实际这样输出”分别登记，再判断是文档漂移、测试缺口、环境限制还是实现问题。

一个典型历史例子来自旧基线 `cd5ef8148158c3a752a658978873241fdf8e2bbc` 的发布入口E2E。受限沙箱先以 `listen EPERM` 阻止本地监听，相关生命周期用例超时；在允许监听的主机环境原样重跑后，2个文件、23项测试通过。它证明当时那条组合路径成立，不证明当前提交已经通过。本轮没有重跑新版E2E，也不能仅凭首次沙箱失败判断产品实现有缺陷。

把适用范围写进笔记，出版时才能知道哪些数字、命令和平台结论需要复核。

## Service Definition、Provider 和 Consumer 组成 Capability Seam

DeepSeek Harness 把一项可替换能力拆成三个角色：

| 角色 | 回答的问题 | Bash 示例 |
|---|---|---|
| Service Definition | 调用方可以依赖哪些方法和语义 | `dsh-shell` 的 `ShellExecutor` |
| Service Provider | 当前部署用什么方式实现能力 | `dsh-bash-local` 或 `dsh-bash-sandbox` |
| Consumer | 谁把能力用于产品场景 | `dsh-tool-bash` 把它暴露给模型 |

三者合在一起才是一项完整的 Capability Seam（能力接缝）。只有 Consumer，模型虽然看见一个工具，却没有真实后端；只有 Provider，系统能运行命令，却没有模型可调用的入口；只有 Definition，只得到一份接口。

一个包可以承担多个角色，角色拆分也不是为了追求文件数量。只有当定义、实现与使用方式需要独立演进时，拆包才有价值。阅读时先识别角色，比先记包名更重要。

Bundle 又是另一个角色。`dsh-base` 不实现 Bash，它在自己的 Patch 和包依赖中选择并分发 shell、sandbox、subprocess、tool-bash 等插件。换句话说，Definition 规定交接方式，Provider 做事，Consumer 使用，Bundle 决定某个应用把谁装在一起。

普通工具库则可能既不注册服务，也不挂载插件，只提供品牌类型、路径、超时等函数。不要看到所有 `@deepseek-ai/dsh-*` 包就假定它们都是运行时插件。

这套角色划分不只适用于 Bash。文件系统能力也可以用同一方法定位：`dsh-fs` 声明 `ctx.fs`，`dsh-fs-local` 与 `dsh-fs-sandbox` 提供不同执行环境，`dsh-tool-fs` 和搜索工具把受控操作暴露给模型。模型Adapter则由 `dsh-llm` 定义注册和流式词汇，Agent Loop消费统一流。当前 [`llm-deepseek-api-key`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/llm/llm-deepseek-api-key/src/index.ts) 注册 `deepseek-official`，Account插件提供另一条注册路径；共享 `llm-deepseek` 包负责协议实现与导出，不能把它的index当成唯一Provider注册入口。

不同分组使用相同阅读问题：谁声明调用方约定，谁注册当前实现，谁消费服务，哪个 Bundle 把它们组合起来，结果写到哪里。如果某个分组无法回答其中一项，可能是角色合并在同一包，也可能是这项能力尚未形成完整组合，不能仅凭目录名称补全答案。

## 跟着 Bash 走一次完整反向追踪

现在正式回答开头的问题：模型提出 Bash 调用以后，谁真正执行它？

第一站是 [`packages/shell/tool-bash/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/shell/tool-bash/src/index.ts)。它声明对tools、shell、systemPrompt、shellEnv和workingDirectory的依赖，再通过 `ctx.tools.register(defineTool(...))` 注册模型可见的 `bash` 工具。`ToolsService`保存定义并选择执行器；共享流水线完成准入后，由 `defineTool` 的执行入口校验参数，工具主体再把请求交给 `ctx.shell`。

第二站是 [`packages/shell/shell/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/shell/shell/src/index.ts)。当前入口为 `resolve()` 与 `execute()`，不再是旧版的前台run和后台start。Consumer从 `ShellExecution` 观察结果并管理资源；Bash工具还可把前台等待超时后的任务提升为Job，第11章再解释。Consumer依赖的是这项服务，不依赖某个具体操作系统实现。

第三站是Provider。POSIX本地实现 [`LocalBashExecutor`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/shell/bash-local/src/index.ts) 继承 `ShellExecutor`，通过 `ctx.subprocess.spawn()` 启动 `bash -c`。沙箱实现 [`SandboxBashExecutor`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/shell/bash-sandbox/src/index.ts) 也继承本地执行器，但在进程启动前调用 `ctx.sandbox.confine(['bash', '-c', command], policy, signal)`，取得受限制的argv及准备资源。

第四站是 subprocess。`SubprocessRuntime` 定义进程创建、输出读取、终止升级和进程树停稳等约定，`subprocess-local` 提供本地主机实现。真正创建操作系统子进程的是这层 Provider，不是工具描述。

第五站是结果回路。Shell Provider返回结构化执行结果，`tool-bash`将它变成规范工具值与模型内容；共享流水线处理投影和后处理，执行器及共享batch提交 `tool/result`，Agent Loop再决定是否向模型发起下一Step。`ToolRuntime`仍是导出别名，但不能据此把注册、调度和持久化都归为一个旧Runtime的方法。

主线因此是：

~~~text
模型 tool-call
  → ToolsService选择ToolExecutor与共享流水线
  → tool-bash Consumer
  → ctx.shell / ShellExecutor
  → LocalBashExecutor 或 SandboxBashExecutor
  → ctx.sandbox 包装 argv（沙箱路径）
  → ctx.subprocess.spawn
  → 操作系统进程
  → Shell result
  → tool/result
  → 下一次模型请求
~~~

权限审批和沙箱不是 `ShellExecutor` 接口的同义词。共享工具流水线通过策略、审批与守卫决定是否分发；Sandbox Provider负责限制进程效果；Subprocess负责启动和清理进程；Shell Provider负责命令请求与结果。一次Bash调用会经过它们，但每层拥有不同事实。

这个追踪不要求读完五个分组。我们只打开每个交接点的公开类型、注册位置和关键调用。旧版无Key Headless冒烟曾证明当时Loader树能够完成Bash往返并持久化Turn；当前只核对源码和测试断言，仍需读者在新版环境重跑。两类证据分别登记以后，这次定位问题就可以停止。

## 用搜索保持方向，不靠编辑器标签页

`rg` 的价值不只是速度快，更重要的是让搜索问题保持明确。每次命令只找一种证据。

找公开入口：

~~~sh
rg -n "export (abstract )?(class|function)|export interface|export const" \
  packages/shell/shell/src
~~~

找 Context 服务声明和使用者：

~~~sh
rg -n "interface Context|ctx\.shell|inject.*shell" packages/shell
~~~

找工具注册与执行主体：

~~~sh
rg -n "defineTool\(|ctx\.tools\.register|async execute" \
  packages/shell/tool-bash/src
~~~

找事件生产者和消费者：

~~~sh
rg -n "ctx\.(emit|parallel|serial|waterfall|bail)|tools/|agent/" \
  packages/core packages/shell
~~~

找包的行为测试：

~~~sh
rg -n "describe\(|it\(|test\(" packages/shell/*/tests
~~~

搜索结果仍然很多时，用路径继续收窄，不要立刻增加十个关键词。比如你只关心 `ShellExecutor.execute()`，先限定 `packages/shell/shell` 与直接Provider；只有返回值涉及进程终止时，才进入 `packages/subprocess`。

搜索事件名时要保留斜杠和完整前缀。`result` 会命中大量普通变量，`tool/result` 才指向会话事实；`execute` 可能是任意函数，`tools/execute` 才是工具 Waterfall。可搜索的稳定机制名比自然语言描述更适合作为跨包坐标。

编辑器的“跳转到定义”适合从一次调用到一个类型，却容易让人忘记来路。每跳一层，在纸上补一条箭头：调用方、公开约定、实现方、返回事实。箭头无法命名时先停下，不要继续跳。

还有一个实用习惯：先用 `rg --files` 确认文件真的存在，再引用路径。大型仓库会重命名和重组包，搜索旧文章里的路径可能得到空结果。正文使用相对路径加类型或函数名，不依赖容易漂移的行号。

## 读测试先看四个锚点

一个行为测试常常比产品代码长，因为它要搭建 Context、注册 Mock、等待异步结束并清理临时目录。逐行阅读这些准备代码，很容易再次失去主问题。

先找四个锚点：测试标题、触发动作、关键断言和清理。以 Headless keyless smoke 为例，标题已经说明目标是“启动真实 Loader 树、运行真实 Bash 工具往返并持久化 Turn”。触发动作是用测试配置运行一项 `prove the tool path` 任务。关键断言只有几组：事件中出现名为 `bash` 的 `tool/call`，`tool/result` 与最终输出包含 `CLI_TOOL_ROUND_TRIP`，持久文件解压后拥有 Session header。临时目录和 Mock LLM 只是让这条路径可重复。

把它记录成行为卡片：

~~~text
输入：Headless 任务 prove the tool path
组装：真实 Loader + 可控模型 + 真实 Bash + Session Persistence
观察：bash call/result、最终输出、持久 Session header
保护：发布组合的工具往返和持久化能够闭合
不证明：真实 DeepSeek 模型会选择 Bash，也不证明生产沙箱安全
~~~

再看失败测试时，寻找稳定错误或终态，而不是只记 `toThrow()`。好的失败行为通常回答：主体是否执行、事件是否写入、资源是否清理、下一项工作能否继续。只有错误字符串而没有状态后果，往往不足以解释运行机制。

最后查看 `afterEach`、`finally` 或 Fiber dispose。Agent 系统中的测试如果没有清理进程、监听器和 Context，单项通过也可能给后续测试留下污染。清理代码不是产品主线，却是判断测试证据是否可靠的一部分。

## 生成图用来导航，不用来代替阅读

[`docs/module-graph.md`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/module-graph.md) 是根据包清单生成的依赖图，适合做两件事：从目标包查看直接依赖，以及发现某项 Definition 被哪些 Consumer 使用。

它不适合直接推断运行顺序。依赖某个服务，只说明包需要这项能力；Cordis 可能等待 Provider 出现后才激活插件。图也不会告诉你某个 Waterfall 在运行时是否短路，或某次请求选择了哪个 Provider。

正确用法是：先在图里缩小候选，再回到配置树确认实际装入的插件，最后用公开类型、事件和测试确认行为。静态依赖图、运行配置树和 Session 事件流分别回答“代码可能依赖谁”“这次装了谁”“这次实际发生了什么”。

> 踩坑提醒
> 不要把 import 图当调用链，也不要把 Bundle 的依赖清单当实际事件顺序。静态关系和运行事实需要不同证据。

## 第一轮主动跳过这些地方

会读什么很重要，会暂时不读什么同样重要。

第一轮可以跳过：

- `vendor/` 中的 Cordis 源码。第4—5章用最小插件建立直觉以后再定向进入。
- `experimental/` 的私有原型。它们不代表正式产品入口。
- `test-support/` 的全部辅助实现。只在看不懂某个测试装置时追一层。
- 生成文档和生成代码的实现细节。先把生成结果当查询入口，需要修改生成规则时再找生成器。
- Win32、Linux 和 macOS 的全部平台分支。安全或进程问题出现时选择当前平台路径。
- Web 前端组件树。除非问题本身是界面渲染，否则先追 Session 和 API 所有者。

跳过不等于永远不学，而是为当前问题设置预算。旁支可以记进“停车场”：路径、一句话用途、以后在哪章回来。这样既不丢线索，也不打断主线。

## 给每个核心包只记一张卡片

第一次读一个核心包，不需要写十页摘要。使用下面的卡片即可：

~~~text
问题：我为什么来到这个包？
包名与分组：
角色：Definition / Provider / Consumer / Bundle / Library
提供的 ctx 服务或注册项：
依赖的服务：
关键持久事件：
关键实时事件或 Waterfall：
公开入口：
一个成功行为测试：
一个失败或取消行为测试：
我能闭卷复述的主线：
暂时跳过：
~~~

卡片里的“为什么来到这里”最关键。同一个包可能参与多条主线，本次只记录与当前问题有关的部分。以后研究后台任务或 Windows 进程树时，再补新的卡片，不必第一次就把所有配置字段搬进笔记。

## 亲手完成一次定位练习

关闭这一章，重新从“谁负责执行 Bash”开始，不查看上面的答案。

1. 从 [`packages/README.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/README.zh.md) 找到 shell 分组。
2. 用 shell 分组 README 区分 Definition、Provider 和 Consumer。
3. 查看三个 package.json，画出 `tool-bash → shell ← bash-local` 的依赖关系。
4. 在公开类型中找到 `ShellExecutor`，在 Consumer 中找到 `ctx.tools.register()`，在 Provider 中找到 `ctx.subprocess.spawn()`。
5. 增加沙箱路径，找到 `ctx.sandbox.confine()`。
6. 阅读相关测试标题，再使用[第1章](01-agent-is-not-chat-api.md)的 Headless keyless smoke 命令，确认 Bash 调用和结果进入 Session。

最后用三分钟向另一个开发者解释这条链，过程中不允许说“反正框架会调用”。每一个“会”都要有明确所有者。

## 本章回顾

本章的验收产物只有三份：一个包含输入、现象和期望结果的问题卡片；一条从 Consumer 到 Service Definition、Provider 和结果事实的责任链；一项能够重复的运行证据。三份材料齐全，当前问题就可以停止阅读。

当你能够从现象走到所有者，再从所有者回到运行证据，大型仓库就不再是一堆等待通读的文件。下一章我们会进入 Cordis，用一个最小插件理解这些服务和注册项为什么能够随 Context 装载、等待和撤销。
