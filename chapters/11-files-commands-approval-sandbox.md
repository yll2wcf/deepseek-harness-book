# 第11章 文件、命令、审批与沙箱

> 本章源码基线：DeepSeek Harness `0.2.2-rc.2`，提交 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`。下文按当前源码修订；旧版实验记录只作为历史材料，未在本基线上重跑。Web UI 真人审批与各平台实际隔离未验证。

用户看见一条写文件请求，检查目标路径和内容，点击“允许”。几秒以后，Agent 又运行了一条 Bash 命令。

这时最危险的误解是：既然用户已经允许，后面的动作就是安全的。

一次审批只能说明某个应答者同意了某个请求。它不能证明模型参数没有在别处被替换，不能证明当前身份有业务权限，不能限制子进程能访问的文件，也不能保证子进程在取消以后已经退出。真正约束动作的，是从 Tool Consumer 到能力 Provider、执行策略、沙箱和资源释放组成的整条路径。

第10章回答“一次工具调用怎样结算”。本章继续向工具主体里面走，回答另一个问题：当工具真的要读写文件或执行命令时，哪些组件决定它能做什么，哪些风险根本不在这些组件的承诺范围内。

读完本章，你应该能够从`write`或`bash`工具一路定位到 Filesystem、Shell、Subprocess 和 Sandbox 的所有者；能够区分先读后改、一次性审批、权限预设与执行隔离；也能解释用户取消以后，信号怎样最终变成进程树的停止与释放。

## 第一次阅读，先分清两个问题

面对一项可能产生副作用的动作，第一次阅读只问两句话：**这一次是否允许继续？即使允许，真实执行最多能影响什么？** 前一句属于准入，后一句属于效果限制。把两者混在一起，就会误以为一次点击可以替代文件规则、业务授权和操作系统隔离。

| 机制 | 它真正回答的问题 | 它不回答什么 |
|---|---|---|
| Permission Preset | 当前 Session 选用哪组 Sandbox Mode 与 Approval Policy | 不执行命令，也不代表用户已经批准某次动作 |
| Approval | 某次具体请求是否得到`allowed-once` | 不是长期权限，不覆盖 Provider 的业务校验 |
| Sandbox | 被准入的文件或进程动作最多产生哪些已声明的文件效果 | 不判断业务意图，也不自动承诺网络和进程可见性隔离 |

再把执行链记成三个落点：Filesystem拥有文件目标、版本与单文件原子操作；Shell拥有命令请求、默认值、输出和截止行为；Subprocess拥有平台受管理进程范围及其终止。Sandbox对受限Provider的真实效果加约束。

第一遍读到这里，能把一项规则放进上面五个位置就够了。先读后改、输出截断、环境变量过滤、后台 Job和平台 runner 的细节，可以在第二遍沿失败现象回查。

## 不要从工具名称判断安全

“read 是安全的，write 是危险的，bash 最危险”是一种方便但不够用的分类。

读取可能泄露凭据；写入工作区可能覆盖构建脚本；一条看似只读的 Bash 命令可能执行项目中的恶意钩子；一个名字叫`query_status`的业务工具也可能由 Provider 发起有副作用的请求。工具名称只描述模型看到的意图，真正的效果取决于它调用了什么能力、带着什么身份、在哪个执行环境运行。

分析动作风险时，可以把一条链分成六个问题：

| 层次 | 它回答的问题 | 典型所有者 |
|---|---|---|
| 候选意图 | 模型想调用什么，参数长什么样 | Tool Schema 与 Tool Consumer |
| 执行准入 | 这一次是否允许、拒绝或询问 | pre 策略、guard、Approval |
| 能力语义 | “读文件”“运行命令”准确意味着什么 | FS、Shell、Subprocess Service Definition |
| 真实效果 | 哪个实现接触宿主或远程环境 | Local、Sandbox、E2B 等 Provider |
| 资源限制 | 路径、输出、环境、截止时间和进程树怎样受控 | Provider、Sandbox、Timeout |
| 事实结算 | 调用、决定、结果与取消怎样保存 | Session Event 与 Agent Loop |

这六个问题不能由一个“权限开关”统一回答。一个可靠系统需要让每项决定落在真正能执行它的位置。

## 一项能力必须有定义、提供方和使用方

第3章已经接触过 Capability Seam。到了文件和命令执行，它不再只是阅读大型仓库的方法，而是安全分析的基本单位。

完整能力包含三个角色：

1. Service Definition 声明稳定接口、结果和失败语义。
2. Service Provider 在某个执行世界实现接口。
3. Consumer 把这项能力用于模型工具或另一个系统组件。

DeepSeek Harness 中，文件动作与命令动作分别形成两条主链：

~~~text
模型 → read/write/edit → ctx.fs → local / sandbox / remote filesystem

模型 → bash → ctx.shell → bash-local / bash-sandbox
                         → ctx.subprocess → local / remote subprocess
                         → ctx.sandbox（受限模式时包装 argv）
~~~

为什么不让`bash`工具直接调用 Node 的`spawn()`？因为 Shell Consumer 只应负责把模型参数变成命令请求；Shell Provider 拥有默认工作目录、超时、输出和 Bash 语义；Subprocess Provider 拥有真正的进程树；Sandbox Provider 再决定怎样包装 argv。替换成远程执行环境时，工具 Schema 不必改变。

这条拆分还有一个更严格的要求：Filesystem 与 Subprocess 必须处在同一个执行世界。`ctx.fs.processPath()`返回的是子进程能够打开的规范路径，而不是随便把 Harness 宿主绝对路径交给另一个后端。若文件在远程沙箱，命令却在本地主机运行，两者看到的“同一路径”其实不是同一文件。

> **核心建议**：为 Agent 增加有副作用能力时，不要只写 Tool Consumer。把 Definition、Provider、Consumer 三个角色和它们共享的执行世界一起画出来，再决定权限放在哪里。

## Filesystem 先拥有文件身份，再拥有读写方法

[`FileSystem`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/fs/fs/src/index.ts)不是`readFile()`、`writeFile()`的薄包装。它为一个执行世界声明路径解析、稳定目标身份、文本与字节读取、目录列表、原子写入和原子字面编辑。

模型或插件给出路径后，Provider 先通过`resolve()`产生`FsTarget`。目标包含不透明的`targetKey`与用于模型、UI显示的`displayPath`。同一文件通过不同别名访问时，Provider 应维持同一目标身份；调用者不能把`targetKey`当字符串路径解释。

这个区分解决了两个问题。第一，策略可以按文件身份而不是用户拼写记录观察结果。第二，远程或沙箱后端可以使用自己的执行世界路径，不必假装所有文件都在宿主机。

写入与编辑都由 Provider 保证原子性。`writeText()`可以携带`createIfAbsent`或`replaceIfVersion`，`editText()`可以携带期望版本。版本检查、内容匹配和最终发布必须处于同一个临界区；如果 Consumer 先 stat、再读、再在另一个调用里写，中间的外部修改就可能被覆盖。

这也是为什么针对性编辑属于 FS 定义，而不是每个工具自己实现“读—replace—写”。原子能力必须位于真正拥有文件状态的 Provider。

`dsh-tool-fs`是模型 Consumer。`read`负责行号、窗口与大小限制，`write`负责完整创建或替换，`edit`负责字面替换。工具先解析模型参数，再调用`ctx.fs`，最终把 Provider 结果转换成模型内容和可重放 diff 元数据。

基础 FS 接口并不自带“必须先读后改”策略。没有策略插件时，Provider 仍提供完整、原子但无观察前提的写入和编辑。这一点很重要：原子性是能力约定，先读后改是可组合策略，两者不能互相冒充。

当前接口还包括 `patchText()`、`deleteFile()`、`moveFile()` 与 `watch()`。其中移动操作先发布目标、再删除源，是两个效果，并非一个原子事务；结果可能明确报告 `sourceDeleted: false`。设计业务文件工具时，不能把所有名为“move”的操作都当作事务提交。

## 先读后改解决的是新鲜度

[`dsh-fs-observation-policy`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/fs/fs-observation-policy/src/index.ts)不注册新服务，监听 `fs/write-intent`、`fs/edit-intent`、`fs/delete-intent` 和 `fs/observed` 四个事件。它按 Agent Session 和稳定 target key 记录最近一次权威观察：文件存在并带版本，或者确认不存在。已发布的 base 组合默认禁用这个策略；需要将对应条目的 `disabled` 设为 `false`，才能把下述规则作为实际写入前提。

`read`成功后发出`fs/observed`。读取不存在的目标也可以记录“确认缺失”。随后，写入与编辑工具在真正调用 Provider 以前分别询问`fs/write-intent`与`fs/edit-intent`。

写入规则是：

- 已观察到存在，使用`replaceIfVersion`，只替换刚才读到的版本。
- 未观察或已确认缺失，使用`createIfAbsent`，只允许创建，不允许盲目覆盖已有文件。

编辑和删除更严格：没有读过就以`FS_NOT_OBSERVED`拒绝；已确认缺失就以`FS_NOT_FOUND`拒绝；读过则携带观察版本。文件在读后被外部改变时，Provider以`FS_STALE_VERSION`拒绝，模型必须重新读取再重试。观察记录不持久化，恢复会话后应重新读取；读取一个窗口取得版本，也不能证明模型已经读过全文。

这套规则保护的是“我根据哪一版内容做修改”。它不回答当前用户是否有权读这份文件，也不限制路径能否离开工作区，更不能阻止另一个直接绕过 Tool Consumer 调用裸 Provider 的可信插件。

把 observation policy 叫作“文件沙箱”会误导设计。它能防止盲覆盖和陈旧写入，不能隔离执行环境。

旧基线的真实 FS 实验覆盖过创建、未读覆盖拒绝、读后覆盖和 stale 重试。本次只核对当前接口与策略实现，未将旧测试结果计作当前版本验收。

## Shell 是命令能力，Subprocess 是进程能力

[`ShellExecutor`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/shell/shell/src/index.ts)统一通过 `execute(spec)` 返回 `ShellExecution`。调用者先提交`ShellExecRequest`，Provider 的`resolve()`再把可选工作目录、超时、到期行为和输出上限解析成完整`ShellExecSpec`。返回对象既有运行中进程的控制能力，也有 `result()` 结算入口；旧版分开的 `run()` 与 `start()` 已不适用。默认值在明确的 resolve 阶段具体化。

`LocalBashExecutor`把命令转换为`['bash', '-c', command]`，再交给`ctx.subprocess`。每次调用都是新 Shell，`cd`、变量和函数不会跨调用保留；模型需要通过`workdir`表达工作目录，而不是假定上次命令留下状态。

前台 Bash 的`timeoutMs`与第10章的`ToolDefinition.timeoutMs`不是同一个机制。

| 超时入口 | 所有者 | 终止方式 |
|---|---|---|
| Tool Definition 的`timeoutMs` | 工具调用超时策略 | 触发工具`exec.signal`，同进程主体协作停稳 |
| Bash 参数的`timeoutMs` | Bash Tool 与 Shell Executor | 可作为前台等待窗口，超时后提升为 Job；无法提升时才由 Executor 截止并终止 |

`LocalBashExecutor`默认超时120秒，单次覆盖上限默认600秒；这些值来自可配置字段。执行请求的 `onExpiry: 'kill'` 才建立截止，`'none'` 不建立 Executor 截止。

有 Job 注册表且启用 `promoteOnTimeout` 时，前台 Bash 会先注册 Job，再等待前台窗口：及时完成则返回普通结果并移除临时 Job；仍在运行则返回 Job id，命令继续执行。禁用提升、没有 Job 注册表或 Job 准入被拒绝时，回退到 Executor 超时终止。显式 `run_in_background: true` 同样不建立 Executor 截止。因此，“Bash 超时总会杀进程”已经不是当前行为。

命令退出码非零、因信号结束和超时不会一律抛异常。Shell 的结果分别记录`exitCode`、`signal`、`timedOut`和`aborted`。超时与调用方取消按最先发生的原因分类，互不同时置真；一条命令也可能捕获终止信号后以退出码0结束，所以调用者不能只看 exit code 判断是否完整执行。

输出同样有资源预算。Subprocess 可以为 stdout、stderr 设置内存上限，超过后保留尾部，并在可用时把完整输出写进私有 spill 文件；完整流也有上限，超过以后只保留有限尾部。没有这些限制，一条无限输出命令就足以耗尽 Harness 内存或磁盘。

## Subprocess 不解释命令，管理平台进程范围

[`SubprocessRuntime`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/subprocess/subprocess/src/index.ts)接收完整`argv`、`cwd`、stdin/stdout/stderr 方式、grace period、signal 和环境变量。它不做 Shell 解释，也不替调用者猜默认值。Bash 语义由 Shell Provider拥有，LSP或其他 Consumer 可以直接传自己的可执行文件与参数。

Subprocess 还统一处理环境继承。默认父环境会删除名称匹配`KEY`、`PASSWORD`、`SECRET`或`TOKEN`的变量，并删除所有环境中的`DSH_*`；可信调用者只有通过显式 env 或受控`dshEnv`快照才能重新传入需要的值。

这不是完整的数据防泄漏方案。`HOME`、代理、PATH 和普通名称变量仍可能带来信息，显式传入的凭据也会保留。它保护的是“不要无意把 Harness 凭据原样继承给任意子命令”，不是“子进程绝对看不到秘密”。

本地 Provider 为每次 spawn 选择受管理范围。支持的 Linux 环境使用 user-systemd scope；支持的 Windows 普通进程由 helper 持有 Job，并采用 kill-on-close；macOS 与不支持的环境使用较弱的 detached PGID、taskkill 或已观察进程身份回退，并发出提示。命令可能已经在原生路径启动后，绝不能为了“兜底”再用回退路径重放 argv。

为什么不能只杀直接子进程？因为一条命令可以再启动 helper。父进程退出，不代表 helper 已经停止写文件或占用端口。`done`等待直接进程退出与 stdio 收束，`waitForExit()`等待受管理 scope、Job 或组退出；基础设施失败或无法证明范围清空时，等待可以拒绝。较弱回退可能漏掉观察前已经逃逸的后代，因此不能声称 macOS 上可证明整棵后代树退出。

[`LocalSubprocessRuntime`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/subprocess/subprocess-local/src/index.ts)一直持有仍可能存在的句柄。Fiber 正常释放时，它终止并等待受管理范围；Node 同步退出时的最终清理只能尽力执行，无法给出异步停稳保证。SIGKILL、OOM、原生崩溃或断电仍需要外部监督与业务对账。

这正是“dispose 必须达到停稳，而不只是发出停止请求”的含义。若清理函数调用 kill 后立即返回，旧进程仍可能在新插件已经加载、Turn 已经结束或测试已经通过时继续运行。

旧基线的本地进程测试不能覆盖新加入的 systemd scope、Windows Job 与当前 Job 提升路径。本次未运行这些平台集成验证。

## Sandbox 当前限制的是文件效果

[`dsh-sandbox`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/sandbox/sandbox/src/index.ts)定义的不是通用虚拟机，而是一项同执行世界的进程约束能力：输入准确 argv 和每次调用的文件策略，返回应当替代原 argv 的受限 runner argv。

当前`SandboxMode`有三种：

| 模式 | 文件写效果 |
|---|---|
| `read-only` | 不允许普通文件修改，只保留运行所需的极少数 sink |
| `workspace-write` | 允许工作区、显式额外可写根目录和平台临时目录的写入 |
| `danger-full-access` | 绕过 DSH 文件约束 |

这套词汇明确不覆盖网络访问和进程可见性。`workspace-write`也不意味着“只读宿主其他文件”；它描述的是允许写到哪里，不是完整的读取隔离。即使平台 runner 报告`enforcement: full`，这里的 full 也只针对该模式承诺的文件效果，不应扩大解释为容器或虚拟机级安全。

本地 Sandbox Provider 根据平台选择 runner：Linux 优先 bubblewrap，再尝试 Landlock；macOS 使用`sandbox-exec`；Windows 使用受限 token 与 ACL runner。后端会报告`full`或`partial`，其中部分内核 ABI 或 Windows ACL 情况只能诚实标为 partial。没有可用 runner 时，受限模式必须以`SANDBOX_UNAVAILABLE`失败，不能悄悄退化成无沙箱执行。

`bash-sandbox`作为 Shell Provider 的受限实现，先让`ctx.sandbox.confine()`包装`['bash', '-c', command]`，再复用本地进程机制。结果不仅有退出码，还带实际 mode、是否命中文件拒绝、enforcement，以及 runner 是否在命令运行前失败。runner 失败优先于普通拒绝，因为前者意味着命令根本没有开始。

共享策略由 [`dsh-sandbox-policy`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/sandbox/sandbox-policy/src/index.ts) 的 `ctx.sandboxPolicy` 拥有：本次批准的覆盖优先，其次是会话投影中的模式，最后才是部署默认值。该服务的默认模式是 `read-only`；具体 profile 可以另行组合不同默认值。会话有效工作目录决定工作区范围，运行时策略通过可记录的动态上下文告知模型。Windows 的额外根目录适用于文件工具，当前进程约束会忽略这些额外根目录，组合方需要识别这个差异。

本章没有实际运行各平台 runner，只报告当前源码定义的选择与失败语义。

## 文件工具的 Sandbox 与进程 Sandbox 不是同一种强度

`dsh-fs-sandbox`替换普通本地 FS Provider，对写入、编辑、patch、删除和移动增加每次调用的路径围栏。移动在产生效果前检查源与目标两个路径。`read-only`拒绝所有修改；`workspace-write`重新规范化目标，确认位于共享策略允许的根目录，再交给底层操作；`danger-full-access`不加围栏。

这层检查运行在可信同进程代码中，处理的是模型控制的目标路径。它会尽量缩小符号链接切换造成的检查—使用竞态，但源码明确不把它称为内核安全边界。若执行的是不可信代码，真正限制系统调用效果的仍应是 Shell 侧平台 runner、容器、微虚拟机或远程隔离环境。

两类 Sandbox 共享相同模式和 writable roots，是为了让`write`工具与 Bash 对“workspace-write”的解释一致；实现手段仍然不同：一个是在可信 Provider 中检查路径，一个是包装子进程并交给操作系统执行约束。

还要看到读操作的边界。`dsh-fs-sandbox`当前让所有读取直接通过，SandboxMode也只声明文件写效果。若产品要求模型不得读取工作区外文件，需要额外选择隔离执行世界、收窄 FS Provider 或增加读取授权，不能从“开启 workspace-write”自动推出读取已经受限。

## Permission Preset 只是把两个旋钮绑在一起

[`PermissionPresetService`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/interaction/permission-presets/src/index.ts)为界面提供一个易用选择器，却不执行审批，也不运行沙箱。每个 preset 只把两个独立值组合起来：Sandbox Mode 与 Approval Policy。

内置基础预设有两项：

- `workspace-write`：文件模式为 workspace-write，Approval Policy 为 ask。
- `danger-full-access`：文件模式为 danger-full-access，Approval Policy 为 never。

第二项很容易误读。`never`不是“永远不执行”，而是“任何需要审批的 ask 都自动拒绝且不弹提示”。与此同时，danger-full-access让受限 Provider不再限制文件修改。两项值分别由自己的机制解释，preset名称本身没有额外执行权。

切换 preset 时，服务先记录`permission/preset`，再通过各自唯一写路径更新`sandbox/mode`与`approval/policy`。两个会话可以持有不同值，恢复时从 Session Event 重建。若有人分别修改两个旋钮，组合不匹配任何已配置 preset，界面显示派生的`custom`，而不是伪造一个选择。

服务依赖共享 Sandbox Policy、Approval 与 Session Projection。启用相应集成时还可显示固定的 `Auto` 选择，它组合 full access 与 ask，不能成为默认项。`custom` 只是当前两个旋钮组合的显示值，不能作为预设选择。切换只写实际变化的旋钮，已生效的选择不重复写入；配置默认项只影响未来新会话，恢复会话保留已记录的有效权限。

## Approval 只回答这一个问题

[`ApprovalService`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/interaction/user-approval/src/index.ts)处理一次性请求。结果词汇只有`allowed-once`、`rejected`、`cancelled`与`unavailable`，其中只有第一项放行当前动作。

Approval Policy 也只有两种：`ask`把请求交给已组合的人或机器 answerer，没有 answerer时返回 unavailable；`never`在任何 answerer运行前直接拒绝。策略与开放 Turn 状态通过 Session Projection 重建，待答问题和一次性授权本身不跨重启恢复。

审批请求必须发生在开放 Turn 中。服务先追加`approval/asked`，等待决定，再追加同 id 的`approval/decided`；任一审计事件无法提交时，请求直接拒绝 Promise，而不是返回一项没有记录的决定。取消会让问题立即以 cancelled 结算，之后到达的晚答案被丢弃。

请求携带 Agent、工具名、可选 call id 和给人的理由，不重复携带工具参数。界面应通过 call id 关联已经展示的`tool/call`。这意味着审批设计还必须确保用户能同时看见准确参数与理由，不能只给一个“是否允许 write”的模糊按钮。

最重要的是，批准不替代 Provider 校验。人同意创建一张维修工单，业务 Provider仍要验证当前身份、设备范围、字段、状态转换和幂等键。Approval表达人的这次意图，Provider拥有权威系统的访问规则。

## 提权是一次严格变宽的重试

受限 Bash 与 FS 写工具共享同一套 sandbox escalation 规则。模型遇到真实拒绝后，可以在重试同一动作时同时提供`sandbox_permissions`和`justification`。

执行顺序是：验证两个字段必须成对出现；检查请求模式严格宽于当前有效模式；通过 Approval Service 请求一次决定；只有`allowed-once`返回目标模式；最后把更宽模式只盖在这一次调用上。

从 read-only 请求 workspace-write 或 danger-full-access属于变宽，从 workspace-write只能请求 danger-full-access。请求相同或更窄模式会在询问用户以前直接失败。没有 Approval Service、没有 Agent、没有可回答通道、用户拒绝或取消，同样在任何真实动作以前失败。

这条路径不是让模型每次都先申请最高权限。工具说明要求先运行并读取明确的 sandbox denial，再使用足够的最窄模式重试。用户拒绝以后，模型也不应换一条命令或另一个工具绕过同一决定。

一次批准也不会修改 Session 的长期 Sandbox Mode。它只把目标模式写进当前调用的`SandboxExecutionPolicy`。需要改变会话后续策略，应通过 Permission Preset 或 mode 的正式写路径，并留下持久事件。

## 取消是一条从 Turn 到操作系统的责任链

现在可以把第9章与本章接起来。Agent Loop把取消信号交给ToolsService所选执行器，共享pipeline融合调用方与执行包装器信号；Bash Tool把`exec.signal`传给Shell；Shell执行请求再按onExpiry选择是否建立截止。Subprocess收到abort后终止它拥有的scope、Job或回退范围。

~~~text
Agent cancel
  → Step AbortSignal
  → ToolExecution.signal
  → Shell deadline / caller-cancel first cause
  → SubprocessHandle.terminate()
  → 平台受管理范围的终止与等待
  → Shell 等待直接进程关闭（handle.done）
  → Tool result ABORTED
  → step/end → turn/end aborted

SubprocessRuntime 持有受管理范围，waitForExit 不能证明清空时会报告失败
~~~

任意一层只“转发取消”却不等待自己拥有的结算点，链条就会在它那里断开。工具执行批次等待已启动主体Promise，Shell等待直接命令结果；Local Subprocess Runtime继续持有受管理范围，并用`waitForExit()`确认退出或报告无法确认。工具结算与进程范围最终释放是不同时间点，较弱回退不承诺所有逃逸后代均被回收。未分发工具不启动Provider，以`ABORTED_BEFORE_DISPATCH`结算。

后台 Bash 是一个有意的所有权转移。工具返回 Job id 以后，进程不再由这次 tool call signal直接管理，Job拥有后续取消、输出与完成。若在所有权提交前 signal 已取消，后台任务不能启动；提交后则必须用 Job 的停止路径处理。这正是为什么“有个 Promise 在跑”不等于已经设计好后台任务。

## 四种限制要放在不同位置

假设要实现“读取质量日志，生成报告，经确认后写入工作区”，可以这样分配：

| 要求 | 正确位置 | 验证方式 |
|---|---|---|
| 日志 id 必须是字符串 | Tool Schema | 无效参数不进入用户主体 |
| 当前账号只能读一号厂区 | 数据 Provider | 越权 id在服务端拒绝 |
| 覆盖报告前必须看过最新内容 | FS observation policy | 未读与 stale 写入拒绝 |
| 只允许写工作区与临时目录 | FS Sandbox Provider | 工作区外路径产生稳定拒绝码 |
| 需要人确认一次越界重试 | Approval + escalation | 拒绝时真实主体次数为0 |
| 报告生成命令最多运行30秒 | Shell Executor timeout | 进程树停稳且 timedOut 为 true |
| Agent取消后收束其拥有的进程 | Subprocess teardown | 受管理范围退出，无法确认或存在逃逸限制时明确报告 |
| 最终发生了什么可以恢复 | Session Event | call、approval、result与终态配对 |

这张表比“高风险工具都弹窗”更有用。弹窗只是其中一项要求，而且频繁、模糊的弹窗会训练用户无条件点击允许。越接近真实副作用，越要让机器可以在不依赖用户注意力的情况下守住不变量。

## 用运行证据检查边界

初稿使用过第7周工具流水线实验。下面的命令与成绩属于旧基线 `cd5ef8148158c3a752a658978873241fdf8e2bbc`，用于理解当时怎样观察证据；脚本和用例路径未迁移为当前版本可运行教程。当前源码要求 Node `>=24.9.0`，不要直接用旧实验成功推断新版本已经验证。

~~~sh
node --import tsx/esm tmp/tool-pipeline-tutorial/tool-pipeline-demo.mjs
pnpm exec vitest run packages/fs/tool-fs/tests/integration.spec.ts packages/shell/bash-local/tests/executor.spec.ts packages/subprocess/subprocess-local/tests/spawn.spec.ts
~~~

两条命令在登记时状态码均为0。第一条命令中，Mock 应答者先拒绝一个写入，再批准另一个写入；运行后只有批准目标存在。审批拒绝路径的工具主体次数为0，asked/decided与call/result都完整。工具运行中取消时，已开始主体完成清理后得到`ABORTED`，排队主体保持未运行并得到`ABORTED_BEFORE_DISPATCH`。

历史记录中，13个策略相关文件共406项通过，另有3个真实本地能力文件139项通过。这些数字不计入本次源码更新的测试结果。

当前版的验收应观察实际关系：启用观察策略以后，盲覆盖受阻、外部修改触发stale、重新读取才能重试；命令前台超时应区分提升Job与Executor终止；进程应分别检查直接结果和受管理范围等待。任何一项缺失，都不能扩大为整条执行链已经验证。

这些证据仍有明确边界：

- 审批 answerer 是 Mock，不是 Web UI 中的真人操作。
- 本地文件工具在测试临时目录运行，没有验证 FS Sandbox 对真实敏感路径的防护。
- Bash 与 Subprocess 测试验证了本机命令和进程树生命周期，没有验证平台 Sandbox runner。
- 没有验证网络限制，因为当前 SandboxMode本来不承诺网络隔离。
- 没有使用真实 DeepSeek 模型，也没有验证模型能否始终遵守“拒绝后不绕过”的说明。

这类边界不是章节的缺陷，而是安全结论的一部分。单元测试证明某个机制，不能自动升级为整个运行环境已经安全。

## 开发者预览阶段怎样使用

项目根目录的[`SAFETY.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/SAFETY.zh.md)把现状说得很直接：DeepSeek Harness仍是实验性开发者预览软件，尚未接受安全审计，不应视为生产可用的安全软件。它能执行模型生成的命令、加载第三方插件，并接触被授予的文件、网络、进程与凭据。

