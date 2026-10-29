# dsh-advisor v0.2.1 — 审查交接文档

> **给审查者的**：本文档包含仓库地址、分支、安装方式、架构要点、审查关注点。读完应该能独立跑起测试、装进桌面环境、对照截图验收。

---

## 一、仓库基本信息

| 项目 | 值 |
| --- | --- |
| GitHub 仓库 | `qiao-obs/dsh-advisor` |
| 主分支 | `main` |
| 当前版本 | `0.2.1` |
| 最新提交 | `ab85f1d` — *v0.2.1: desktop interactive advisor with settings, panel UI, and safety gates* |
| 语言 | JavaScript (ESM, Node.js ≥22) |
| 测试框架 | `node --test`（内置 test runner，零外部依赖） |

**克隆命令**：
```bash
git clone https://github.com/qiao-obs/dsh-advisor.git
cd dsh-advisor
git checkout main
```

**验证代码完整性**：
```bash
node --check client/client.js    # 客户端 bundle 语法
node --check lib/index.js        # 插件入口
node --check lib/consult.js      # 咨询服务
node --test tests/*.test.mjs     # 全量测试（99 项）
```

---

## 二、项目是什么

dsh-advisor 是一个 **DSH 桌面插件**（DeepSeek Harness Plugin），为 AI 助手的主对话提供"第二意见"——独立顾问模型审查回答/方案，给人一个不随对话上下文偏移的视角。

**核心用户流程**：
1. 人在输入区点「咨询顾问」→ 填问题 → 预览材料 → 确认发起。
2. 顾问（独立 LLM 调用）审查当前对话材料 + 问题 → 输出意见。
3. 人在卡片上标注「成立/不成立/已处理/暂不处理」，可选「让主力核验」（把意见回投给主对话）。

---

## 三、安装与运行

### 3.1 在 DSH 桌面环境安装（推荐审查方式）

```bash
# 用官方 CLI（内置 node 24 + pnpm 11）
"C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" ^
  plugin --profile desktop add github:qiao-obs/dsh-advisor#v0.2.1
```

或在 `package.json` 中手动声明后重启桌面 App。

### 3.2 在 web profile 安装

```bash
dsh plugin --profile web add github:qiao-obs/dsh-advisor#v0.2.1
```

### 3.3 独立跑测试（不需要 DSH 环境）

```bash
cd dsh-advisor
node --test tests/*.test.mjs
```

> 测试使用假 LLM（`makeFakeLlm`）和假上下文（`makeFakeCtx`），不需要网络或真实 API key。

---

## 四、代码结构

```
dsh-advisor/
├── client/
│   └── client.js          # 浏览器端 UI（2338 行）
│                          #   - 设置页（settings.section 槽位）
│                          #   - 头部药丸 + 浮层面板（header.utilities 槽位）
│                          #   - 输入区入口（input.left 槽位）
│                          #   - 确认区（input.dock 槽位）
│                          #   - 工具结果视图（toolview 槽位）
├── lib/
│   ├── index.js           # 插件入口（727 行）：工具注册 + host channel + 闸门
│   ├── advisor.js         # 顾问工具核心（1115 行）：createAdvisorTool + raceStream
│   ├── consult.js         # 咨询服务（617 行）：start/cancel/settle/annotate
│   ├── host.js            # RPC 端点（475 行）：12 个 handler
│   ├── settings.js        # 设置管理（301 行）：normalize/patch/grant
│   ├── history.js         # 历史存储（344 行）：record CRUD + window
│   ├── materials.js       # 材料收集（471 行）：question/selection/plan/diff/test
│   └── rpc.js             # RPC 通道（246 行）：mountChannel + admission
├── locale/
│   ├── zh.json            # 中文文案
│   └── en.json            # 英文文案
├── tests/
│   ├── helpers.mjs        # 测试工具（makeFakeLlm/makeFakeCtx/execFor）
│   ├── advice.test.mjs    # 建议文本质量
│   ├── cancel.test.mjs    # 取消路径
│   ├── concurrency.test.mjs # 并发上限
│   ├── config.test.mjs    # 配置解析
│   ├── history-window.test.mjs # 历史窗口（不丢待办）
│   ├── materials.test.mjs # 材料收集
│   ├── states.test.mjs    # 状态机（classifyOutcome）
│   ├── switch.test.mjs    # 总开关（enabled gate）
│   ├── tool-gate.test.mjs # 模型侧偏好闸门
│   └── plugin.test.mjs    # 插件生命周期
├── docs/
│   ├── acceptance-v0.2.md # 真机验收记录（12 节 + 缺陷表）
│   ├── acceptance-v0.2.mp4 # 验收录屏（35s）
│   ├── handoff-for-review.md # 本文档
│   └── shots/             # 20 张真机截图
├── package.json           # 版本 0.2.1，dsh.client 配置
└── icon.svg               # 插件图标
```

