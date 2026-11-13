# 第三方声明

本书是独立源码学习项目，非DeepSeek官方文档、出版物或背书产品。DeepSeek、Cordis等名称和商标属于各自权利人。

## DeepSeek Harness

上游：https://github.com/deepseek-ai/deepseek-harness

分析基线：`e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`；历史实验基线：`cd5ef8148158c3a752a658978873241fdf8e2bbc`。

上游采用MIT。少量源码节选、接口名称与行为说明用于教学；引用和实质性衍生部分保留上游许可，不被本书CC许可取代。

```text
MIT License

Copyright (c) 2026 DeepSeek

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
```

## Cordis

Cordis由Cordiverse及其贡献者维护，上游为https://github.com/cordiverse/cordis 。本书通过DeepSeek Harness中vendored版本讨论生命周期；具体源码许可证和本地改动以该提交中的`vendor/README.md`及对应LICENSE为准。本仓库不整体复制vendored源码。

Cordis、Loader、Timer与Schemastery在分析提交中保留`Copyright (c) 2021-present Shigma`，采用与上方相同的MIT许可条款。电子书附录一并保留该版权声明与完整条款。

## 电子书工具与字体

Pandoc、ReportLab等构建工具保留其各自许可证，不随电子书源码打包安装。PDF按构建机字体许可嵌入所用字体子集；本仓库不分发系统字体文件。教学图SVG由本项目编写，PNG从SVG导出。
