# 附录 源码升级说明与验证范围

## 本版对应哪一份源码

复核日期为2026年11月13日。上游仓库为DeepSeek Harness，当前本地master通过快进更新到`e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，提交日期为2026年11月11日。根`package.json`声明版本`0.2.2-rc.2`，但它不是`dsh-v0.2.2-rc.2`标签指向的提交。阅读本书请以完整提交为准，不能只看版本字符串。

初稿和原始实验基线为`dsh-v0.1.2-alpha.1`、`cd5ef8148158c3a752a658978873241fdf8e2bbc`。本轮按新版实现修订正文，并保留历史实验归属。源码对照、历史运行结果和本轮运行结果分别登记。

## 对学习影响最大的变化

| 主题 | 旧稿容易产生的理解 | 新版应怎样阅读 |
|---|---|---|
| 环境与构建 | Node.js 22可继续使用，启动自动准备所有产物 | 要求Node.js >=24.9.0，pnpm@11.28.5；从源码运行前先构建 |
| 目录定位 | Inbox在agent包，工具类型集中在types.ts | Inbox实现进入agent-loop；工具约定分散到contracts/events/executor等文件 |
| 系统提示词 | system存在于request/header | 系统内容通过system/message参与模型可见历史 |
| Assistant流 | 逐条assistant/chunk持久化，再用sourceEventSeqs连接消息 | 实时assistant-stream供观察；assistant/message或assistant/attempt内嵌stream |
| 工具执行 | Agent Loop直接拥有调用与结果追加 | ToolsService选择Executor，Native/PTC等执行器拥有调用批次与持久结算 |
| Session格式 | 格式号0且没有已发布格式兼容义务 | writer为V4；已发布generation不可变，受支持格式通过相邻迁移读取和发布后继 |
| JSONL | 固定session.jsonl，可直接按普通文本读 | 版本化generation，默认Zstandard，可配置none；读取逻辑流应走Provider |
| 持久写入 | 按Session id直接调用load/append就能保存 | SessionHandle拥有独占写入、flush与释放；效果分发前由checkpoint policy保存事实 |
| Projection | 只是一份可以随意覆盖的缓存 | 按定义、schema和事件递推派生状态，缓存与持久事实分开 |
| Subagent | 子调用结束就等同于子Session寿命结束 | 本地子Session可继续，一次activation的取消、结果和释放单独管理 |
| 委派权限 | 父子权限完全不继承，或父批准自动放行子任务 | 捕获父显式沙箱覆盖及特定preset，不继承一次性grant；子approval固定never |
| Workflow | 固定由Worker Thread引擎执行 | 当前组合走PTC引擎；服务定义与执行引擎分开，不能假定同一隔离方式 |

第1—5章补齐环境、消息主线和插件协作定位；第6—10章修正组合、事实、请求和执行器主线；第11—14章修正安全能力、持久格式、协作机制与业务设计。技术图同时按当前源码关系重绘，去掉旧实验数量与旧布局。

## 从哪里核对这些结论

- [根package.json](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/package.json)拥有版本、引擎和包管理器要求。
- [Agent Loop](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/core/agent-loop/src/agent.ts)连接pre-step、system/message、流结算和tools.execute。
- [Session类型](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/core/session/src/types.ts)拥有writer格式号和持久事件字段。
- [格式状态](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/session-format-status.md)区分当前writer、已接受兼容基线与已发布格式。
- [工具执行器](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/core/tools/src/executor.ts)声明批次输入、结果与执行器接口。
- [JSONL实现](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/session/session-persistence-jsonl/src/index.ts)、[Subagent管理器](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/subagent/subagent/src/manager.ts)和[Workflow定义](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/workflow/workflow/src/index.ts)分别拥有恢复、子执行与编排约定。

## 本轮运行证据与未覆盖事项

已执行`git fetch origin --prune --tags`和快进更新，并核对本地HEAD、上游master与根版本。宿主默认Node.js为22.22.0，不满足新版要求；配套Node.js 24.22.1满足引擎范围。

使用配套Node.js尝试`pnpm dsh --help`时，pnpm先检查并尝试重装不匹配的旧依赖，因无TTY需要确认清理模块而退出，错误为`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。这没有证明新版CLI启动成功，也没有把错误归为产品缺陷。本轮没有把整套398个workspace依赖重装和完整构建列为已完成。

书稿结构、链接、电子书资源、EPUB规范与PDF排版按本仓库构建流程独立检查；电子书发布记录中的验证结果只覆盖相应产物。它们不代表上游全量单元测试、e2e或真实模型实验通过。

真实DeepSeek API、模型效果、HTTP/SSE、Web真人审批、目标操作系统沙箱、真实业务Provider、硬崩溃与跨进程接管，仍需各自验证。制造业案例使用模拟事实和设计约束，不构成生产接入案例。

## 怎样提交一个有效勘误

请提供章节与小节、书稿版本、上游完整提交，以及支持修改的源码或最小复现。涉及命令时写出Node/pnpm版本、工作目录和原始输出。涉及真实业务时先脱敏，不上传凭据或客户记录。这样一次读者反馈才能变成下一版可以核对的修订。

## 随书许可与引用归属

作者与维护者为于连林，项目为[deepseek-harness-book](https://github.com/yll2wcf/deepseek-harness-book)。本书原创文字与教学图采用[知识共享署名—相同方式共享4.0国际许可](https://creativecommons.org/licenses/by-sa/4.0/)，原创示例与构建代码采用MIT。转载和改编请保留署名、来源、许可及修改说明，并遵守对应许可的分享要求。

本书引用DeepSeek Harness源码用于教学，引用部分及实质性衍生内容保留上游MIT许可；该许可不被原创文字许可取代。Cordis由Cordiverse及其贡献者维护，其vendored版本的具体许可见分析提交的vendor目录。本书是独立学习资料，非DeepSeek官方出版物。以下版权声明依次对应DeepSeek Harness与Cordis相关基础库，使用相同的MIT许可条款：

~~~text
MIT License

Copyright (c) 2026 DeepSeek
Copyright (c) 2021-present Shigma

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
~~~