因此，学习和试用至少遵守下面七条：

1. 优先使用一次性虚拟机、容器或专用测试账户，不在存放重要资料的日常环境里首次试运行。
2. 只挂载实验需要的目录，重要文件先备份，不把整个主目录作为工作区。
3. 不向进程暴露无关 API Key、云凭据、SSH密钥和生产数据库连接。
4. 检查第三方插件与 Profile配置，尤其是能注册工具、Provider和 Waterfall的代码。
5. 默认选择最窄 Sandbox Mode，真实拒绝后才发起一次最小提权。
6. 审批界面同时展示准确动作、参数、目标和理由；看不懂时拒绝，不把“允许”当作排障按钮。
7. 对高后果业务动作保留外部系统的身份、幂等、审计与人工复核，不能只依赖 Agent侧提示词。

沙箱、审批和权限控制都能降低风险，却无法保护已经明确授权给 Harness 的资源。只要 Agent 可以读取某份敏感文件，模型输出、工具日志、spill 文件和第三方插件就都进入风险分析范围。

## Agent 动作风险评估表

为新工具做评审时，可以逐项填写：

| 检查项 | 必须给出的答案 |
|---|---|
| 权威动作 | 真正产生副作用的是哪个 Provider 方法？ |
| 执行世界 | 文件、命令与依赖资源位于宿主、容器还是远程环境？ |
| 输入信任 | 哪些字段来自模型，在哪里做结构与业务校验？ |
| 身份授权 | 谁验证当前身份可以操作这个资源？ |
| 新鲜度 | 动作依赖的状态怎样防止读后变化？ |
| 文件效果 | read-only、workspace-write与full分别允许什么？ |
| 非文件效果 | 网络、进程、凭据和外部 API由什么机制限制？ |
| 审批 | 用户看见什么，批准是否只对应当前调用？ |
| 提权 | 是否严格变宽、只重试一次、拒绝后不绕过？ |
| 时间预算 | 工具预算与命令预算分别由谁实施？ |
| 取消 | signal传到哪里，何时算真正停稳？ |
| 子进程 | 是否终止整树，helper能否遗留？ |
| 输出 | 内存、spill文件和敏感内容怎样受限？ |
| 持久化 | call、decision、result、错误码和最终业务 id怎样记录？ |
| 恢复 | 崩溃后怎样区分未执行、执行中和已经提交？ |

