# 历史实验的适用范围

书稿早期学习记录来自DeepSeek Harness `0.1.2-alpha.1`提交`cd5ef8148158c3a752a658978873241fdf8e2bbc`。正文保留的`tmp/cordis-tutorial`等命令和计数属于那套工作区，不是本书仓库根目录下的运行入口。

本版按新版源码修订解释，不将这些旧输出冒充最新版通过。`upstream-tmp/`保留35份原始实验源码与配置，`manifest.json`记录各文件SHA-256。本仓库不打包个人运行目录、持久会话、模拟审批输出或本机配置。

## 历史源码导航

- `upstream-tmp/cordis-tutorial/`：插件、生命周期、服务、事件、Waterfall与配置。
- `upstream-tmp/session-event-tutorial/session-event-demo.mjs`：旧事件格式与Surface。
- `upstream-tmp/llm-request-tutorial/llm-request-demo.mjs`：旧版Mock请求与流结算。
- `upstream-tmp/agent-loop-tutorial/agent-loop-demo.mjs`：Turn、Step、Inbox与取消。
- `upstream-tmp/tool-pipeline-tutorial/tool-pipeline-demo.mjs`：工具策略与Mock审批。
- `upstream-tmp/agent-continuity-tutorial/`：旧版恢复、协作与制造业Mock案例。

## 阅读新版

使用正文指向的固定提交，先满足Node.js `>=24.9.0`和pnpm `11.28.5`，安装并构建上游工程，再从对应源码与行为测试追踪机制。正文中的最小代码片段说明原理，不替代上游完整插件组合。

## 复现旧版

如研究历史行为，应使用独立上游checkout固定到旧提交，将本目录`upstream-tmp/`的内容复制到该checkout的`tmp/`中，按旧版本要求安装并构建后，在上游根目录运行书中的历史命令。不要在书稿仓库根目录执行这些命令。脚本会在各自的`tmp/`目录生成或重置模拟数据；本轮只整理源文件，未重新运行。

旧版脚本未适配新版，不能直接复制到最新版后宣称通过。当前版本已删除或调整部分旧公开接口，失败时应先核对提交和接口，再判断行为。

欢迎贡献适配当前基线、包含失败路径、可在干净checkout运行的最小实验。请注明提交、依赖、运行命令、断言和未覆盖边界。