---

## 五、审查关注点（按优先级）

### 5.1 安全闸门（最高优先级）

这是"给客户用"的功能，钱是真实的。审查重点：

1. **总开关 `enabled`**（`lib/settings.js:111` + `lib/consult.js`）：
   - `enabled === false` 时，`consult.start` 在读材料和调 LLM **之前**拒绝，`llm.stream` 调用次数为 0。
   - `lib/index.js` 的 `gateForTool()` 同样拦截模型侧工具调用（`refused_no_consent`）。
   - 测试：`tests/switch.test.mjs`（8 项）+ `tests/tool-gate.test.mjs`（8 项）。

2. **模式闸门**（manual/confirm/auto）：
   - `manual`：模型调用被拒（工具调用不是人在问）。
   - `confirm`：放行到 consent seam（`lib/advisor.js:698` 的 `userQuestions.askTimed`）。
   - `auto`：放行。
   - per-session grant 只提升被授权会话。
   - 测试：`tests/tool-gate.test.mjs` 第 2/3/4/5 项。

3. **并发上限**（`lib/consult.js`，`MAX_IN_FLIGHT_PER_SESSION = 3`）：
   - 防止客户端重复点击叠出多个付费请求。
   - 测试：`tests/concurrency.test.mjs`（3 项）。

4. **预算闸门**（`budgetState`）：
   - `maxConsultationsPerSession` 超限后拒绝，`reason:'session-budget-exhausted'`。

### 5.2 数据完整性

5. **历史窗口不丢待办**（`lib/history.js` 的 `trim()`）：
   - 未核验的意见（`advice` 存在但 `verification` 非 confirmed/rejected）永远不会被轮转掉。
   - 测试：`tests/history-window.test.mjs`（5 项）。

6. **时间戳**（`lib/history.js` 的 `iso()`）：
   - 接受 ISO 字符串与 epoch 数字；不接受时返回 fallback 而非 0。
   - 早期 bug：`num()` 把 ISO 抹成 0，导致"已等待 N 秒"从 1970 起算。

### 5.3 UI/UX

7. **头部药丸 + 浮层面板**（`client/client.js`）：
   - 药丸三种状态（pending/warn/brand）各有明确视觉区分。
   - 面板在药丸正下方，`position:absolute`，不遮挡对话。
   - 历史列表四列对齐（时间/状态/问题/箭头）。
   - 点药丸可直接打开待核验清单。

8. **总开关即时生效**：
   - 设置页是 root 作用域，通过全局广播通道（`enabledState`）通知会话组件，不刷新即可消失/出现。

9. **清空历史二次确认**：
   - `clearArmed` 两步确认，blur/Escape 取消。
   - 这是唯一不可撤销的操作，它删的正是未核验意见唯一的存放处。

### 5.4 已修的真实 Bug（见 docs/acceptance-v0.2.md 缺陷表）

10. `STATES` 键名不匹配（camelCase vs snake_case）→ 状态恒为 failed。
11. ISO 时间戳被 `num()` 抹成 0。
12. `history.records` 是 getter 不是函数。
13. `listProviders()` 同步调 async `listModels()` → 模型下拉恒空。
14. 卡片遮挡对话 → 改为药丸 + 面板。
15. 总开关不即时生效 → 全局广播通道。