最后一项已经把我们带到下一章。一个动作即使拥有完善的执行期限制，进程也可能在“外部系统已提交、Session结果未写入”之间退出。安全执行与可恢复执行相关，却不是同一个问题。

## 动手练习

### 练习一：证明 observation policy 不是沙箱

显式启用 observation policy，在测试临时目录创建已有文件：未观察时完整写入只能尝试 `createIfAbsent`，已有目标不得被盲覆盖；未观察的 edit/delete 得到 `FS_NOT_OBSERVED`。读后外部修改，再编辑得到 `FS_STALE_VERSION`。最后比较可信插件直接调用 Provider 的行为，说明观察策略不定义目录权限。

### 练习二：比较两种超时

给普通同进程工具声明短`timeoutMs`，让它观察`exec.signal`；再分别启用和禁用 Bash 的 `promoteOnTimeout`，使用短前台窗口运行长命令。比较 `TOOL_TIMEOUT`、Shell `timedOut` 与提升后继续运行的 Job，追踪每条路径由谁停止真实工作。

### 练习三：追踪一次被拒绝的提权

从 workspace-write下构造一条需要工作区外写入的命令。只在一次性隔离环境中执行，先观察 sandbox denial，再以 danger-full-access和明确理由重试并让 Mock应答者拒绝。确认第二次命令主体没有开始，Approval审计完整。

