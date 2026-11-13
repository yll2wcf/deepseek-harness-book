#!/usr/bin/env python3
"""Render the source-checked teaching diagrams with reproducible SVG sources."""
from html import escape
import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT
META = json.loads((ROOT / "book.json").read_text())

DIAGRAMS = {
    "week-03-profile-bundle-patch": (
        "Profile、Bundle、Patch 怎样组成应用", "按三行顺序阅读；具体插件数量由当前组合决定",
        [("① 应用选择", [("dsh Profile", "选择命名运行组合"), ("Bundle layers", "按配置顺序展开分发层"), ("Profile patch", "应用本Profile覆盖")]),
         ("② 后续覆盖", [("Home patch", "$DSH_HOME/cordis.patch.yml"), ("--patch overlays", "按命令行顺序继续覆盖"), ("遥测禁用Patch", "环境开关适用时最后覆盖")]),
         ("③ 装配与生命周期", [("composeEntries()", "按行id组合；config整体替换"), ("App Boot", "解析并检查加载结果"), ("Cordis plugins", "服务与监听器归生命周期管理")])]),
    "week-04-session-event-surface": (
        "一份Session事实，多个读取视图", "当前Assistant记录内嵌stream；实时帧与持久事件分开",
        [("① 持久事实", [("Session.append()", "校验、追加并分配seq"), ("Session Event", "输入、系统消息、工具与边界"), ("session/event", "提交后的实时通知")]),
         ("② 模型历史", [("事实日志", "包含system/message"), ("Surface", "维护模型可见的消息节点"), ("deriveMessages()", "派生本次模型历史")]),
         ("③ 流式响应", [("assistant-stream", "agent实时帧供界面观察"), ("message / attempt", "按是否形成消息结算"), ("内嵌stream", "记录响应与失败尝试")])]),
    "week-05-model-request-stream": (
        "请求组装、实时响应与持久结算", "系统消息进入历史；request/header不保存旧版system字段",
        [("① 发起请求", [("提示词与模型选择", "组合系统内容、路由与配置"), ("system/message", "系统内容作为可重建事实"), ("GenerateOptions", "模型、tools、messages等")]),
         ("② 传输与观察", [("LLM Adapter", "提供方协议转换为共享流"), ("assistant-stream", "实时发布响应帧"), ("界面与消费方", "展示进度；不代替事实日志")]),
         ("③ 已开始流的结算", [("流式尝试收束", "成功、失败、取消分别处理"), ("message / attempt", "内嵌stream保存流记录"), ("提交或abandoned", "写入失败不伪造持久记录")])]),
    "week-06-turn-step-state": (
        "Inbox、Turn与Step怎样推进工作", "Inbox实现属于agent-loop；待领队列由Projection恢复",
        [("① 输入", [("followup/steer/inject", "确定目标队列与唤醒规则"), ("next-turn / next-step", "两类持久待领输入"), ("唤醒或暂存", "按输入语义决定是否运行")]),
         ("② 工作", [("Turn", "turn/start先于claim与准入"), ("Step", "准入后开始；可多次attempt"), ("继续或停止检查", "有待结工作就继续推进")]),
         ("③ 取消", [("取消请求", "中止当前活动并处理待领项"), ("信号传递与清理", "等待已启动的工作收束"), ("终态与再次运行", "结算后可接收后续输入")])]),
    "week-07-tool-execution-pipeline": (
        "工具执行由ToolsService选择Executor", "工具call/result的持久化属于执行器；Agent Loop消费批次结果",
        [("① 工具选择", [("ToolsService", "注册、作用域与可见工具"), ("ToolExecutor", "作用域选择执行器"), ("Native / PTC", "不同调用方式共享核心规则")]),
         ("② 调用准入", [("Session tool/call", "主体执行前记录调用事实"), ("参数快照与pre", "不可变参数交给策略判断"), ("Approval + guards", "审批以后仍可被守卫拒绝")]),
         ("③ 执行与结算", [("Schema + 主体", "定义入口校验后执行Provider"), ("结果投影与后处理", "projectContent / post / finalize"), ("Session tool/result", "有序提交并进入模型历史")])]),
    "week-08-session-continuity": (
        "连续性依靠持久事实，恢复依靠明确格式", "当前writer格式为V4；物理generation与业务投影不能混同",
        [("① 保存", [("SessionHandle", "独占写入、flush与释放"), ("JSONL Provider", "zstd或none保存Session Event"), ("版本化generation", "session.vN.jsonl[.zstd]")]),
         ("② 读取与升级", [("最高规范generation", "读取时检查格式与来源"), ("相邻格式迁移", "旧generation保持不可变"), ("当前逻辑事件", "读不发布；写发布受支持后继")]),
         ("③ 恢复与上下文", [("Resume + Projection", "据日志补齐终态并重建状态"), ("Surface", "维护模型可见历史"), ("Compaction", "追加摘要事实并替换可见范围")])]),
    "week-08-task-collaboration": (
        "Subagent、Job与Workflow各自交付什么", "子Session与一次activation分开；取消和释放由持有方负责",
        [("① 独立判断", [("Subagent", "按具名Provider委派"), ("受管理activation", "本地子Session与持久Inbox"), ("result + dispose", "结算结果并释放本次执行")]),
         ("② 长时间资源", [("Job", "后台执行与资源归生产方"), ("Registry", "登记身份、状态与访问"), ("wait / read / terminal", "观察输出并等待资源终态")]),
         ("③ 脚本编排", [("Workflow", "纯JavaScript编排体"), ("PTC Node Engine", "Node进程调用agent等钩子"), ("JSON result", "父调用等待完整运行结算")])]),
    "agent-harness-six-responsibilities": (
        "用六项责任评审自己的Agent", "这是设计评审地图；不同责任共同约束一次任务",
        [("① 从事实走到运行", [("事实", "Session Event保存发生了什么"), ("运行", "Agent Loop组织Turn与Step"), ("动作", "ToolsService与执行器共享结算链")]),
         ("② 执行条件与终止", [("权限", "准入、审批与环境限制"), ("取消", "传递信号并等待清理"), ("恢复", "独占句柄恢复；副作用先对账")]),
         ("③ 业务纵向切片", [("读取异常事实", "模拟数据与来源标识"), ("建议与人工确认", "绑定本次不可变请求"), ("受控业务写入", "身份、幂等、审计与结果")])]),
}