---

## 六、验收记录

完整验收记录在 `docs/acceptance-v0.2.md`（12 节，含截图），录屏在 `docs/acceptance-v0.2.mp4`（35 秒）。

**关键截图对照**：

| 截图 | 内容 |
| --- | --- |
| `20-pill-idle.png` | 右上角药丸（实心 brand 色，"10 条意见待核验"） |
| `21-panel-history.png` | 浮层面板：历史清单（四列对齐） |
| `22-panel-card.png` | 浮层面板：单条意见卡 |
| `23-settings.png` | 设置页（启用顾问开关、模型选择、材料范围） |
| `03-card-returned.png` | 咨询卡（已返回，完整意见 + 三事实行 + 四按钮） |
| `05-stale.png` | 旧版本材料标记（"基于旧版本，需重新核验"） |
| `06-failed.png` | 失败路径（真实错误信息） |

---

## 七、运行环境要求

- **Node.js ≥ 22**（测试与语法检查）
- **DSH 桌面 App**（profile `desktop`，宿主 0.2.1-rc.3）——真机验收在此环境完成
- 浏览器 UI 是 React（通过 `window.__ModuleLoader__` 加载），不需要额外构建步骤
- 客户端与宿主通过同源 RPC（`fetch('/plugin/dsh-advisor/<endpoint>')`）通信

---

## 八、已知限制

1. **旧版记录状态显示**：v0.2.0 之前写的记录可能 `state:'failed'` + `reason:'deadline'` 并存（STATES bug 的遗留数据），卡片会显示"失败"但正文可能有内容。这是数据问题，不是代码 bug。
2. **空会话页**：hero 页（无会话）不渲染药丸和卡片（无 composer 槽位），这是宿主行为。
3. **前端无自动化测试**：界面验收靠真机 puppeteer 脚本 + 人工看截图。
4. **consultDeadlineMs 默认 60s**：长回复可能被截断，卡片会标"输出被截断"。

---

## 九、测试矩阵

| 测试文件 | 覆盖 | 项数 |
| --- | --- | --- |
| `advice.test.mjs` | 建议文本质量与回归 | 20+ |
| `cancel.test.mjs` | 取消与超时 | 8 |
| `concurrency.test.mjs` | 并发上限 | 3 |
| `config.test.mjs` | 配置解析与边界 | 10+ |
| `history-window.test.mjs` | 历史窗口不丢待办 | 5 |
| `materials.test.mjs` | 材料收集与预算 | 10+ |
| `states.test.mjs` | 状态机 classifyOutcome | 8+ |
| `switch.test.mjs` | 总开关闸门 | 8 |
| `tool-gate.test.mjs` | 模型侧偏好闸门 | 8 |
| `plugin.test.mjs` | 插件生命周期 | 10+ |
| **总计** | | **99** |

---

## 十、审查者操作指南

1. **克隆仓库** → 跑测试确认 99/99 通过。
2. **装进桌面** → 打开 DSH 桌面 App → 设置 → 插件 → 确认 dsh-advisor 已启用。
3. **进入任意已有会话**（不要在空会话页）。
4. **验收六块**：
   - 设置页：启用/关闭开关、模型选择、材料范围、连接检查。
   - 输入区：点「咨询顾问」→ 填问题 → 查看材料 → 开始。
   - 头部药丸：等待时呼吸点、待核验时实心色、点击展开面板。
   - 咨询卡：状态/模型/时间/正文/三事实/四按钮。
   - 历史：表格四列对齐、点行展开详情。
   - 核验：标记成立/不成立/已处理。
5. **对照截图** `docs/shots/20-23` 确认视觉一致。
6. **逻辑审查**：按第五节的优先级逐项过。

---

*文档生成时间：2026-10-29 | 提交 `ab85f1d` | 分支 `main`*