### 练习四：让 helper 抵抗 SIGTERM

使用 Subprocess测试夹具启动父进程和忽略 SIGTERM的 helper。调用 terminate，分别记录直接进程 `done`、受管理范围 `waitForExit()`与所选后端；检查终止升级及错误报告。较弱回退的观察结果不能扩大为所有平台的后代清理保证。

### 练习五：设计一项业务写工具

为“创建维修工单”分别写下 Schema校验、Provider授权、幂等键、pre审批、取消、超时、业务结果和 Session事实。若某项只能写“由提示词提醒模型”，继续寻找真正能够强制执行它的所有者。

### 练习六：审计 Permission Preset

列出当前 Profile最终配置中的 preset表、默认 Sandbox Mode与 Approval Policy。分别切换两个旋钮，观察何时显示`custom`，再解释 preset为什么只是选择器而不是第三种执行机制。

### 练习七：做一次恢复前的风险推演

为文件写入和外部 API写入各选择三个崩溃点：主体之前、外部提交之后但`tool/result`之前、Session提交之后。写清重启时有哪些事实，怎样避免重复副作用。把答案带入第12章。

## 本章回顾

工具名称不是安全边界。Filesystem、Shell与 Subprocess先用 Service Definition固定能力语义，再由具体 Provider把动作落实到本地或远程执行世界；Tool Consumer只负责把模型意图转换成能力请求。

FS observation policy通过已观察版本防止盲覆盖和陈旧修改，解决新鲜度，不限制目录。FS Sandbox在可信 Provider中限制模型路径的写入范围；进程 Sandbox把准确 argv交给平台 runner，约束当前词汇承诺的文件效果，却不承诺网络、进程可见性或虚拟机级隔离。

Permission Preset只组合 Sandbox Mode与 Approval Policy。Approval记录一次问题与一次决定，只有`allowed-once`放行当前请求，不替代 Provider授权、幂等和业务规则。提权必须严格变宽、先批准再执行，并且只作用于这一次重试。

取消从 Agent Loop沿 signal进入 Tool、Shell与 Subprocess；后台提升则把后续控制交给 Job。Subprocess负责受管理范围的终止、等待与无法确认时的报告。systemd scope、Windows Job 与 PGID 回退具有不同保证，不能统一称为“整棵后代树已停稳”。

至此，一次动作从模型候选、执行准入到操作系统资源已经完整闭合。可系统仍要面对最难处理的时刻：动作进行到一半，进程突然退出。下一章将转向 Session Persistence、恢复、分叉与上下文压缩，分析新进程怎样只依靠持久事实继续工作，以及它怎样面对尚未结算的调用。
