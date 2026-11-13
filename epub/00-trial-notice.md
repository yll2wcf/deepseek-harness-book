# 开源学习版说明

这是《从源码读懂 Agent：DeepSeek Harness 架构分析与实战》的开源学习版。全书面向有编码基础、但大型 Agent 源码阅读经验较少的读者，建议先读前言，再按四个部分顺序学习。书稿与PDF、EPUB在个人项目 [deepseek-harness-book](https://github.com/yll2wcf/deepseek-harness-book) 免费提供；本书是独立学习资料，与DeepSeek官方没有隶属或背书关系。

本版源码复核日期为2026年11月13日，基线为上游master提交 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，仓库声明版本 `0.2.2-rc.2`。正文按新版源码修订；保留的旧实验记录明确标记为 `0.1.2-alpha.1` 历史证据，不代表新版测试通过。源码链接固定到相应提交，版本复核记录见仓库中的升级说明。

离线实验可以帮助观察插件生命周期、Session Event、Mock Adapter、工具策略、审批、取消、持久化、压缩和任务协作。它们不能证明真实DeepSeek模型质量、HTTP/SSE行为、Web UI真人审批、真实业务Provider、操作系统硬崩溃、跨进程接管或生产环境安全性。新版完整安装构建和原有实验重跑状态单独登记，不以源码核对替代运行证据。

试读时，请优先记录三个问题：哪一处读不下去，哪条命令不知道应该观察什么，哪项结论容易被误解为生产保证。没有实际运行过的内容，请不要仅凭文字判断为“已验证”。

书稿原创文字和教学图采用 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)；随书原创示例代码采用MIT许可证。DeepSeek Harness与其中引用的源码保留上游MIT许可证及原作者声明。勘误请提交到公开仓库的Issues，注明章节、源码提交和复现信息。
