# 从源码读懂 Agent · 开源学习版 2026.11

沿一条用户任务阅读DeepSeek Harness，理解插件组合、Session事实、模型请求、工具执行、权限、取消、恢复与任务协作，再把这些方法用于设计自己的Agent。

本版包含前言、14章、结语、源码升级附录和10张教学图。PDF支持目录与章节书签，EPUB可调整字号；Markdown与SVG源文件随仓库开放。

源码复核基线为上游master提交`e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，根声明版本`0.2.2-rc.2`。修订Inbox定位、system/message、Assistant内嵌stream、工具执行器、V4会话格式、JSONL generation和任务协作。旧实验输出保留原提交归属。

## 下载

- `deepseek-harness-book.pdf`：适合电脑阅读和批注。
- `deepseek-harness-book.epub`：适合常用电子书阅读器。
- `SHA256SUMS.txt`：下载校验。
- `verification.json`：本次成品检查记录。

书稿与电子书检查覆盖结构、链接、资源、EPUB规范及PDF排版；不代表上游最新版安装构建、真实API、生产业务接入或全套测试已经通过。详细范围见随书附录。

原创文字和教学图使用CC BY-SA 4.0，原创代码使用MIT；引用源码保留上游许可。本书为独立学习项目，非DeepSeek官方出版物。欢迎在Issues提交具体勘误。