def render_chart(name, spec):
    title, subtitle, tracks = spec
    lines = []
    lines.append('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 760" width="960" height="760">')
    lines.append('<style>text{font-family:"PingFang SC","Microsoft YaHei",sans-serif} .node{font-size:19px;font-weight:600;fill:#111827}.sub{font-size:13px;fill:#475569}</style>')
    lines.append('<defs><marker id="arrow-blue" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0,10 3.5,0 7" fill="#2563eb"/></marker></defs>')
    lines.append('<rect width="960" height="760" fill="white"/>')
    lines.append(f'<text x="480" y="52" text-anchor="middle" font-size="28" font-weight="700" fill="#111827">{escape(title)}</text>')
    lines.append(f'<text x="480" y="90" text-anchor="middle" font-size="15" fill="#64748b">{escape(subtitle)}</text>')
    fills = [('#eff6ff', '#93c5fd'), ('#f0fdf4', '#86efac'), ('#faf5ff', '#d8b4fe')]
    for index, (label, nodes) in enumerate(tracks):
        top = 160 + index * 180
        fill, stroke = fills[index]
        lines.append(f'<text x="48" y="{top - 20}" font-size="16" font-weight="600" fill="#334155">{escape(label)}</text>')
        for column, (node, detail) in enumerate(nodes):
            x = 48 + column * 312
            lines.append(f'<rect x="{x}" y="{top}" width="240" height="104" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')
            lines.append(f'<text x="{x + 120}" y="{top + 42}" text-anchor="middle" class="node">{escape(node)}</text>')
            lines.append(f'<text x="{x + 120}" y="{top + 76}" text-anchor="middle" class="sub">{escape(detail)}</text>')
            if column < 2:
                lines.append(f'<path d="M{x + 240} {top + 52} L{x + 304} {top + 52}" stroke="#2563eb" stroke-width="2.5" fill="none" marker-end="url(#arrow-blue)"/>')
    lines.append('<text x="48" y="722" font-size="12" fill="#64748b">箭头：本行的概念或数据关系；逐行展开不同责任</text>')
    lines.append('<text x="912" y="722" text-anchor="end" font-size="12" fill="#64748b">源码基线 e8f7b93a34 · 2026-11-13</text>')
    lines.append('</svg>')
    target = OUT / 'assets' / (name + '.svg')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('\n'.join(lines) + '\n')
    ET.parse(target)
    subprocess.run(['rsvg-convert', str(target)], stdout=subprocess.DEVNULL, check=True)
    subprocess.run(['rsvg-convert', '-w', '1920', str(target), '-o', str(target.with_suffix('.png'))], check=True)


