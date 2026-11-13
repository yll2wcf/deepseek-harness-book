# 构建电子书

所有格式从同一套Markdown、图片和`book.json`生成。PDF、EPUB输出到`dist/`；GitHub Releases分发成品，Git保存可编辑源稿。

## 安装工具

需要Node.js（执行书稿审计）、Pandoc 3、Python 3.10+，以及Python包`reportlab`、`pypdf`、`pdfplumber`、`Pillow`。另需`epubcheck`做EPUB验证、Poppler做PDF提取与渲染，`rsvg-convert`仅在重绘图时需要。

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
node epub/audit-book.mjs
python scripts/check_links.py
python scripts/build.py
epubcheck dist/deepseek-harness-book.epub
python scripts/verify-release.py
```

这些安装步骤需要联网；构建正文不调用任何模型API。

## 中文字体

PDF必须嵌入可用的中文TrueType字体。macOS默认搜索系统`Arial Unicode.ttf`；其他系统请把`BOOK_FONT`设为已安装的中文TTF/TTC绝对路径，例如文泉驿正黑。字体不随仓库重新分发，请遵守所用字体的授权。

```sh
BOOK_FONT=/absolute/path/to/chinese-font.ttf python scripts/build.py --format pdf
```

只构建EPUB时不需要PDF字体：

```sh
python scripts/build.py --format epub
```

## 发布前核对

`scripts/verify-release.py`检查EPUB资源、导航与本地链接，PDF页数、元数据与章节关键文本，并生成SHA-256文件。它不能替代EPUBCheck和实际页面视觉复核。渲染PDF后检查封面、目录、各章起始页、长代码块、表格和全部技术图，确认没有截断、重叠或缺字，再上传Release。

```sh
python scripts/qa_pdf.py
```

该命令把每页预览、联系表和横向溢出候选写入`build/qa/`。候选还需要人工判断，包括中文标点的行末悬挂。

`scripts/sync-manuscript.mjs`是维护者导入旧学习工作区的工具；普通读者不需要运行它。

持有上游Git工作区时，可用`python scripts/check_links.py --source-checkout /path/to/deepseek-harness`进一步检查书稿链接在所固定提交中是否确实存在。上游工作区须已获取书中引用的提交对象。