def render_cover():
    lines = []
    lines.append('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="2263" viewBox="0 0 1600 2263">')
    lines.append('<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#0c172c"/><stop offset="1" stop-color="#24346b"/></linearGradient></defs>')
    lines.append('<style>text{font-family:"PingFang SC","Microsoft YaHei",sans-serif}</style>')
    lines.append('<rect width="1600" height="2263" fill="url(#bg)"/>')
    lines.append('<circle cx="1460" cy="240" r="460" fill="#6671ed" opacity=".12"/>')
    lines.append('<text x="126" y="170" font-size="34" fill="#a5b8ec">开源学习版 2026.11</text>')
    lines.append('<text x="120" y="580" font-size="112" font-weight="700" fill="white">从源码读懂</text>')
    lines.append('<text x="120" y="790" font-size="196" font-weight="700" fill="#8da9ff">Agent</text>')
    lines.append('<rect x="126" y="870" width="200" height="10" rx="5" fill="#6d9cff"/>')
    lines.append('<text x="124" y="1040" font-size="62" fill="#e3eaff">DeepSeek Harness</text>')
    lines.append('<text x="124" y="1140" font-size="62" fill="#e3eaff">架构分析与实战</text>')
    lines.append('<text x="126" y="1280" font-size="34" fill="#bdc9e2">从一次模型调用，到能取消、能恢复的运行系统</text>')
    labels = [('事实', 'Session'), ('运行', 'Loop'), ('动作', 'Tools')]
    for i, (a, b) in enumerate(labels):
        x = 126 + 460 * i
        lines.append(f'<rect x="{x}" y="1490" width="380" height="170" rx="22" fill="#294989" stroke="#7599ef" stroke-width="2"/>')
        lines.append(f'<text x="{x+190}" y="1555" text-anchor="middle" font-size="40" fill="white">{b}</text>')
        lines.append(f'<text x="{x+190}" y="1614" text-anchor="middle" font-size="32" fill="#c2d1ef">{a}</text>')
    lines.append('<text x="126" y="1795" font-size="32" fill="#c2d1ef">14章 · 10张教学图 · 失败与恢复 · 制造业案例</text>')
    lines.append(f'<text x="126" y="1980" font-size="44" fill="white">{escape(META["author"])} 著</text>')
    lines.append('<path d="M126 2060 H1474" stroke="#697da5" opacity=".5"/>')
    lines.append('<text x="126" y="2140" font-size="27" fill="#a9bbdf">基于上游 master e8f7b93a34 · 声明版本 0.2.2-rc.2</text>')
    lines.append('</svg>')
    target = OUT / 'epub/cover.svg'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('\n'.join(lines) + '\n')
    ET.parse(target)
    subprocess.run(['rsvg-convert', str(target), '-o', str(target.with_suffix('.png'))], check=True)


for name, spec in DIAGRAMS.items():
    render_chart(name, spec)
render_cover()
print(f'Rendered {len(DIAGRAMS)} diagrams and cover to {OUT}')
