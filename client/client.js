/**
 * dsh-advisor v0.2 — the desktop half.
 *
 * Four surfaces, all of them inside the host's own UI, none of them a page of
 * our own:
 *
 *   settings.section                     the configuration page
 *   conversation.input.left              the "consult" entry point
 *   conversation.input.dock              the confirmation strip
 *   conversation.session.header.utilities  the status pill and, under it, the
 *                                          opinion panel + history
 *   tool.call.toolview (advisor_consult) the card for a model-initiated call
 *
 * The opinion panel hangs from the header pill rather than the composer: the
 * strip under the composer belongs to the conversation statistics, and a card
 * there either pushes the conversation off screen or reads as a footnote.
 *
 * Every piece of state shown here comes from the host: a record written before
 * the request left, its `state` field, the model that was actually resolved, the
 * digest of the material that was actually sent. There is no local progress
 * simulation and no optimistic "sent" — a consultation that has not settled says
 * `running`, and one that was cut off says `truncated` while keeping its text.
 *
 * Three facts are never merged: whether the working model *saw* the opinion
 * (`deliveredToModel`), whether it *confirmed* it (`verification`), and whether
 * anything was *changed* (`disposition`). "Accepted" as a single field is how a
 * rejected-and-fixed finding gets counted as agreement.
 */

window.__ModuleLoader__.load({
  id: 'dsh-advisor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useSyncExternalStore } = React;

    const NS = 'dsh-advisor';
    const CHANNEL = '/plugin/dsh-advisor';
    const STYLE_ID = 'dsh-advisor-style';

    /** RFC 4122 v4 id without requiring a secure-context crypto.randomUUID. */
    function uuid() {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    // ------------------------------------------------------------------ locale

    const ZH = {
      dialogTitle: "顾问 × 执行 Agent",
      dialogHint: "顾问负责方案、澄清与评价；主力负责实际执行。交流会直接返回给主力，不用复制粘贴。",
      dialogSetup: "设置本任务协作",
      dialogRounds: "本次最多交流轮数",
      dialogPreview: "查看协作授权",
      dialogEnable: "授权这些轮次",
      dialogPause: "暂停顾问交流",
      dialogPlan: "请顾问梳理方案",
      dialogAsk: "向顾问交流",
      dialogPhase: "这轮要做什么",
      dialogMessage: "这轮的问题或要求",
      dialogEvidence: "补充证据（可选）",
      dialogSend: "发送这一轮",
      dialogOwnerAdvisor: "顾问正在思考",
      dialogOwnerWorker: "主力负责执行",
      dialogOwnerUser: "等待你决定下一步",
      dialogPaused: "协作未启用或已暂停",
      dialogBudget: "本次已用 %s 轮",
      dialogScoreHint: "顾问主观评价，满分 5 分；未知不按零分计算，评分不代表验收通过。",
      dialogUnknown: "证据不足，未评分",
      dialogNext: "顾问给主力的下一步",
      dialogImpact: "本轮建议改变什么",
      dialogTranscript: "查看双方交流与证据",
      dialogNoScore: "本轮没有完整有效的分项评分；保留原始答复。",
      dialogAdvice: "顾问答复",
      dialogExecutor: "执行方 / 用户提问",
      dialogMaterial: "实际发送材料",
      dialogState_running: "思考中",
      dialogState_returned: "已回复",
      dialogState_stale: "已过期，仅供查看",
      dialogState_paused: "已暂停",
      dialogState_interrupted: "等待已中断",
      dialogState_failed: "失败",
      dialogState_cancelled: "已取消",
      dialogState_refused: "未发出",
      dialogState_truncated: "答复不完整",
      dialogState_no_advice: "无新增意见",
      dialogState_timed_out: "等待超时",
      dialogPhase_plan: "制定执行方案",
      dialogPhase_clarify: "澄清或讨论分歧",
      dialogPhase_review: "评价执行结果",
      dialogVerdict_proceed: "建议按当前范围推进",
      dialogVerdict_revise: "建议修改后再检查",
      dialogVerdict_blocked: "需要先补证或解阻",
      dialogDimension_correctness: "正确性",
      dialogDimension_coverage: "验收覆盖",
      dialogDimension_evidence: "证据质量",
      dialogDefaultPlan: "请梳理实现顺序、关键假设和验证方法，给主力一份可直接执行的任务提示词；保持当前范围，缺少信息时具体指出。",
      dialogPauseHint: "暂停只停止新的顾问交流与本地等待，不终止主力已经开始的操作。",

      workState_working: "主力处理中",
      report_in_progress: "进度检查点，尚未完成",
      workNextStep: "下一步",
      workChecks: "逐项检查（主力报告）",
      check_passed: "报告通过",
      check_failed: "报告失败",
      check_not_run: "尚未执行",
      workCheckWarning: "仍有失败或未执行的检查。核对这些缺口后再决定是否验收。",
      workOldReport: "这是上次派单的报告，不代表本次已经完成。",
      workProgressHistory: "查看之前的进度与报告",
      workReportedAt: "最近回报",
      workFilter_ready: "待交付",
      workFilter_running: "执行中",
      workFilter_attention: "需解阻",
      workNext_prepare: "确认范围和验收条件，预览后交付。",
      workNext_await_delivery: "等待接收确认，先不要重复发送。",
      workNext_await_report: "已交付，等待主力提供进度或结果。",
      workNext_continue: "按最近检查点继续；仍需核对实际进度。",
      workNext_review: "对照证据验收，或带着报告请顾问复查。",
      workNext_unblock: "先补齐阻塞所需信息，再决定继续或调整范围。",
      workNext_check_delivery: "先查看主对话确认是否已接收，避免重复执行。",
      workNext_closed: "已记录处理决定，可查看依据或重新开放。",
      preset_research: "资料研究",
      preset_document: "文档交付",
      presetQuestion_research: "请检查所提供资料是否足以回答当前研究问题，区分事实、推断和缺失证据。按优先级给出需要补查的来源类型、具体问题与可交付的结论表；不要虚构来源或把未读资料当作已核实。",
      presetQuestion_document: "请按目标读者与使用场景检查这份文档的结构、事实依据、遗漏信息和行动指引。给出最小修改清单及逐项可检查的交付标准；区分内容缺口与措辞润色。",

      workExisting: '已打开该意见对应的现有待办，未重复创建。',
      workLinked: '返回关联待办',
      workScopeMissing: '该类材料尚未在设置中开放，本次不会自动发送。可先调整材料设置，或在允许的补充片段中提供必要内容。',
      workTab: "待办",
      workBadge: "%s 项待办",
      workHeading: "让意见产生结果",
      workHint: "明确范围与验收条件，再交给主力处理。执行报告会回到这里，等待验收。",
      workActive: "待跟进",
      workAwaiting: "待验收",
      workVerified: "人工确认通过",
      workNew: "新建待办",
      workEdit: "编辑待办",
      workSave: "保存待办",
      workSaved: "待办已保存，尚未交付执行。",
      workBack: "返回待办列表",
      workTitle: "要完成什么",
      workAction: "执行范围",
      workAcceptance: "验收条件",
      workPriority: "优先级",
      priority_high: "优先处理",
      priority_normal: "正常",
      priority_low: "较低",
      workFromAdvice: "原始意见会随待办保留。先确认问题、执行范围和验收条件；保存不会自动执行。",
      workCreateHint: "写清楚期望结果和怎么验证；保存后可预览任务包，再交给主力。",
      workActionHint: "具体检查或修改哪些内容？哪些内容不在本次范围内？",
      workAcceptanceHint: "例如：连续点击只发起一次请求；取消后可以重试；相关测试通过。",
      workExport: "复制工作记录",
      workExported: "已复制待办、执行回报和验收依据。",
      workSearch: "搜索待办",
      workFilters: "筛选待办",
      workFilter_active: "待跟进",
      workFilter_review: "待验收",
      workFilter_closed: "已归档",
      workFilter_all: "全部",
      workEmpty: "这里还没有匹配的待办",
      workEmptyHint: "把有价值的意见转为待办，或直接新建一个具体目标。",
      workState_ready: "待交付",
      workState_sending: "交付确认中",
      workState_assigned: "已交给主力",
      workState_reported: "待验收",
      workState_blocked: "遇到阻碍",
      workState_uncertain: "交付状态待核实",
      workState_verified: "人工确认通过",
      workState_deferred: "暂缓处理",
      workState_rejected: "不采纳",
      workSource: "查看原始意见",
      workSourceHint: "原意见保留用于追溯，不因咨询历史清空而丢失。意见仍需核实。",
      workAssignedHint: "等待主力回报。你可以继续对话；插件会显示回报，不会把消息送达当作任务完成。",
      workUncertainHint: "未能确认消息是否送达。先检查主对话，确认未在执行后再重新开放，避免重复任务。",
      workReport: "主力执行回报",
      workReportHint: "这是主力提供的执行说明，仍需对照验收条件核实。",
      report_completed: "报告已完成，尚未验收",
      report_blocked: "报告遇到阻碍",
      report_not_applicable: "报告问题不适用",
      workReviewLog: "最近的人工判断",
      workRechecks: "关联的顾问复查",
      workRecheckResult: "查看复查",
      workHistoryRemoved: "这次复查的咨询历史已被清理。",
      workHandoff: "交给主力执行",
      workHandoffTitle: "确认本次任务包",
      workHandoffHint: "确认后将向当前会话主力发送任务，可能启动执行并产生模型费用。仅交付当前这一项。",
      workConfirmHandoff: "确认交付这一项",
      workRecheck: "请顾问复查",
      workRecheckHint: "这是关联待办的复查。先确认当前材料和报告摘录，再发起咨询；复查结论不会自动关闭待办。",
      workReview: "验收或调整状态",
      workDecision: "本次判断",
      workDecision_verify: "确认达到验收条件",
      workDecision_reopen: "重新开放处理",
      workDecision_defer: "暂缓，保留原因",
      workDecision_reject: "不采纳，保留依据",
      workEvidence: "实际检查依据或处理原因",
      workSaveDecision: "保存判断",
      workRepeatAck: "已检查主对话，确认不会与正在执行的任务重复。",
      workCandidates: "可推进的下一步",
      workCandidatesHint: "顾问提出的候选行动。选择后可编辑范围与验收条件，不会直接执行。",
      workConvert: "转为待办",
      workPresets: "常用工作场景",
      workPresetsHint: "选择一个场景会替换问题；可继续编辑，再预览材料。",
      preset_plan: "执行前检查",
      preset_diff: "改动审查",
      preset_test: "排查失败",
      preset_acceptance: "交付前验收",
      presetQuestion_plan: "请检查当前方案的关键假设、遗漏的验收条件与最容易返工的环节。优先提出最小可执行的验证步骤，每项给出可观察的通过标准；材料不足时明确指出。",
      presetQuestion_diff: "请检查当前改动是否引入行为回归、边界遗漏或不必要的范围扩大。按影响优先级给出具体位置、依据、最小修复动作与验证方法；不要把未运行的测试当作通过。",
      presetQuestion_test: "请根据提供的失败输出定位最可能的原因，区分已经证实的事实与假设。给出最短排查顺序、每步预期观察结果，以及修复后必须补充的回归检查。",
      presetQuestion_acceptance: "请对照当前目标、方案、改动与测试材料进行交付前验收：哪些已被证据支持，哪些仍缺验证，哪些问题应先处理。给出可执行的验收清单，不要仅因为有测试输出就判定全部通过。",
      focus_general: "综合检查",
      focus_plan: "审查方案",
      focus_diff: "检查改动",
      focus_test: "分析测试",
      placeholder_general: "提出一个具体问题，例如：这个流程有哪些容易遗漏的边界情况？",
      placeholder_plan: "例如：这个方案的关键假设是否可靠，是否存在更简单的实现？",
      placeholder_diff: "例如：这次改动有没有破坏原有行为，或引入重复请求？",
      placeholder_test: "例如：当前测试覆盖了哪些风险，还缺少哪些重要用例？",
      enabled: '已启用',
      disabled: '已关闭',
      focusLabel: '咨询重点',
      loading: '正在加载…',
      saving: '正在保存…',
      sectionLabel: '顾问',
      pageTitle: '顾问',
      pageHint: "把一个具体问题交给顾问，从另一个视角检查思路、改动与测试。",

      statusLabel: '插件状态',
      enabledLabel: '启用顾问',
      enabledHint: "开启后可发起咨询。自动调用的范围由下方设置决定。",
      statusNeedsModel: '未配置',
      statusReady: '可使用',
      statusBroken: '配置异常',
      statusNoteNeeds: '还没有可用的顾问模型。选定一个模型后即可发起咨询。',
      statusNoteReady: '已配置。这只表示「可以用」，不表示正在调用。',
      statusNoteBroken: '设置无法读取或校验失败。',

      modeLabel: '使用方式',
      modeManual: "仅手动发起",
      modeManualHint: "由你点击咨询入口，主力模型不能自行调用。",
      modeConfirm: "每次先确认",
      modeConfirmHint: "主力模型需要咨询时，先向你申请许可。",
      modeAuto: "允许自动发起",
      modeAutoHint: "允许主力模型直接咨询，受每会话次数上限约束。",
      grantLabel: '本会话授权',
      grantOn: "当前会话已获临时授权。",
      grantOff: "当前会话授权已撤销。",
      grantButton: '授权本会话',
      revokeButton: '撤销本会话授权',
      grantHint: "仅限当前会话，最长 24 小时；在“仅手动发起”模式下临时允许自动咨询。",

      modelLabel: '顾问模型',
      modelFollowSession: "跟随当前模型",
      modelFixed: '指定模型',
      modelProvider: '供应商',
      modelName: '模型',
      modelResolved: '实际将使用',
      modelMissing: '先在顾问设置中选择可用模型，再重新预览。',
      modelFollowHint: "使用宿主当前选择的供应商与模型。切换模型后，顾问也会随之变化。",

      materialsLabel: '材料范围',
      materialsHint: "这些是允许发送的材料类型。每次咨询前，你仍可以缩小范围并预览正文。",
      materialQuestion: '本次问题',
      materialSelection: '选中内容',
      materialPlan: '当前方案',
      materialDiff: '当前改动',
      materialTest: '测试输出',

      deliveryLabel: '工作方式',
      deliveryShow: '只展示给我',
      deliveryShowHint: "先在意见卡片中阅读，再决定是否交给主力模型。",
      deliveryReturn: '返回主力核验',
      deliveryReturnHint: "顾问返回有效意见后自动交给主力模型；交付成功不代表意见已经核验。",

      advancedLabel: '高级设置',
      advancedTokens: '意见长度上限（token）',
      advancedDeadline: '单次超时（毫秒）',
      advancedBudget: '本会话调用上限',
      advancedHistory: '本会话保留条数',
      advancedHint: '上限按插件发起的模型调用计数，不是 HTTP 重试次数。',

      checkLabel: '连接检查',
      checkHint: '只有你点这个按钮才会发出一次真实请求。',
      checkButton: '检查连接',
      checking: '正在检查…',
      checkOk: '连接正常',
      checkFail: '连接失败',

      clearLabel: '历史',
      clearConfirm: '确认清空',
      clearCancel: '不清空',
      clearWarn: '会删掉本会话的全部咨询记录（含还没核验的意见），删了找不回来。',
      clearButton: '清空本会话历史',
      clearDone: '已清空',
      historyLimitLabel: '保留',

      saved: "修改已保存",
      saveFailed: "保存失败，请重试",
      loadFailed: '读取设置失败',
      noChannel: '拿不到宿主通道，这个页面无法读写设置。',

      consult: '咨询顾问',
      consultTitle: '咨询顾问',
      consultQuestion: '要顾问关注什么',
      consultQuestionPlaceholder: '例如：这个方案有没有漏掉验收条件？',
      consultModel: '顾问模型',
      consultMaterials: '材料',
      viewMaterials: '查看材料',
      hideMaterials: '收起材料',
      startConsult: '开始咨询',
      cancel: "取消",
      cancelConsult: '取消这次咨询',
      cancelling: '正在取消…',
      starting: '正在准备材料…',

      cardTitle: '顾问意见',
      cardCollapse: '收起',
      cardExpand: '展开',
      cardFull: '完整意见',
      cardSummary: '先看结论',

      statePreparing: '准备材料',
      stateAwaiting: '等待确认',
      stateRunning: '请求已发出',
      stateReturned: '已返回',
      stateTruncated: '输出被截断 — 意见不完整',
      stateNoAdvice: '顾问没有提出新问题',
      stateTimedOut: '超时',
      stateCancelled: '已取消',
      stateFailed: '失败',
      stateRefused: '未发出',

      waited: '已等待 %s 秒',
      noAdviceNote: '「没有新增建议」不代表任务已验证通过，只表示这次没有发现新问题。',
      truncatedNote: '正文保留，但结尾缺失，不要把它当作完整审查。',
      cancelledNote: '这次只取消了本地等待，不能据此认为远端已停止生成。',
      staleNote: '基于旧版本，需重新核验',
      stalePaths: '改动过的材料：',

      deliveryFact: "主力接收",
      verifyLabel: '核验状态',
      verifyPending: '尚未确认',
      verifyConfirmed: "已标记成立",
      verifyRejected: "已标记不成立",
      verifyInconclusive: '核验无定论',
      dispositionLabel: '处理状态',
      dispositionNone: '未处理',
      dispositionAccepted: '接受',
      dispositionFixed: '已修改',
      dispositionDeferred: '暂不处理',
      deliveredLabel: '已交给主力',
      notDelivered: "尚未交付",

      actionVerify: '让主力核验',
      actionVerifySent: '已交给主力',
      actionMore: '补充材料再问',
      actionDefer: '暂不处理',
      actionRaw: '查看原始意见',
      actionAccept: '标记为已处理',
      actionReject: '主力认为不成立',
      actionInconclusive: '无定论',
      verifyNeedsNote: "请填写核验依据，再保存判断。",
      verifyHint: '标记时请写理由：没有理由的结论，后面的人无法判断它是不是真的核过。',

      historyLabel: '本会话历史',
      historyEmpty: '本会话还没有咨询记录。',
      historyOpen: '历史',
      historyClose: '收起历史',
      historyCount: '本会话已咨询 %s 次',
      historyRunning: '顾问处理中',
      owedTag: '待核验',
      modeChipManual: '顾问：手动模式',
      modeChipConfirm: '顾问：需确认',
      modeChipAuto: '顾问：已授权自动',

      hdRunning: '顾问处理中 · %s 秒',
      hdVerdict: '%s 条意见待核验',
      hdVerdictHint: '点开看意见，标一下它成立还是不成立。',
      hdAuto: '顾问：自动',
      hdLast: '顾问 · %s',
      hdIdleHint: '还没有咨询记录。',
      hdExpand: '点开顾问意见卡片',
      hdCollapse: '收起顾问意见卡片',

      refresh: '刷新',
      chars: '字',
      absentMaterial: '（无内容，未发送）',
      truncatedMaterial: '（已截断）',
      earlierTurnMaterial: '（写于更早的轮次）',
      close: '关闭',
      disabledHint: "顾问已关闭，新咨询不会发起。历史记录保留；已经发出的请求可在重新启用后取消。",
      settingsEyebrow: "第二个视角 · 由你掌控",
      modelSectionHint: "选择谁来回答。使用不同于主力的模型，往往能带来新的视角。",
      modelFixedHint: "为顾问单独指定模型，不随主力的选择变化。",
      selectProvider: "选择供应商",
      selectModel: "选择模型",
      afterSaving: "保存后使用",
      saveBeforeCheck: "先保存修改，再检查连接。",
      modeSectionHint: "手动咨询始终需要你确认；这里控制主力模型能否主动请求顾问。",
      autoScopeHint: "此设置对所有会话生效，自动咨询可能产生模型费用。若只想临时放行当前会话，请选择“仅手动发起”，再使用下方授权。",
      openSessionHint: "先打开一个会话，再管理该会话的授权与记录。",
      materialHint_question: "你的问题，始终包含",
      materialHint_selection: "你选中或粘贴的片段",
      materialHint_plan: "宿主可读取的计划",
      materialHint_diff: "当前工作区的改动",
      materialHint_test: "宿主可读取的测试结果",
      advancedSummary: "长度、超时与次数上限",
      timeoutSeconds: "等待时限（秒）",
      budgetHelp: "等待时限或每会话次数设为 0 表示不限。清空历史不会重置已用次数。",
      historyManagement: "管理历史记录",
      sessionOnly: "当前会话",
      clearBudgetHint: "仅清除当前会话已保存的咨询记录，不重置调用次数，也不取消正在进行的请求；待办及验收记录保留。",
      unsaved: "有未保存的修改",
      settingsSaved: "设置已保存 · 开关与会话授权即时生效",
      saveSettings: "保存修改",
      discard: "放弃修改",
      enabledNow: "顾问已启用",
      disabledNow: "顾问已关闭",
      retry: "重试",
      secondOpinion: "独立意见 · 发送前确认",
      consultSteps: "咨询步骤",
      writeQuestion: "提出问题",
      reviewAndSend: "确认材料并发送",
      thisTimeMaterials: "本次发送的材料",
      thisTimeOnly: "仅影响本次咨询",
      disabledInSettings: "已在设置中关闭",
      pasteSelection: "补充片段（可选）",
      pasteHint: "选中的文字会带到这里，也可以直接粘贴代码或说明。",
      exactMaterial: "查看将发送的完整材料",
      sendCostHint: "确认后将调用模型，可能产生费用。",
      previewFreeHint: "下一步只准备材料，不调用顾问模型。",
      editRequest: "返回编辑",
      confirmAndSend: "确认并发送",
      previewNext: "下一步：预览材料",
      working: "处理中…",
      advisorCenter: "顾问工作台",
      advisorViews: "顾问视图",
      searchHistory: "搜索问题、意见或模型",
      filterHistory: "筛选记录",
      filter_all: "全部",
      filter_pending: "待核验",
      filter_running: "进行中",
      filter_issues: "未完成",
      noResults: "没有匹配的记录",
      changeFilter: "换个关键词，或选择其他筛选条件。",
      emptyHint: "针对一个具体问题发起咨询，顾问意见和后续核验都会保存在这里。",
      opinionNotFact: "顾问提供第二个视角，结论仍需结合实际核验。",
      newConsult: "发起咨询",
      waitingTitle: "顾问正在阅读材料",
      waitingHint: "可以继续对话，结果会保留在这里。",
      materialUsed: "本次咨询使用的材料",
      recordVerdict: "记录核验结果",
      manualVerdictHint: "这里记录你核验后的判断，不会自动声称主力模型已经确认。",
      verdictReason: "核验依据",
      verdictPlaceholder: "说明检查了哪里、依据是什么，以及做了哪些处理。",
      saveVerdict: "保存核验结果",
      verdictSaved: "核验结果已保存。",
      recordMissing: "记录已不存在，请刷新后重试。",
      noLongerRunning: "该咨询已结束，请刷新查看结果。",
      deliveryFailed: "未能交给主力模型，请稍后重试。",
      askAgain: "再次咨询",
      copyOpinion: "复制意见",
      copied: "意见已复制。",
    };

    const EN = {
      dialogTitle: "Advisor × Executor",
      dialogHint: "The advisor plans, clarifies and reviews; the working agent executes. Replies return directly to the agent without copying.",
      dialogSetup: "Task collaboration",
      dialogRounds: "Maximum exchanges in this grant",
      dialogPreview: "Review collaboration permission",
      dialogEnable: "Authorize these exchanges",
      dialogPause: "Pause advisor exchanges",
      dialogPlan: "Ask advisor to plan",
      dialogAsk: "Talk to advisor",
      dialogPhase: "Exchange purpose",
      dialogMessage: "Question or request",
      dialogEvidence: "Additional evidence (optional)",
      dialogSend: "Send this exchange",
      dialogOwnerAdvisor: "Advisor is thinking",
      dialogOwnerWorker: "Executor owns the work",
      dialogOwnerUser: "Waiting for your next decision",
      dialogPaused: "Collaboration disabled or paused",
      dialogBudget: "Exchanges used: %s",
      dialogScoreHint: "Subjective advisor ratings out of 5. Unknown is not zero. Ratings do not establish acceptance.",
      dialogUnknown: "Insufficient evidence to rate",
      dialogNext: "Advisor’s next instruction",
      dialogImpact: "Proposed change",
      dialogTranscript: "Read the exchange and evidence",
      dialogNoScore: "No complete valid scorecard was returned; the original reply is preserved.",
      dialogAdvice: "Advisor reply",
      dialogExecutor: "Executor / user request",
      dialogMaterial: "Materials actually sent",
      dialogState_running: "Thinking",
      dialogState_returned: "Replied",
      dialogState_stale: "Outdated, for reference",
      dialogState_paused: "Paused",
      dialogState_interrupted: "Wait interrupted",
      dialogState_failed: "Failed",
      dialogState_cancelled: "Cancelled",
      dialogState_refused: "Not sent",
      dialogState_truncated: "Incomplete reply",
      dialogState_no_advice: "No new advice",
      dialogState_timed_out: "Wait timed out",
      dialogPhase_plan: "Plan implementation",
      dialogPhase_clarify: "Clarify or discuss disagreement",
      dialogPhase_review: "Review execution evidence",
      dialogVerdict_proceed: "Proceed within the current scope",
      dialogVerdict_revise: "Revise and check again",
      dialogVerdict_blocked: "Resolve missing evidence or blockers",
      dialogDimension_correctness: "Correctness",
      dialogDimension_coverage: "Acceptance coverage",
      dialogDimension_evidence: "Evidence quality",
      dialogDefaultPlan: "Organize implementation steps, key assumptions and verification into a directly usable executor brief. Stay within scope and identify missing information.",
      dialogPauseHint: "Pausing stops new advisor exchanges and local waiting, not work the executor has already started.",

      workState_working: "In progress",
      report_in_progress: "Progress checkpoint, unfinished",
      workNextStep: "Next step",
      workChecks: "Checks reported by the model",
      check_passed: "Reported passed",
      check_failed: "Reported failed",
      check_not_run: "Not run",
      workCheckWarning: "Some checks failed or were not run. Review these gaps before accepting the task.",
      workOldReport: "This report belongs to a previous assignment; it does not establish completion of this attempt.",
      workProgressHistory: "Earlier checkpoints and reports",
      workReportedAt: "Latest report",
      workFilter_ready: "Ready",
      workFilter_running: "In progress",
      workFilter_attention: "Needs attention",
      workNext_prepare: "Check scope and acceptance criteria, then preview the assignment.",
      workNext_await_delivery: "Wait for acknowledgment before sending anything again.",
      workNext_await_report: "Assigned; waiting for a progress checkpoint or result.",
      workNext_continue: "Continue from the latest checkpoint and verify the actual state.",
      workNext_review: "Review the evidence or ask the advisor to recheck it.",
      workNext_unblock: "Resolve the missing input before continuing or changing scope.",
      workNext_check_delivery: "Check the main conversation for receipt before any retry.",
      workNext_closed: "A decision is recorded. Read its evidence or reopen the task.",
      preset_research: "Research evidence",
      preset_document: "Document handoff",
      presetQuestion_research: "Check whether the supplied material can answer the research question. Separate facts, inferences and missing evidence. Prioritize source types and questions to investigate, with a concrete findings table as the deliverable. Never invent sources or claim unread material is verified.",
      presetQuestion_document: "Review this document for its audience and use case: structure, factual support, omissions and actionable instructions. Propose minimal changes with observable delivery criteria. Separate content gaps from wording improvements.",

      workExisting: 'Opened the existing task for this opinion without creating a duplicate.',
      workLinked: 'Back to linked task',
      workScopeMissing: 'This material type is disabled in settings and will not be sent automatically. Adjust the scope or provide an allowed excerpt.',
      workTab: "Work",
      workBadge: "%s open tasks",
      workHeading: "Turn advice into outcomes",
      workHint: "Define scope and acceptance criteria, then assign the work. Reports return here for review.",
      workActive: "Open",
      workAwaiting: "Awaiting review",
      workVerified: "Human verified",
      workNew: "New task",
      workEdit: "Edit task",
      workSave: "Save task",
      workSaved: "Task saved. It has not been assigned yet.",
      workBack: "Back to tasks",
      workTitle: "Task title",
      workAction: "Scope of work",
      workAcceptance: "Acceptance criteria",
      workPriority: "Priority",
      priority_high: "High",
      priority_normal: "Normal",
      priority_low: "Low",
      workFromAdvice: "The source opinion is retained. Confirm the scope and checks. Saving does not start execution.",
      workCreateHint: "Define the outcome and how to check it. Preview the task package before assigning it.",
      workActionHint: "What should be checked or changed? What is outside this task?",
      workAcceptanceHint: "For example: repeated clicks send one request, cancellation allows retry, and relevant tests pass.",
      workExport: "Copy work log",
      workExported: "Tasks, reports and review evidence copied.",
      workSearch: "Search tasks",
      workFilters: "Filter tasks",
      workFilter_active: "Open",
      workFilter_review: "Review",
      workFilter_closed: "Closed",
      workFilter_all: "All",
      workEmpty: "No matching tasks",
      workEmptyHint: "Turn useful advice into a task, or create a concrete goal.",
      workState_ready: "Ready",
      workState_sending: "Confirming delivery",
      workState_assigned: "Assigned",
      workState_reported: "Awaiting review",
      workState_blocked: "Blocked",
      workState_uncertain: "Delivery uncertain",
      workState_verified: "Human verified",
      workState_deferred: "Deferred",
      workState_rejected: "Rejected",
      workSource: "Source opinion",
      workSourceHint: "The opinion is retained even if consultation history is cleared. Its claims still require verification.",
      workAssignedHint: "Waiting for the working model’s report. Continue your conversation; delivery is not completion.",
      workUncertainHint: "Delivery could not be confirmed. Check the conversation before reopening to avoid duplicate execution.",
      workReport: "Execution report",
      workReportHint: "This is the working model’s report. Check it against the acceptance criteria.",
      report_completed: "Reported complete, not yet verified",
      report_blocked: "Reported blocked",
      report_not_applicable: "Reported not applicable",
      workReviewLog: "Latest human review",
      workRechecks: "Linked advisor rechecks",
      workRecheckResult: "View recheck",
      workHistoryRemoved: "This recheck’s consultation history has been removed.",
      workHandoff: "Assign to working model",
      workHandoffTitle: "Review task package",
      workHandoffHint: "Confirming sends this one task to the current working model. It may start execution and incur costs.",
      workConfirmHandoff: "Confirm this assignment",
      workRecheck: "Ask advisor to recheck",
      workRecheckHint: "This recheck is linked to a task. Review current materials and report excerpts before sending. A recheck does not automatically close the task.",
      workReview: "Review or change status",
      workDecision: "Decision",
      workDecision_verify: "Confirm criteria met",
      workDecision_reopen: "Reopen",
      workDecision_defer: "Defer with reason",
      workDecision_reject: "Reject with evidence",
      workEvidence: "Actual evidence or reason",
      workSaveDecision: "Save decision",
      workRepeatAck: "I checked the conversation and confirmed this will not duplicate ongoing work.",
      workCandidates: "Suggested next actions",
      workCandidatesHint: "Suggested actions. Review and edit their scope and checks before execution.",
      workConvert: "Create task from advice",
      workPresets: "Common workflows",
      workPresetsHint: "Choosing a workflow replaces the question. Edit it before previewing materials.",
      preset_plan: "Before implementation",
      preset_diff: "Review changes",
      preset_test: "Diagnose a failure",
      preset_acceptance: "Before handoff",
      presetQuestion_plan: "Review the plan’s assumptions, missing acceptance criteria and likely rework. Propose minimal checks with observable pass criteria. Identify missing evidence.",
      presetQuestion_diff: "Review the changes for regressions, missed edge cases and scope expansion. Prioritize concrete findings with evidence, minimal fixes and checks. Never claim unrun tests passed.",
      presetQuestion_test: "Use the failure output to identify likely causes, separating facts from hypotheses. Give the shortest diagnostic sequence, expected observations and required regression checks.",
      presetQuestion_acceptance: "Review the goal, plan, changes and test evidence before handoff. Identify supported criteria, missing checks and blockers. Provide an actionable acceptance checklist; test output alone does not prove everything passed.",
      focus_general: "General",
      focus_plan: "Plan",
      focus_diff: "Changes",
      focus_test: "Tests",
      placeholder_general: "Ask a specific question, such as: Which edge cases could this flow miss?",
      placeholder_plan: "Are this plan’s assumptions sound? Is there a simpler implementation?",
      placeholder_diff: "Could this change break existing behavior or introduce duplicate requests?",
      placeholder_test: "What risks do the tests cover, and which important cases are missing?",
      enabled: 'Enabled',
      disabled: 'Disabled',
      focusLabel: 'Review focus',
      loading: 'Loading…',
      saving: 'Saving…',
      sectionLabel: 'Advisor',
      pageTitle: 'Advisor',
      pageHint: "Ask your advisor to review a specific question, plan, change or test from another perspective.",

      statusLabel: 'Status',
      enabledLabel: 'Enable the advisor',
      enabledHint: "Enable consultations. The policy below controls automatic calls.",
      statusNeedsModel: 'Not configured',
      statusReady: 'Ready',
      statusBroken: 'Misconfigured',
      statusNoteNeeds: 'No advisor model is available yet. Pick one to enable consultations.',
      statusNoteReady: 'Configured. This means it can be used, not that it is being called.',
      statusNoteBroken: 'Settings could not be read or validated.',

      modeLabel: 'How it is used',
      modeManual: "Manual only",
      modeManualHint: "Start from the consult button. The working model cannot call the advisor on its own.",
      modeConfirm: "Ask each time",
      modeConfirmHint: "The working model asks for permission before each consultation.",
      modeAuto: "Allow automatic calls",
      modeAutoHint: "Allow the working model to consult directly, within the per-session limit.",
      grantLabel: 'Session grant',
      grantOn: "Temporary session permission granted.",
      grantOff: "Session permission revoked.",
      grantButton: 'Grant this session',
      revokeButton: 'Revoke session grant',
      grantHint: "Allow automatic consultations for this session only, for up to 24 hours, while using Manual only.",

      modelLabel: 'Advisor model',
      modelFollowSession: "Follow current model",
      modelFixed: 'Use a specific model',
      modelProvider: 'Provider',
      modelName: 'Model',
      modelResolved: 'Actually used',
      modelMissing: 'Choose an available model in Advisor settings, then preview again.',
      modelFollowHint: "Use the host’s current provider and model. Changing that selection also changes the advisor.",

      materialsLabel: 'Material scope',
      materialsHint: "These are the allowed material types. You can narrow the scope and inspect the exact text before each consultation.",
      materialQuestion: 'The question',
      materialSelection: 'Selection',
      materialPlan: 'Current plan',
      materialDiff: 'Current changes',
      materialTest: 'Test output',

      deliveryLabel: 'Delivery',
      deliveryShow: 'Show to me only',
      deliveryShowHint: "Read the opinion first, then decide whether to send it to the working model.",
      deliveryReturn: 'Hand back for verification',
      deliveryReturnHint: "Automatically send valid advice to the working model. Successful delivery does not mean the advice is verified.",

      advancedLabel: 'Advanced',
      advancedTokens: 'Answer budget (tokens)',
      advancedDeadline: 'Per-call timeout (ms)',
      advancedBudget: 'Calls per session',
      advancedHistory: 'Records kept per session',
      advancedHint: 'The budget counts plugin-initiated model calls, not HTTP retries.',

      checkLabel: 'Connection check',
      checkHint: 'A real request is sent only when you press this button.',
      checkButton: 'Check connection',
      checking: 'Checking…',
      checkOk: 'Connection OK',
      checkFail: 'Connection failed',

      clearLabel: 'History',
      clearConfirm: 'Clear it',
      clearCancel: 'Keep it',
      clearWarn: 'This deletes every consultation in this session, including opinions nobody has verified. It cannot be undone.',
      clearButton: 'Clear this session history',
      clearDone: 'Cleared',
      historyLimitLabel: 'Keep',

      saved: "Changes saved",
      saveFailed: "Could not save. Please retry",
      loadFailed: 'Could not read settings',
      noChannel: 'The host channel is unavailable, so this page cannot read or write settings.',

      consult: 'Consult advisor',
      consultTitle: 'Consult advisor',
      consultQuestion: 'What should the advisor look at',
      consultQuestionPlaceholder: 'e.g. does this plan miss an acceptance criterion?',
      consultModel: 'Advisor model',
      consultMaterials: 'Material',
      viewMaterials: 'View material',
      hideMaterials: 'Hide material',
      startConsult: 'Start consultation',
      cancel: "Cancel",
      cancelConsult: 'Cancel this consultation',
      cancelling: 'Cancelling…',
      starting: 'Preparing material…',

      cardTitle: 'Advisor opinion',
      cardCollapse: 'Collapse',
      cardExpand: 'Expand',
      cardFull: 'Full opinion',
      cardSummary: 'Summary first',

      statePreparing: 'Preparing material',
      stateAwaiting: 'Waiting for confirmation',
      stateRunning: 'Request sent',
      stateReturned: 'Returned',
      stateTruncated: 'Cut off — the opinion is incomplete',
      stateNoAdvice: 'The advisor raised nothing new',
      stateTimedOut: 'Timed out',
      stateCancelled: 'Cancelled',
      stateFailed: 'Failed',
      stateRefused: 'Not sent',

      waited: 'waiting %s s',
      noAdviceNote: '“No new advice” does not mean the work is verified. It means nothing new was found this time.',
      truncatedNote: 'The text is kept but the ending is missing; do not read it as a complete review.',
      cancelledNote: 'Only the local wait was cancelled. This does not prove the provider stopped.',
      staleNote: 'Based on an older version — needs re-checking',
      stalePaths: 'Material that moved:',

      deliveryFact: "Delivery",
      verifyLabel: 'Verification',
      verifyPending: 'Not established',
      verifyConfirmed: "Marked valid",
      verifyRejected: "Marked invalid",
      verifyInconclusive: 'Inconclusive',
      dispositionLabel: 'Disposition',
      dispositionNone: 'Untouched',
      dispositionAccepted: 'Accepted',
      dispositionFixed: 'Changed',
      dispositionDeferred: 'Deferred',
      deliveredLabel: 'Handed to the model',
      notDelivered: "Not delivered",

      actionVerify: 'Ask the model to verify',
      actionVerifySent: 'Handed over',
      actionMore: 'Ask again with more material',
      actionDefer: 'Leave it',
      actionRaw: 'View raw opinion',
      actionAccept: 'Mark as handled',
      actionReject: 'Model disagrees',
      actionInconclusive: 'Inconclusive',
      verifyNeedsNote: "Add review evidence before saving your assessment.",
      verifyHint: 'State a reason when marking: a verdict without one cannot be checked later.',

      historyLabel: 'This session',
      historyEmpty: 'No consultations in this session yet.',
      historyOpen: 'History',
      historyClose: 'Hide history',
      historyCount: 'consulted %s times in this session',
      historyRunning: 'Advisor working',
      owedTag: 'owes verdict',
      modeChipManual: 'Advisor: manual',
      modeChipConfirm: 'Advisor: on confirm',
      modeChipAuto: 'Advisor: auto (granted)',

      hdRunning: 'Advisor working · %ss',
      hdVerdict: '%s awaiting a verdict',
      hdVerdictHint: 'Open it and say whether the finding holds.',
      hdAuto: 'Advisor: auto',
      hdLast: 'Advisor · %s',
      hdIdleHint: 'No consultations yet.',
      hdExpand: 'Open the advisor card',
      hdCollapse: 'Collapse the advisor card',

      refresh: 'Refresh',
      chars: 'chars',
      absentMaterial: '(empty, not sent)',
      truncatedMaterial: '(truncated)',
      earlierTurnMaterial: '(written before this turn)',
      close: 'Close',
      disabledHint: "Advisor is off. New consultations are blocked and history is retained. Re-enable to cancel an existing request.",
      settingsEyebrow: "A SECOND OPINION · YOUR CONTROL",
      modelSectionHint: "Choose who answers. A different model may offer a useful second perspective.",
      modelFixedHint: "Choose a dedicated advisor model, independent of the working model.",
      selectProvider: "Choose provider",
      selectModel: "Choose model",
      afterSaving: "After saving",
      saveBeforeCheck: "Save your changes before checking the connection.",
      modeSectionHint: "Manual consultations always require your confirmation. This policy controls requests initiated by the working model.",
      autoScopeHint: "This applies to all sessions and automatic consultations may incur model costs. For a temporary exception, choose Manual only and grant the current session below.",
      openSessionHint: "Open a conversation to manage its permission and history.",
      materialHint_question: "Your question is always included",
      materialHint_selection: "Text you select or paste",
      materialHint_plan: "Plan available from the host",
      materialHint_diff: "Current workspace changes",
      materialHint_test: "Test results available from the host",
      advancedSummary: "Length, timeout and usage limits",
      timeoutSeconds: "Wait limit (seconds)",
      budgetHelp: "Set wait limit or session allowance to 0 for no limit. Clearing history does not reset usage.",
      historyManagement: "Manage history",
      sessionOnly: "CURRENT CONVERSATION",
      clearBudgetHint: "Remove this conversation’s saved consultations. Usage and work items are retained; active requests are not cancelled.",
      unsaved: "You have unsaved changes",
      settingsSaved: "Settings saved · Switch and session permission apply immediately",
      saveSettings: "Save changes",
      discard: "Discard changes",
      enabledNow: "Advisor enabled",
      disabledNow: "Advisor disabled",
      retry: "Retry",
      secondOpinion: "SECOND OPINION · REVIEW BEFORE SENDING",
      consultSteps: "Consultation steps",
      writeQuestion: "Write a question",
      reviewAndSend: "Review and send",
      thisTimeMaterials: "Materials for this consultation",
      thisTimeOnly: "This consultation only",
      disabledInSettings: "Disabled in settings",
      pasteSelection: "Additional excerpt (optional)",
      pasteHint: "Selected text appears here. You can also paste code or context.",
      exactMaterial: "Exact material to be sent",
      sendCostHint: "Confirming calls the model and may incur costs.",
      previewFreeHint: "The next step prepares materials without calling the advisor.",
      editRequest: "Back to edit",
      confirmAndSend: "Confirm and send",
      previewNext: "Next: review materials",
      working: "Working…",
      advisorCenter: "Advisor workspace",
      advisorViews: "Advisor views",
      searchHistory: "Search questions, opinions or models",
      filterHistory: "Filter consultations",
      filter_all: "All",
      filter_pending: "To review",
      filter_running: "In progress",
      filter_issues: "Incomplete",
      noResults: "No matching consultations",
      changeFilter: "Try another keyword or filter.",
      emptyHint: "Ask a specific question. Opinions and subsequent reviews will be saved here.",
      opinionNotFact: "A second perspective. Verify findings against the actual work.",
      newConsult: "New consultation",
      waitingTitle: "The advisor is reviewing your materials",
      waitingHint: "You can continue the conversation. The result will be kept here.",
      materialUsed: "Materials used",
      recordVerdict: "Record a review",
      manualVerdictHint: "Record your own assessment here. This does not claim the working model has verified the finding.",
      verdictReason: "Review evidence",
      verdictPlaceholder: "Explain what you checked, the evidence and any action taken.",
      saveVerdict: "Save review",
      verdictSaved: "Review saved.",
      recordMissing: "This record no longer exists. Refresh and retry.",
      noLongerRunning: "This consultation has ended. Refresh to see the result.",
      deliveryFailed: "Could not send to the working model. Please retry.",
      askAgain: "Ask again",
      copyOpinion: "Copy opinion",
      copied: "Opinion copied.",
    };

    const DICT = { zh: ZH, en: EN };

    // ------------------------------------------------------------------ styles

    const CSS = `
/* Scoped to plugin surfaces; host tokens keep light/dark themes consistent. */
.dsha-page,.dsha-dock,.dsha-panel,.dsha-consult,.dsha-hdwrap,.dsha-entry {
 --ad-text:var(--dsw-alias-label-primary,#202632); --ad-muted:var(--dsw-alias-label-secondary,#687383);
 --ad-bg:var(--dsw-alias-bg-base,#fff); --ad-soft:var(--dsw-alias-bg-layer-1,#f5f7fa);
 --ad-hover:var(--dsw-alias-bg-layer-2,#edf1f6); --ad-border:var(--dsw-alias-border-l1,#dce2e9);
 --ad-brand:var(--dsw-alias-brand-primary,#2867cc); --ad-error:var(--dsw-alias-state-error-primary,#bd3545);
 --ad-warn:var(--dsw-alias-state-warn-primary,#986418); --ad-ok:var(--dsw-alias-state-success-primary,#287b57);
 color:var(--ad-text); font:inherit; font-size:14px; line-height:1.6; text-align:left; box-sizing:border-box;
}
.dsha-page *,.dsha-dock *,.dsha-panel *,.dsha-consult * { box-sizing:border-box; }
.dsha-page { max-width:840px; margin:0 auto; padding:12px 12px 32px; }
.dsha-page h1,.dsha-page h2,.dsha-dock h2,.dsha-panel h2,.dsha-consult h3,.dsha-consult h4 { margin:0; color:var(--ad-text); font-weight:600; line-height:1.4; }
.dsha-page h1 { font-size:26px; letter-spacing:-.03em; margin:4px 0 8px; }
.dsha-page h2,.dsha-dock h2,.dsha-panel h2 { font-size:17px; }
.dsha-page-head { display:flex; justify-content:space-between; align-items:center; gap:24px; padding:12px 0 28px; }
.dsha-eyebrow { display:block; color:var(--ad-muted); font-size:11px; letter-spacing:.1em; font-weight:600; }
.dsha-hint,.dsha-note { display:block; color:var(--ad-muted); font-size:12px; line-height:1.65; margin:0; overflow-wrap:anywhere; }
.dsha-hint { font-size:13px; }
.dsha-note.err,.dsha-callout.err { color:var(--ad-error); }
.dsha-note.warn { color:var(--ad-warn); }
.dsha-note.ok { color:var(--ad-ok); }
.dsha-fields { border:0; padding:0; margin:0; min-width:0; }
.dsha-section { border-top:1px solid var(--ad-border); padding:26px 0; }
.dsha-section-title { display:flex; align-items:flex-start; gap:12px; margin-bottom:16px; }
.dsha-section-title p { margin-top:4px; }
.dsha-step { color:var(--ad-muted); font-size:11px; line-height:25px; font-variant-numeric:tabular-nums; }
.dsha-block { display:flex; flex-direction:column; gap:14px; }
.dsha-choices,.dsha-grid { display:grid; gap:10px; grid-template-columns:repeat(3,minmax(0,1fr)); }
.dsha-choices.two,.dsha-grid.two { grid-template-columns:repeat(2,minmax(0,1fr)); }
.dsha-choice { display:flex; gap:10px; padding:15px; border:1px solid var(--ad-border); border-radius:10px; cursor:pointer; align-items:flex-start; background:var(--ad-bg); min-width:0; }
.dsha-choice > span { min-width:0; }
.dsha-choice strong { display:block; margin-bottom:4px; font-size:13px; }
.dsha-choice[data-selected="true"] { border-color:var(--ad-brand); background:color-mix(in srgb,var(--ad-brand) 5%,var(--ad-bg)); }
.dsha-choice:hover { border-color:var(--ad-brand); }
.dsha-page input[type=radio],.dsha-page input[type=checkbox],.dsha-dock input[type=checkbox] { accent-color:var(--ad-brand); flex:none; width:16px; height:16px; margin:4px 0 0; }
.dsha-material-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px 24px; }
.dsha-material-choice { display:flex; align-items:flex-start; gap:10px; cursor:pointer; padding:6px 0; }
.dsha-material-choice strong { font-size:13px; font-weight:500; }
.dsha-field { display:flex; flex-direction:column; gap:7px; font-size:13px; font-weight:500; min-width:0; }
.dsha-input,.dsha-select,.dsha-textarea { display:block; width:100%; min-width:0; font:inherit; font-weight:400; font-size:13px; line-height:1.6; color:var(--ad-text); background:var(--ad-bg); border:1px solid var(--ad-border); border-radius:8px; padding:9px 11px; min-height:40px; }
.dsha-textarea { resize:vertical; max-height:260px; min-height:88px; }
.dsha-textarea.compact { min-height:66px; }
.dsha-row,.dsha-model-summary,.dsha-session-line { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.dsha-model-summary { background:var(--ad-soft); border-radius:8px; padding:10px 12px; font-size:12px; overflow-wrap:anywhere; }
.dsha-model-summary strong { font-weight:500; }
.dsha-session-line { justify-content:space-between; gap:12px; padding-top:4px; }
.dsha-session-line > div { flex:1; min-width:180px; }
.dsha-session-line strong { font-size:13px; font-weight:500; }
.dsha-btn,.dsha-icon-btn,.dsha-tabs button,.dsha-filters button { font:inherit; font-size:13px; line-height:1.4; padding:8px 13px; min-height:36px; border-radius:8px; border:1px solid var(--ad-border); background:var(--ad-bg); color:var(--ad-text); cursor:pointer; }
.dsha-btn:hover:not(:disabled),.dsha-icon-btn:hover:not(:disabled) { background:var(--ad-hover); }
.dsha-btn.primary { background:var(--ad-brand); border-color:var(--ad-brand); color:#fff; }
.dsha-btn.primary:hover:not(:disabled) { filter:brightness(1.08); background:var(--ad-brand); }
.dsha-btn.ghost { border-color:transparent; background:transparent; }
.dsha-btn.danger { background:var(--ad-error); border-color:var(--ad-error); color:#fff; }
.dsha-btn:disabled,.dsha-icon-btn:disabled,.dsha-fields:disabled { opacity:.55; cursor:default; }
.dsha-icon-btn { border:0; width:36px; height:36px; padding:0; flex:none; font-size:23px; background:transparent; }
.dsha-page :focus-visible,.dsha-dock :focus-visible,.dsha-panel :focus-visible,.dsha-consult :focus-visible,.dsha-hd:focus-visible,.dsha-entry:focus-visible { outline:2px solid var(--ad-brand); outline-offset:3px; }
.dsha-switch { flex:none; display:flex; align-items:center; gap:8px; border:0; background:none; color:var(--ad-text); font:inherit; font-size:12px; cursor:pointer; padding:8px 0 8px 8px; }
.dsha-switch-track { width:36px; height:22px; border-radius:12px; background:var(--ad-muted); padding:3px; display:block; }
.dsha-switch-track:after { content:''; display:block; width:16px; height:16px; border-radius:50%; background:#fff; transition:transform .15s; }
.dsha-switch[aria-checked="true"] .dsha-switch-track { background:var(--ad-brand); }
.dsha-switch[aria-checked="true"] .dsha-switch-track:after { transform:translateX(14px); }
.dsha-savebar { position:sticky; bottom:0; display:flex; align-items:center; gap:8px; padding:16px 0; background:var(--ad-bg); border-top:1px solid var(--ad-border); z-index:2; }
.dsha-save-state { flex:1; font-size:12px; color:var(--ad-muted); }
.dsha-save-state[role=alert] { color:var(--ad-error); }
.dsha-callout { border-left:3px solid var(--ad-border); background:var(--ad-soft); border-radius:0 8px 8px 0; padding:12px 14px; font-size:12px; line-height:1.65; margin:0; overflow-wrap:anywhere; }
.dsha-callout.err { border-color:var(--ad-error); }
.dsha-callout.warn { border-color:var(--ad-warn); }
.dsha-callout p { margin:0 0 8px; }
.dsha-details > summary { cursor:pointer; font-size:13px; font-weight:500; padding:4px 0; }
.dsha-details > summary .dsha-note { display:inline; margin-left:10px; font-weight:400; }
.dsha-details[open] > summary { margin-bottom:14px; }
.dsha-details > .dsha-note { margin:12px 0; }
.dsha-details .dsha-grid + p { margin-top:12px; }
.dsha-hdwrap { display:inline-flex; position:relative; }
.dsha-hd,.dsha-entry { display:inline-flex; align-items:center; gap:7px; font:inherit; font-size:12px; padding:7px 12px; min-height:34px; border:1px solid var(--ad-border); border-radius:999px; background:transparent; color:var(--ad-muted); cursor:pointer; }
.dsha-hd,.dsha-entry { white-space:nowrap; flex-shrink:0; }
.dsha-hd:hover,.dsha-entry:hover { color:var(--ad-text); background:var(--ad-soft); }
.dsha-hd.brand,.dsha-entry[data-open="true"] { color:var(--ad-brand); border-color:color-mix(in srgb,var(--ad-brand) 40%,var(--ad-border)); background:color-mix(in srgb,var(--ad-brand) 7%,var(--ad-bg)); }
.dsha-hd.warn { color:var(--ad-warn); } .dsha-hd.err { color:var(--ad-error); }
.dsha-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:currentColor; flex:none; }
.dsha-dot.ok { color:var(--ad-ok); } .dsha-dot.warn { color:var(--ad-warn); } .dsha-dot.err { color:var(--ad-error); }
.dsha-panel { position:fixed; right:24px; top:72px; z-index:100; display:flex; flex-direction:column; width:min(600px,calc(100vw - 48px)); max-height:calc(100dvh - 96px); border:1px solid var(--ad-border); border-radius:16px; background:var(--dsw-alias-bg-overlay,var(--ad-bg)); box-shadow:0 16px 64px #0002; overflow:hidden; }
.dsha-panel-head,.dsha-dock-head { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:20px 22px 16px; flex:none; }
.dsha-panel-head h2,.dsha-dock-head h2 { margin-top:3px; }
.dsha-panel-actions { display:flex; gap:4px; }
.dsha-tabs { display:flex; flex-wrap:wrap; gap:4px; }
.dsha-tabs button { background:transparent; border-color:transparent; color:var(--ad-muted); }
.dsha-tabs button[aria-pressed="true"] { color:var(--ad-brand); background:color-mix(in srgb,var(--ad-brand) 8%,var(--ad-bg)); font-weight:500; }
.dsha-panel-tabs { padding:0 22px 14px; border-bottom:1px solid var(--ad-border); flex:none; }
.dsha-panel-body { padding:22px; display:flex; flex-direction:column; gap:16px; overflow:auto; min-height:0; overscroll-behavior:contain; }
.dsha-panel-footer,.dsha-dock-footer { padding:14px 22px; display:flex; align-items:center; justify-content:space-between; gap:16px; border-top:1px solid var(--ad-border); background:var(--ad-bg); flex:none; }
.dsha-panel-footer .dsha-btn { flex:none; }
.dsha-panel-footer .dsha-note { max-width:300px; }
.dsha-consult { display:flex; flex-direction:column; gap:18px; min-width:0; }
.dsha-consult-head { display:flex; flex-direction:column; gap:8px; }
.dsha-factline { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.dsha-status { display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:500; }
.dsha-when,.dsha-prov { font-size:12px; color:var(--ad-muted); margin:0; overflow-wrap:anywhere; }
.dsha-question-title { font-size:18px; overflow-wrap:anywhere; }
.dsha-advice { font-size:14px; line-height:1.9; white-space:pre-wrap; overflow-wrap:anywhere; margin:0; }
.dsha-outcome-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; background:var(--ad-soft); padding:14px; border-radius:10px; }
.dsha-outcome-grid strong { font-size:12px; font-weight:500; }
.dsha-quote { margin:0; padding:4px 0 4px 12px; border-left:2px solid var(--ad-border); font-size:13px; color:var(--ad-muted); white-space:pre-wrap; overflow-wrap:anywhere; }
.dsha-card-actions { gap:4px; }
.dsha-verdict-form { border-top:1px solid var(--ad-border); padding-top:18px; display:flex; flex-direction:column; gap:14px; }
.dsha-verdict-form .dsha-fields { display:flex; flex-direction:column; gap:14px; }
.dsha-filters { display:flex; flex-wrap:wrap; gap:6px; }
.dsha-filters button { font-size:12px; min-height:32px; padding:5px 10px; border-color:transparent; color:var(--ad-muted); }
.dsha-filters button[aria-pressed=true] { color:var(--ad-text); background:var(--ad-hover); }
.dsha-list { display:flex; flex-direction:column; gap:8px; }
.dsha-history-item { text-align:left; border:1px solid var(--ad-border); border-radius:10px; padding:14px; background:transparent; color:var(--ad-text); font:inherit; cursor:pointer; display:flex; flex-direction:column; gap:7px; width:100%; }
.dsha-history-item:hover { background:var(--ad-soft); }
.dsha-history-top { display:flex; align-items:center; gap:7px; font-size:11px; color:var(--ad-muted); }
.dsha-history-top strong { font-weight:500; }
.dsha-history-top time { margin-left:auto; white-space:nowrap; }
.dsha-history-item[data-owed="true"] .dsha-history-top strong { color:var(--ad-brand); }
.dsha-history-question { font-size:14px; overflow-wrap:anywhere; }
.dsha-empty { padding:42px 16px; text-align:center; display:flex; flex-direction:column; align-items:center; gap:10px; }
.dsha-empty-symbol { font-size:32px; color:var(--ad-brand); }
.dsha-empty .dsha-note { max-width:310px; }
.dsha-dock { margin:8px 0; border:1px solid var(--ad-border); border-radius:14px; background:var(--ad-bg); max-height:min(76dvh,740px); overflow:auto; overscroll-behavior:contain; width:100%; min-width:0; }
.dsha-dock > .dsha-fields { padding:0 22px 18px; display:flex; flex-direction:column; gap:16px; }
.dsha-progress { list-style:none; padding:0 22px; margin:0 0 20px; display:flex; gap:24px; color:var(--ad-muted); font-size:12px; }
.dsha-progress li { display:flex; align-items:center; gap:8px; }
.dsha-progress li > span { display:grid; place-items:center; width:22px; height:22px; border:1px solid var(--ad-border); border-radius:50%; font-size:11px; }
.dsha-progress li[aria-current] { color:var(--ad-brand); }
.dsha-progress li[aria-current] > span { background:var(--ad-brand); border-color:var(--ad-brand); color:#fff; }
.dsha-scope-head { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; }
.dsha-scope { display:flex; flex-wrap:wrap; gap:8px 18px; }
.dsha-scope-option { display:flex; align-items:center; gap:7px; font-size:12px; cursor:pointer; }
.dsha-dock input[type=checkbox] { margin:0; }
.dsha-preview { border-top:1px solid var(--ad-border); padding:18px 22px; display:flex; flex-direction:column; gap:10px; }
.dsha-preview-question { font-size:14px; font-weight:500; overflow-wrap:anywhere; }
.dsha-material-status { display:flex; gap:4px 14px; flex-wrap:wrap; }
.dsha-pre { font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,'Microsoft YaHei','PingFang SC','Noto Sans SC',monospace; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--ad-soft); color:var(--ad-text); border-radius:8px; padding:14px; max-height:240px; overflow:auto; margin:0; }
.dsha-dock > .dsha-callout { margin:0 22px 16px; }
.dsha-dock-footer { position:sticky; bottom:0; }
.dsha-running { display:flex; align-items:center; gap:12px; padding:20px 0; font-size:13px; }
.dsha-spinner { width:20px; height:20px; border:2px solid var(--ad-border); border-top-color:var(--ad-brand); border-radius:50%; animation:dsha-spin 1s linear infinite; flex:none; }
.dsha-sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }

.dsha-work-board,.dsha-work-detail,.dsha-work-form,.dsha-work-form .dsha-fields,.dsha-work-review,.dsha-work-approval { display:flex; flex-direction:column; gap:16px; min-width:0; }
.dsha-work-board h3,.dsha-work-detail h3,.dsha-work-form h3 { margin:0; font-size:18px; line-height:1.5; overflow-wrap:anywhere; }
.dsha-work-detail h4,.dsha-work-review h4,.dsha-work-approval h4 { margin:0; font-size:14px; }
.dsha-work-state { font-size:12px; padding:4px 10px; border-radius:20px; background:var(--ad-soft); color:var(--ad-muted); }
.dsha-work-state.reported,.dsha-work-state.verified { color:var(--ad-brand); }
.dsha-work-state.blocked,.dsha-work-state.uncertain { color:var(--ad-warn); }
.dsha-work-section { display:flex; flex-direction:column; gap:8px; font-size:13px; }
.dsha-work-section p { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.8; }
.dsha-work-section.acceptance { padding:14px; border-radius:10px; background:var(--ad-soft); border-left:3px solid var(--ad-brand); }

.dsha-discussion { padding:16px; border:1px solid var(--ad-border); border-radius:12px; display:flex; flex-direction:column; gap:12px; }
.dsha-discussion h3,.dsha-discussion p { margin:0; overflow-wrap:anywhere; white-space:pre-wrap; line-height:1.7; }
.dsha-dialogue-list { display:flex; flex-direction:column; gap:16px; }
.dsha-dialogue-round { display:flex; flex-direction:column; gap:10px; border-top:1px solid var(--ad-border); padding-top:16px; font-size:13px; }
.dsha-score-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
.dsha-score { padding:10px; background:var(--ad-soft); border-radius:8px; display:flex; flex-direction:column; gap:8px; }
.dsha-score > strong { font-size:20px; color:var(--ad-brand); }
.dsha-score p { font-size:12px; color:var(--ad-muted); }
@media(max-width:540px) { .dsha-score-grid { grid-template-columns:1fr; } }
.dsha-checks { display:flex; flex-direction:column; gap:10px; }
.dsha-check { padding:12px; border:1px solid var(--ad-border); border-radius:8px; display:flex; flex-direction:column; gap:6px; overflow-wrap:anywhere; }
.dsha-check-status { font-size:12px; color:var(--ad-muted); }
.dsha-check.failed .dsha-check-status,.dsha-check.not_run .dsha-check-status { color:var(--ad-warn); }
.dsha-check.passed .dsha-check-status,.dsha-work-state.working { color:var(--ad-brand); }

.dsha-work-section.report { padding:16px 0; border-block:1px solid var(--ad-border); }
.dsha-work-review,.dsha-work-approval { padding:16px; border:1px solid var(--ad-border); border-radius:10px; }
.dsha-action-candidates { display:flex; flex-direction:column; gap:12px; }
.dsha-candidate { border:1px solid var(--ad-border); border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:8px; font-size:13px; }
.dsha-candidate p { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
.dsha-candidate .dsha-btn { align-self:flex-start; color:var(--ad-brand); }
.dsha-work-item .dsha-note { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.dsha-work-board .dsha-outcome-grid strong { font-size:22px; }
@keyframes dsha-spin { to { transform:rotate(360deg); } }
@media(max-width:600px) {
 .dsha-page { padding:4px 8px 20px; } .dsha-page-head { gap:12px; } .dsha-page h1 { font-size:24px; }
 .dsha-choices,.dsha-choices.two,.dsha-grid.two { grid-template-columns:1fr; }
 .dsha-material-grid { grid-template-columns:1fr; gap:6px; }
 .dsha-choice { padding:12px; } .dsha-section { padding:22px 0; }
 .dsha-savebar { flex-wrap:wrap; } .dsha-save-state { flex-basis:100%; }
 .dsha-panel { right:12px; left:12px; top:64px; width:auto; max-height:calc(100dvh - 76px); border-radius:12px; }
 .dsha-panel-head,.dsha-dock-head,.dsha-panel-body { padding:16px; }
 .dsha-panel-tabs { padding:0 16px 12px; }
 .dsha-panel-footer,.dsha-dock-footer { padding:12px 16px; gap:10px; }
 .dsha-dock-footer { flex-wrap:wrap; } .dsha-dock-footer > .dsha-row { margin-left:auto; }
 .dsha-dock > .dsha-fields,.dsha-preview { padding:0 16px 16px; }
 .dsha-preview { padding-top:16px; } .dsha-progress { padding:0 16px; gap:16px; }
 .dsha-outcome-grid { gap:8px; padding:12px; } .dsha-panel-footer .dsha-note { font-size:11px; }
}
@media(prefers-reduced-motion:reduce) { .dsha-spinner { animation:none; } .dsha-switch-track:after { transition:none; } }
`;

    function ensureStyle() {
      if (typeof document === 'undefined') return null;
      const existing = document.getElementById(STYLE_ID);
      if (existing) return null;
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
      return element;
    }

    // ------------------------------------------------------------- small utils

    const NON_TERMINAL = new Set(['preparing', 'awaiting', 'running']);

    function isPending(record) {
      return Boolean(record && NON_TERMINAL.has(record.state));
    }

    /**
     * One tiny store per session, shared by the five slots.
     *
     * The composer bar, the header chip and the card are separate slot cells in
     * separate React roots; without a shared read they would each poll the host
     * and disagree about whether a consultation is running.
     */
    function fmtDateTime(iso) {
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    function needsReview(record) {
      return Boolean(record.advice && !isPending(record) && !['confirmed', 'rejected'].includes(record.verification) && !['fixed', 'deferred'].includes(record.disposition));
    }

    function createStore() {
      const state = new Map();
      const listeners = new Map();
      const empty = { settings: null, status: null, resolved: null, records: [], running: 0, error: null, loaded: false };

      function read(sessionId) {
        return state.get(sessionId) || empty;
      }
      function emit(sessionId) {
        const set = listeners.get(sessionId);
        if (!set) return;
        for (const fn of Array.from(set)) {
          try {
            fn();
          } catch {
            /* a thrown subscriber must not stop the others */
          }
        }
      }
      function write(sessionId, patch) {
        state.set(sessionId, { ...read(sessionId), ...patch });
        emit(sessionId);
      }
      function subscribe(sessionId, fn) {
        if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
        listeners.get(sessionId).add(fn);
        return () => {
          const set = listeners.get(sessionId);
          if (set) set.delete(fn);
        };
      }
      function updateSettings(settings) {
        for (const id of state.keys()) write(id, { settings });
      }
      return { read, write, subscribe, emit, updateSettings };
    }

    const store = createStore();

    /**
     * The switch is global (one settings file), so it needs a channel that does
     * not depend on a session id.
     *
     * The settings page is root-scoped: when it is open the UI session service
     * may already have dropped the conversation, so it often cannot name the
     * session whose composer entry it is supposed to hide. Publishing to a
     * session-keyed store would then silently do nothing, and the plugin would
     * keep drawing until the next reload. `null` means "not read yet" so the
     * first paint is not a guess.
     */
    const enabledState = { value: null, listeners: new Set() };
    function setEnabledGlobal(next) {
      if (typeof next !== 'boolean' || enabledState.value === next) return;
      enabledState.value = next;
      for (const fn of Array.from(enabledState.listeners)) {
        try {
          fn();
        } catch {
          /* a thrown subscriber must not stop the others */
        }
      }
    }
    function useEnabledGlobal() {
      return useSyncExternalStore(
        (fn) => {
          enabledState.listeners.add(fn);
          return () => enabledState.listeners.delete(fn);
        },
        () => enabledState.value,
        () => enabledState.value,
      );
    }

    // Whether the opinion card is expanded, and whether it should land on the
    // history list. It lives at module scope because the header pill and the card
    // are registered into two different slots, so they are separate React roots:
    // a `useState` in the card would be invisible to the pill, and a pill that
    // says "10 awaiting a verdict" must be able to open the list of those ten.
    //
    // The stored value is the view to land on ('card' or 'history'); absence
    // means collapsed.
    const dockOpen = { bySession: new Map(), listeners: new Set() };
    function dockViewFor(sessionId) {
      return (sessionId && dockOpen.bySession.get(sessionId)) || null;
    }
    function setDockView(sessionId, value) {
      if (!sessionId) return;
      const next = ['history', 'work'].includes(value) ? value : value ? 'card' : null;
      if (dockViewFor(sessionId) === next) return;
      if (next) dockOpen.bySession.set(sessionId, next);
      else dockOpen.bySession.delete(sessionId);
      for (const fn of Array.from(dockOpen.listeners)) {
        try {
          fn();
        } catch {
          /* a thrown subscriber must not stop the others */
        }
      }
    }
    function useDockView(sessionId) {
      const snapshot = useCallback(() => dockViewFor(sessionId), [sessionId]);
      return useSyncExternalStore(
        useCallback(
          (fn) => {
            dockOpen.listeners.add(fn);
            return () => dockOpen.listeners.delete(fn);
          },
          [],
        ),
        snapshot,
        snapshot,
      );
    }

    // ------------------------------------------------------------------ helpers

    function createBridge(ctx) {
      // The channel path carries a `/` inside its name, which `connection.rpc.call`
      // refuses outright (its channel pattern allows one segment). The wire format
      // is the same JSON envelope the /api router speaks, so the page talks to the
      // route directly: same origin, same cookie, no extra transport.
      const rpcCall = async (endpoint, payload) => {
        const rpcId = uuid();
        const response = await fetch(`${CHANNEL}/${endpoint}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, params: payload === undefined ? {} : payload }),
        });
        if (!response.ok) {
          const error = new Error(`advisor channel: HTTP ${response.status}`);
          error.code = 'transport';
          throw error;
        }
        const body = await response.json();
        const result = body && body.result && typeof body.result.ok === 'boolean' ? body.result : body;
        if (result && result.ok) return result.value;
        const error = new Error((result && result.error && result.error.message) || 'rpc failed');
        error.code = (result && result.error && result.error.code) || 'rpc-failed';
        throw error;
      };

      const loads = new Map();
      function load(sessionId) {
        if (!sessionId) return Promise.resolve(null);
        if (!loads.has(sessionId)) loads.set(sessionId, readSession(sessionId).finally(() => loads.delete(sessionId)));
        return loads.get(sessionId);
      }
      async function readSession(sessionId) {
        if (!sessionId) return null;
        try {
          const [settingsResult, listResult, workResult] = await Promise.all([
            rpcCall('settings.get', { sessionId }),
            rpcCall('consult.list', { sessionId }),
            rpcCall('work.list', { sessionId }),
          ]);
          store.write(sessionId, {
            settings: settingsResult.settings,
            status: settingsResult.status,
            resolved: settingsResult.resolved,
            mode: settingsResult.mode,
            sessionGranted: settingsResult.sessionGranted,
            sessionSelection: settingsResult.sessionSelection,
            providers: settingsResult.providers,
            models: settingsResult.models,
            historyLimit: settingsResult.historyLimit,
            workItems: workResult.items, workCounts: workResult.counts,
            records: (listResult && listResult.records) || [],
            running: (listResult && listResult.running) || 0,
            error: null,
            loaded: true,
          });
          // The host is the authority on the switch, so every load refreshes the
          // global copy; a page that was left open while the file changed on disk
          // then agrees with it on the next read instead of drifting.
          setEnabledGlobal(!!(settingsResult.settings && settingsResult.settings.enabled !== false));
          return settingsResult;
        } catch (err) {
          store.write(sessionId, { error: String(err && err.message ? err.message : err), loaded: true });
          return null;
        }
      }

      async function reloadRecords(sessionId) {
        if (!sessionId) return;
        try {
          const [listResult, workResult] = await Promise.all([rpcCall('consult.list', { sessionId }), rpcCall('work.list', { sessionId })]);
          store.write(sessionId, {
            error: null,
            workItems: workResult.items, workCounts: workResult.counts,
            records: (listResult && listResult.records) || [],
            running: (listResult && listResult.running) || 0,
          });
        } catch (err) {
          store.write(sessionId, { error: String(err.message || err) });
        }
      }

      return { rpcCall, load, reloadRecords };
    }

    function useStore(sessionId) {
      const snapshot = useCallback(() => store.read(sessionId), [sessionId]);
      return useSyncExternalStore(
        useCallback((fn) => store.subscribe(sessionId, fn), [sessionId]),
        snapshot,
        snapshot,
      );
    }

    /** Ticks while `active`, so "waited N seconds" is measured, not invented. */
    function useNow(active) {
      const [now, setNow] = useState(() => Date.now());
      useEffect(() => {
        if (!active) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
      }, [active]);
      return now;
    }

    // ------------------------------------------------------------ state wording

    function stateLabel(t, state) {
      switch (state) {
        case 'preparing':
          return t('statePreparing');
        case 'awaiting':
          return t('stateAwaiting');
        case 'running':
          return t('stateRunning');
        case 'returned':
          return t('stateReturned');
        case 'truncated':
          return t('stateTruncated');
        case 'no_advice':
          return t('stateNoAdvice');
        case 'timed_out':
          return t('stateTimedOut');
        case 'cancelled':
          return t('stateCancelled');
        case 'failed':
          return t('stateFailed');
        case 'refused':
          return t('stateRefused');
        default:
          return String(state || '');
      }
    }

    function stateTone(state) {
      if (state === 'returned') return 'ok';
      if (state === 'truncated' || state === 'no_advice' || state === 'timed_out') return 'warn';
      if (state === 'failed' || state === 'refused') return 'err';
      return '';
    }

    /**
     * The caveat a state carries, if it has one.
     *
     * These are not disclaimers bolted on for safety. Each names the specific
     * way the record could be misread: a cut-off answer as a complete review, a
     * cancelled wait as a stopped provider, silence as verification.
     */
    function stateCaveat(t, record) {
      if (!record) return null;
      if (record.state === 'truncated') return t('truncatedNote');
      if (record.state === 'no_advice') return t('noAdviceNote');
      if (record.state === 'cancelled') return t('cancelledNote');
      return null;
    }

    function firstLines(text, count) {
      const lines = String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      return lines.slice(0, count).join('\n');
    }

    /**
     * A collapsed preview of an opinion.
     *
     * Counting lines is not enough: an advisor writes few, very long paragraphs, so
     * "the first four lines" can be a full page and the panel grows to the edge of
     * the window. Bound the preview by characters as well, and cut at a word
     * boundary so the truncation does not read as a typo.
     */
    function previewOf(text, count = 4, maxChars = 380) {
      const head = firstLines(text, count);
      const flat = head.replace(/\s*\n+\s*/g, ' ⏎ ');
      if (flat.length <= maxChars) return head;
      const clipped = flat.slice(0, maxChars);
      const atSpace = clipped.lastIndexOf(' ');
      return `${(atSpace > maxChars * 0.6 ? clipped.slice(0, atSpace) : clipped).trimEnd()}…`;
    }

    // ---------------------------------------------------------------- settings

    let settingsDraft = null;
    function SettingsSection(props) {
      const { t, rpcCall, getService } = props;
      const [saved, setSaved] = useState(null);
      const [draft, setDraft] = useState(null);
      const [catalogue, setCatalogue] = useState({ providers: [], models: {}, catalogueErrors: {} });
      const [sessionId, setSessionId] = useState(null);
      const [selection, setSelection] = useState(null);
      const [error, setError] = useState('');
      const [message, setMessage] = useState('');
      const [busy, setBusy] = useState(false);
      const [checking, setChecking] = useState(false);
      const [check, setCheck] = useState(null);
      const [clearArmed, setClearArmed] = useState(false);
      const formRef = useRef(null);
      const lock = useRef(false);
      const dirty = Boolean(saved && JSON.stringify(saved) !== JSON.stringify(draft));

      function publish(next) {
        setEnabledGlobal(next.enabled !== false);
        store.updateSettings(next);
      }
      const load = useCallback(async () => {
        setError('');
        try {
          const id = getService?.('uiSession')?.adapter?.current?.getSnapshot?.()?.sessionId || null;
          const value = await rpcCall('settings.get', { sessionId: id });
          const restored = settingsDraft && JSON.stringify(settingsDraft.saved) === JSON.stringify(value.settings);
          setSessionId(id); setSaved(value.settings); setDraft(restored ? settingsDraft.draft : value.settings);
          setSelection(value.sessionSelection); setCatalogue(value); publish(value.settings);
        } catch (err) { setError(String(err.message || err)); }
      }, [rpcCall, getService]);
      useEffect(() => { load(); }, [load]);
      useEffect(() => {
        if (saved && draft) settingsDraft = dirty ? { saved, draft } : null;
      }, [saved, draft, dirty]);
      useEffect(() => {
        if (!dirty) return undefined;
        const warn = event => { event.preventDefault(); event.returnValue = ''; };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
      }, [dirty]);

      function edit(patch) {
        setDraft(prev => ({ ...prev, ...patch,
          target: { ...prev.target, ...patch.target },
          materials: { ...prev.materials, ...patch.materials },
          advanced: { ...prev.advanced, ...patch.advanced },
        }));
        setMessage(''); setCheck(null);
      }
      async function save(event) {
        event?.preventDefault();
        if (lock.current || !formRef.current?.reportValidity()) return;
        lock.current = true; setBusy(true); setError('');
        try {
          const value = await rpcCall('settings.patch', { patch: draft });
          setSaved(value.settings); setDraft(value.settings); publish(value.settings);
          setMessage(t('saved')); setCheck(null);
        } catch (err) { setError(`${t('saveFailed')}：${String(err.message || err)}`); }
        finally { lock.current = false; setBusy(false); }
      }
      // The master switch is immediate, even when unrelated fields are unsaved.
      async function toggleEnabled() {
        if (lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
          const value = await rpcCall('settings.patch', { patch: { enabled: !saved.enabled } });
          setSaved(value.settings); setDraft(prev => ({ ...prev, enabled: value.settings.enabled }));
          publish(value.settings); setMessage(value.settings.enabled ? t('enabledNow') : t('disabledNow'));
        } catch (err) { setError(String(err.message || err)); }
        finally { lock.current = false; setBusy(false); }
      }
      async function runCheck() {
        if (dirty || lock.current) return;
        lock.current = true; setChecking(true); setCheck(null);
        try { setCheck(await rpcCall('check.connection', { sessionId })); }
        catch (err) { setCheck({ ok: false, message: String(err.message || err) }); }
        finally { lock.current = false; setChecking(false); }
      }
      async function grant() {
        if (!sessionId || lock.current || dirty) return;
        lock.current = true; setBusy(true); setError('');
        try {
          const value = await rpcCall('settings.grant', { sessionId, granted: !saved.sessionGrants?.[sessionId] });
          setSaved(value.settings); setDraft(value.settings); publish(value.settings);
          setMessage(value.granted ? t('grantOn') : t('grantOff'));
        } catch (err) { setError(String(err.message || err)); }
        finally { lock.current = false; setBusy(false); }
      }
      async function clearHistory() {
        if (!sessionId || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
          await rpcCall('consult.clear', { sessionId });
          store.write(sessionId, { records: [], selectedId: null });
          setClearArmed(false); setMessage(t('clearDone'));
        } catch (err) { setError(String(err.message || err)); }
        finally { lock.current = false; setBusy(false); }
      }
      const button = (text, onClick, cls = '', disabled = false) => h('button', { type: 'button', className: `dsha-btn ${cls}`, onClick, disabled }, text);
      if (!draft) return h('div', { className: 'dsha-page' },
        h('h1', { className: 'dsha-h1' }, t('pageTitle')),
        h('p', { role: error ? 'alert' : 'status', className: 'dsha-note' }, error || t('loading')),
        error ? button(t('retry'), load) : null);
      const target = draft.target;
      const modelOptions = catalogue.models?.[target.provider] || [];
      const actual = target.mode === 'fixed' ? target : selection;
      const ready = Boolean(actual?.provider && actual?.model);
      const granted = Boolean(saved.sessionGrants?.[sessionId] && Date.now() - saved.sessionGrants[sessionId].at < 86400000);
      const choice = (name, value, current, title, hint, onChange) => h('label', {
        className: 'dsha-choice', 'data-selected': current === value, key: value,
      }, h('input', { type: 'radio', name, value, checked: current === value, onChange }),
      h('span', null, h('strong', null, title), h('span', { className: 'dsha-hint' }, hint)));
      const section = (step, title, hint, content) => h('section', { className: 'dsha-section' },
        h('div', { className: 'dsha-section-title' }, h('span', { className: 'dsha-step' }, step),
          h('div', null, h('h2', null, title), hint ? h('p', { className: 'dsha-hint' }, hint) : null)), content);
      return h('form', { className: 'dsha-page', ref: formRef, onSubmit: save },
        h('header', { className: 'dsha-page-head' }, h('div', null,
          h('span', { className: 'dsha-eyebrow' }, t('settingsEyebrow')),
          h('h1', { className: 'dsha-h1' }, t('pageTitle')), h('p', { className: 'dsha-hint' }, t('pageHint'))),
          h('button', { type: 'button', className: 'dsha-switch', role: 'switch', 'aria-checked': saved.enabled,
            'aria-label': t('enabledLabel'), disabled: busy || checking, onClick: toggleEnabled },
            h('span', { className: 'dsha-switch-track' }), saved.enabled ? t('enabled') : t('disabled'))),
        !saved.enabled ? h('p', { className: 'dsha-callout', role: 'status' }, t('disabledHint')) : null,
        h('fieldset', { className: 'dsha-fields', disabled: busy || checking },
          section('01', t('modelLabel'), t('modelSectionHint'), h('div', { className: 'dsha-block' },
            h('div', { className: 'dsha-choices two' },
              choice('dsha-target', 'session', target.mode, t('modelFollowSession'), t('modelFollowHint'), () => edit({ target: { mode: 'session' } })),
              choice('dsha-target', 'fixed', target.mode, t('modelFixed'), t('modelFixedHint'), () => edit({ target: { mode: 'fixed' } }))),
            target.mode === 'fixed' ? h('div', { className: 'dsha-grid two' },
              h('label', { className: 'dsha-field' }, t('modelProvider'), h('select', { className: 'dsha-select', 'aria-label': t('modelProvider'), required: true, value: target.provider || '',
                onChange: event => edit({ target: { provider: event.target.value, model: '' } }) },
                h('option', { value: '' }, t('selectProvider')),
                target.provider && !(catalogue.providers || []).some(p => p.id === target.provider) ? h('option', { value: target.provider }, target.provider) : null,
                (catalogue.providers || []).map(p => h('option', { key: p.id, value: p.id }, p.label || p.id)))),
              h('label', { className: 'dsha-field' }, t('modelName'), h('select', { className: 'dsha-select', 'aria-label': t('modelName'), required: true, disabled: !target.provider, value: target.model || '',
                onChange: event => edit({ target: { model: event.target.value } }) }, h('option', { value: '' }, t('selectModel')),
                target.model && !modelOptions.some(m => m.id === target.model) ? h('option', { value: target.model }, target.model) : null,
                modelOptions.map(m => h('option', { key: m.id, value: m.id }, m.label || m.id))))) : null,
            catalogue.catalogueErrors?.[target.provider] ? h('p', { className: 'dsha-note err', role: 'alert' }, catalogue.catalogueErrors[target.provider]) : null,
            h('div', { className: 'dsha-model-summary' }, h('span', { className: `dsha-dot ${ready ? 'ok' : 'warn'}` }),
              h('span', null, dirty ? t('afterSaving') : t('modelResolved')), h('strong', null, ready ? `${actual.provider} / ${actual.model}` : t('statusNeedsModel'))),
            h('div', { className: 'dsha-row' }, button(checking ? t('checking') : t('checkButton'), runCheck, 'ghost', dirty || !ready || checking),
              h('span', { className: 'dsha-note' }, dirty ? t('saveBeforeCheck') : t('checkHint'))),
            check ? h('p', { role: 'status', className: `dsha-note ${check.ok ? 'ok' : 'err'}` }, check.ok ? `${t('checkOk')} · ${check.elapsedMs} ms` : `${t('checkFail')} · ${check.message || check.code}`) : null)),
          section('02', t('modeLabel'), t('modeSectionHint'), h('div', { className: 'dsha-block' },
            h('div', { className: 'dsha-choices' },
              choice('dsha-mode', 'manual', draft.mode, t('modeManual'), t('modeManualHint'), () => edit({ mode: 'manual' })),
              choice('dsha-mode', 'confirm', draft.mode, t('modeConfirm'), t('modeConfirmHint'), () => edit({ mode: 'confirm' })),
              choice('dsha-mode', 'auto', draft.mode, t('modeAuto'), t('modeAutoHint'), () => edit({ mode: 'auto' }))),
            draft.mode === 'auto' ? h('p', { className: 'dsha-callout' }, t('autoScopeHint')) : null,
            h('div', { className: 'dsha-session-line' }, h('div', null, h('strong', null, t('grantLabel')),
              h('p', { className: 'dsha-note' }, sessionId ? t('grantHint') : t('openSessionHint'))),
              button(granted ? t('revokeButton') : t('grantButton'), grant, 'ghost', !sessionId || dirty || (!granted && draft.mode !== 'manual'))))),
          section('03', t('materialsLabel'), t('materialsHint'), h('div', { className: 'dsha-material-grid' },
            ['question', 'selection', 'plan', 'diff', 'test'].map(kind => h('label', { key: kind, className: 'dsha-material-choice' },
              h('input', { type: 'checkbox', checked: kind === 'question' || draft.materials[kind], disabled: kind === 'question',
                onChange: event => edit({ materials: { [kind]: event.target.checked } }) }),
              h('span', null, h('strong', null, materialName(t, kind)), h('span', { className: 'dsha-note' }, t(`materialHint_${kind}`))))))),
          section('04', t('deliveryLabel'), null, h('div', { className: 'dsha-choices two' },
            choice('dsha-delivery', 'show', draft.delivery, t('deliveryShow'), t('deliveryShowHint'), () => edit({ delivery: 'show' })),
            choice('dsha-delivery', 'return', draft.delivery, t('deliveryReturn'), t('deliveryReturnHint'), () => edit({ delivery: 'return' })))),
          h('details', { className: 'dsha-section dsha-details' }, h('summary', null, t('advancedLabel'), h('span', { className: 'dsha-note' }, t('advancedSummary'))),
            h('div', { className: 'dsha-grid two' },
              [['maxAdviceTokens', 'advancedTokens', 64, 32000], ['consultDeadlineMs', 'timeoutSeconds', 0, 600], ['maxConsultationsPerSession', 'advancedBudget', 0, 10000], ['historyLimit', 'advancedHistory', 5, 500]].map(([key, label, min, max]) =>
                h('label', { className: 'dsha-field', key }, t(label), h('input', { className: 'dsha-input', type: 'number', required: true, min, max, step: key === 'consultDeadlineMs' ? 0.001 : 1,
                  value: key === 'consultDeadlineMs' && draft.advanced[key] !== '' ? draft.advanced[key] / 1000 : draft.advanced[key],
                  onChange: event => edit({ advanced: { [key]: event.target.value === '' ? '' : Number(event.target.value) * (key === 'consultDeadlineMs' ? 1000 : 1) } }) })))),
            h('p', { className: 'dsha-note' }, t('budgetHelp'))),
          h('details', { className: 'dsha-section dsha-details', onKeyDown: event => { if (event.key === 'Escape') setClearArmed(false); } },
            h('summary', null, t('historyManagement'), h('span', { className: 'dsha-note' }, t('sessionOnly'))),
            h('p', { className: 'dsha-note' }, t('clearBudgetHint')),
            !clearArmed ? button(t('clearButton'), () => setClearArmed(true), 'ghost', !sessionId) : h('div', { className: 'dsha-callout' },
              h('p', null, t('clearWarn')), h('div', { className: 'dsha-row' }, button(t('clearCancel'), () => setClearArmed(false)), button(t('clearConfirm'), clearHistory, 'danger'))))),
        h('footer', { className: 'dsha-savebar' },
          h('div', { className: 'dsha-save-state', role: error ? 'alert' : 'status', 'aria-live': 'polite' },
            error || (dirty ? t('unsaved') : message || t('settingsSaved'))),
          button(t('discard'), () => { setDraft(saved); setMessage(''); setError(''); }, 'ghost', !dirty || busy || checking),
          h('button', { type: 'submit', className: 'dsha-btn primary', disabled: !dirty || busy || checking }, busy ? t('saving') : t('saveSettings'))));
    }

    function ConsultEntry(props) {
      const { t, sessionId, openConsult, consultOpen } = props;
      return h(
        'button',
        {
          type: 'button',
          className: 'dsha-entry',
          'data-open': consultOpen ? 'true' : 'false',
          'aria-expanded': consultOpen,
          'data-advisor-entry': sessionId,
          onMouseDown: () => { props.selectionRef.current = window.getSelection()?.toString() || ''; },
          onClick: () => { openConsult(sessionId, props.selectionRef.current || window.getSelection()?.toString() || ''); props.selectionRef.current = ''; },
          title: t('consultTitle'),
        },
        t('consult'),
      );
    }

    // ------------------------------------------------------- confirmation strip

    const consultDrafts = new Map();
    function ConsultDock(props) {
      const { t, sessionId, rpcCall, consultOpen, closeConsult, draft, reload, initialSelection } = props;
      const view = useStore(sessionId);
      const keptDraft = consultDrafts.get(sessionId);
      const [question, setQuestion] = useState(keptDraft?.question || '');
      const [focus, setFocus] = useState(keptDraft?.focus || 'general');
      const [workLink, setWorkLink] = useState(keptDraft?.workLink || null);
      const [selectionText, setSelectionText] = useState(keptDraft?.selectionText || '');
      const [materials, setMaterials] = useState(keptDraft?.materials || { question: true, selection: true, plan: true, diff: true, test: true });
      useEffect(() => {
        if (question || selectionText) consultDrafts.set(sessionId, { question, focus, selectionText, materials, workLink });
        else consultDrafts.delete(sessionId);
      }, [sessionId, question, focus, selectionText, materials, workLink]);
      const [preview, setPreview] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const inputRef = useRef(null);
      const dockRef = useRef(null);
      const previewRef = useRef(null);
      const lock = useRef(false);
      const revision = useRef(0);
      const settingsKey = JSON.stringify(view.settings || {});
      const requestKey = JSON.stringify({ question, focus, selectionText, materials, settingsKey, workLink });
      useEffect(() => {
        revision.current += 1; setPreview(null);
      }, [requestKey, sessionId]);
      useEffect(() => {
        if (!consultOpen) return;
        if (view.retryRequest) {
          setQuestion(view.retryRequest.question || ''); setFocus(view.retryRequest.focus || 'general');
          setWorkLink(view.retryRequest.workItemId ? {workItemId:view.retryRequest.workItemId,workRevision:view.retryRequest.workRevision} : null);
          setSelectionText(view.retryRequest.selectionText || ''); setMaterials({ question: true, selection: true, plan: true, diff: true, test: true });
          store.write(sessionId, { retryRequest: null });
        } else setQuestion(current => current || String(draft || ''));
        setSelectionText(current => initialSelection || current || '');
        setError(''); inputRef.current?.focus();
      }, [consultOpen]);
      useEffect(() => {
        if (!consultOpen) return;
        (preview ? previewRef.current : inputRef.current)?.focus({ preventScroll: true });
        if (dockRef.current) dockRef.current.scrollTop = 0;
      }, [Boolean(preview), consultOpen]);
      const request = () => ({ question: question.trim(), focus, materials, ...workLink,
        selection: selectionText.trim() ? { text: selectionText.trim() } : null });
      async function prepare() {
        if (lock.current || !question.trim()) return;
        lock.current = true; setBusy(true); setError('');
        const version = revision.current;
        try {
          const value = await rpcCall('materials.preview', { sessionId, request: request() });
          if (version !== revision.current) return;
          if (value?.ok) setPreview(value);
          else setError(value?.reason || t('loadFailed'));
        } catch (err) { if (version === revision.current) setError(String(err.message || err)); }
        finally { lock.current = false; setBusy(false); }
      }
      async function start() {
        if (lock.current || !preview?.ok || !preview.target?.provider || !preview.target?.model) return;
        lock.current = true; setBusy(true); setError('');
        try {
          const value = await rpcCall('consult.start', { sessionId, request: { ...request(), expectedDigest: preview.digest, expectedTarget: preview.target } });
          if (value?.record) store.write(sessionId, { selectedId: value.record.id });
          if (value?.accepted) {
            setDockView(sessionId, 'card'); closeConsult(); setQuestion(''); setSelectionText(''); setPreview(null); setFocus('general'); setWorkLink(null);
            setMaterials({ question: true, selection: true, plan: true, diff: true, test: true });
            if (reload) await reload();
          } else {
            setError(value?.record?.error?.message || t('stateRefused')); setPreview(null);
          }
        } catch (err) { setError(String(err.message || err)); }
        finally { lock.current = false; setBusy(false); }
      }
      if (!consultOpen) return null;
      const scope = view.settings?.materials || {};
      const ready = Boolean(preview?.target?.provider && preview?.target?.model);
      return h('section', { className: 'dsha-dock', ref: dockRef, 'aria-label': t('consultTitle'),
        onKeyDown: event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); closeConsult(); } } },
        h('header', { className: 'dsha-dock-head' }, h('div', null,
          h('span', { className: 'dsha-eyebrow' }, t('secondOpinion')),
          h('h2', null, t('consultTitle'))),
          h('button', { className: 'dsha-icon-btn', type: 'button', onClick: closeConsult, disabled: busy, 'aria-label': t('close') }, '×')),
        h('ol', { className: 'dsha-progress', 'aria-label': t('consultSteps') },
          h('li', { 'aria-current': !preview ? 'step' : undefined }, h('span', null, '1'), t('writeQuestion')),
          h('li', { 'aria-current': preview ? 'step' : undefined }, h('span', null, '2'), t('reviewAndSend'))),
        workLink ? h('p', {className:'dsha-callout'}, t('workRecheckHint')) : null,
        !preview ? h('fieldset', { className: 'dsha-fields', disabled: busy },
          !workLink ? h('details', {className:'dsha-details'}, h('summary',null,t('workPresets')),
            h('p',{className:'dsha-note'},t('workPresetsHint')),
            h('div',{className:'dsha-row'}, ['plan','diff','test','acceptance','research','document'].map(kind => h('button', {key:kind,type:'button',className:'dsha-btn',onClick:()=>{setQuestion(t(`presetQuestion_${kind}`));setFocus(['plan','diff','test'].includes(kind)?kind:'general');}}, t(`preset_${kind}`))))) : null,
          h('div', { className: 'dsha-tabs', role: 'group', 'aria-label': t('focusLabel') },
            ['general', 'plan', 'diff', 'test'].map(value => h('button', { key: value, type: 'button', 'aria-pressed': focus === value,
              onClick: () => setFocus(value) }, t(`focus_${value}`)))),
          ['plan','diff','test'].includes(focus) && !scope[focus] ? h('p',{className:'dsha-callout'},t('workScopeMissing')) : null,
          h('label', { className: 'dsha-field' }, t('consultQuestion'),
            h('textarea', { ref: inputRef, 'aria-label': t('consultQuestion'), className: 'dsha-textarea', value: question, rows: 3, maxLength: 4000,
              placeholder: t(`placeholder_${focus}`), onChange: event => setQuestion(event.target.value) })),
          h('div', { className: 'dsha-scope-head' }, h('strong', null, t('thisTimeMaterials')), h('span', { className: 'dsha-note' }, t('thisTimeOnly'))),
          h('div', { className: 'dsha-scope' }, ['question', 'selection', 'plan', 'diff', 'test'].map(kind => h('label', {
            className: 'dsha-scope-option', key: kind, title: !scope[kind] && kind !== 'question' ? t('disabledInSettings') : '',
          }, h('input', { type: 'checkbox', checked: kind === 'question' || Boolean(scope[kind] && materials[kind]),
            disabled: kind === 'question' || !scope[kind], onChange: event => setMaterials(prev => ({ ...prev, [kind]: event.target.checked })) }), materialName(t, kind)))),
          scope.selection && materials.selection ? h('label', { className: 'dsha-field' }, t('pasteSelection'),
            h('textarea', { className: 'dsha-textarea compact', 'aria-label': t('pasteSelection'), value: selectionText, maxLength: 6000, rows: 2,
              placeholder: t('pasteHint'), onChange: event => setSelectionText(event.target.value) })) : null) : null,
        preview ? h('div', { className: 'dsha-preview', 'data-testid': 'preview', ref: previewRef, tabIndex: -1, role: 'region', 'aria-label': t('exactMaterial') },
          h('strong', { className: 'dsha-preview-question' }, question),
          !ready ? h('p', { className: 'dsha-callout', role: 'status' }, t('modelMissing')) : null,
          h('div', { className: 'dsha-model-summary' }, h('span', { className: `dsha-dot ${ready ? 'ok' : 'warn'}` }),
            h('strong', null, ready ? `${preview.target.provider} / ${preview.target.model}` : t('statusNeedsModel')),
            h('span', { className: 'dsha-note' }, `${preview.chars} ${t('chars')}`)),
          h('div', { className: 'dsha-material-status' }, (preview.materials || []).map(m => h('p', { key: m.kind, className: `dsha-note ${m.absent || m.truncated || m.fromEarlierTurn ? 'warn' : ''}` },
            `${materialName(t, m.kind)} · ${m.absent ? t('absentMaterial') : `${m.chars} ${t('chars')}`}${m.truncated ? ` ${t('truncatedMaterial')}` : ''}${m.fromEarlierTurn ? ` ${t('earlierTurnMaterial')}` : ''}`))),
          h('details', { open: true, className: 'dsha-details' }, h('summary', null, t('exactMaterial')), h('pre', { className: 'dsha-pre' }, preview.text)),
          h('p', { className: 'dsha-note' }, view.settings?.delivery === 'return' ? t('deliveryReturnHint') : t('deliveryShowHint'))) : null,
        error ? h('p', { role: 'alert', className: 'dsha-callout err' }, error) : null,
        h('footer', { className: 'dsha-dock-footer' }, h('span', { className: 'dsha-note', role: 'status' }, busy ? t('starting') : preview ? t('sendCostHint') : t('previewFreeHint')),
          h('div', { className: 'dsha-row' }, preview ? h('button', { type: 'button', className: 'dsha-btn ghost', disabled: busy, onClick: () => setPreview(null) }, t('editRequest')) : null,
            h('button', { type: 'button', className: 'dsha-btn primary', disabled: busy || !question.trim() || (Boolean(preview) && !ready),
              onClick: preview ? start : prepare }, busy ? t('working') : preview ? t('confirmAndSend') : t('previewNext')))));
    }

    function AdviceBody(props) {
      const { t, record, expanded, onToggle } = props;
      const text = record.actions?.length ? String(record.advice || '').replace(/```advisor-actions\s*\n[\s\S]*?\n```/, '').trim() : String(record.advice || '');
      if (text === '') return null;
      const head = expanded ? text : previewOf(text, 4, 380);
      const canCollapse = text.length > 380 || text.split('\n').filter(line => line.trim()).length > 4;
      return h(
        'div',
        { className: 'dsha-block', style: { gap: '4px' } },
        h('p', { className: 'dsha-advice' }, head),
        canCollapse
          ? h(
              'button',
              { className: 'dsha-btn tiny ghost', type: 'button', onClick: onToggle },
              expanded ? t('cardCollapse') : t('cardFull'),
            )
          : null,
      );
    }

    const reviewDrafts = new Map();
    function ConsultCardBody(props) {
      const { t, record, rpcCall, sessionId, reload, onRetry } = props;
      const [expanded, setExpanded] = useState(true);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');
      const draftKey = JSON.stringify([sessionId, record.id]);
      const cached = reviewDrafts.get(draftKey);
      const reviewFormRef = useRef(null);
      const [editing, setEditing] = useState(Boolean(cached));
      const [verdict, setVerdict] = useState(cached?.verdict ?? record.verification ?? 'pending');
      const [disposition, setDisposition] = useState(cached?.disposition ?? record.disposition ?? 'none');
      const [note, setNote] = useState(cached?.note ?? record.verdictNote ?? '');
      useEffect(() => {
        if (editing) reviewDrafts.set(draftKey, { verdict, disposition, note });
      }, [draftKey, editing, verdict, disposition, note]);
      const lock = useRef(false);
      useEffect(() => {
        if (editing) {
          reviewFormRef.current?.scrollIntoView({ block: 'nearest' });
          reviewFormRef.current?.querySelector('select')?.focus({ preventScroll: true });
        }
      }, [editing]);
      const active = isPending(record);
      const now = useNow(active);
      async function perform(action) {
        if (lock.current) return;
        lock.current = true; setBusy(true); setError(''); setMessage('');
        try { await action(); if (reload) await reload(); }
        catch (err) { setError(String(err.message || err)); }
        finally { lock.current = false; setBusy(false); }
      }
      function makeWork(candidate) {
        store.write(sessionId, { selectedWorkId: null, workDraft: { requestId: uuid(), consultationId: record.id,
          title: candidate?.title || record.question.slice(0,160), action: candidate?.action || '',
          acceptance: candidate?.acceptance || '', priority: candidate?.priority || 'normal' } });
        setDockView(sessionId, 'work');
      }
      function saveVerdict(event) {
        event.preventDefault();
        if (verdict !== 'pending' && !note.trim()) { setError(t('verifyNeedsNote')); return; }
        perform(async () => {
          const value = await rpcCall('consult.annotate', { sessionId, consultationId: record.id,
            patch: { verification: verdict, disposition, verdictNote: note.trim() } });
          if (!value?.record) throw new Error(t('recordMissing'));
          reviewDrafts.delete(draftKey); setEditing(false); setMessage(t('verdictSaved'));
        });
      }
      const button = (label, onClick, cls = '', disabled = false) => h('button', { type: 'button', className: `dsha-btn ${cls}`, onClick, disabled: busy || disabled }, label);
      const caveat = stateCaveat(t, record);
      const elapsed = active && record.createdAt ? Math.max(0, Math.floor((now - Date.parse(record.createdAt)) / 1000)) : 0;
      return h('article', { className: 'dsha-consult' },
        h('header', { className: 'dsha-consult-head' },
          h('div', { className: 'dsha-factline' }, h('span', { className: 'dsha-status', role: 'status' },
            h('span', { className: `dsha-dot ${stateTone(record.state)}` }), stateLabel(t, record.state)),
            h('time', { className: 'dsha-when', dateTime: record.createdAt || undefined }, fmtDateTime(record.createdAt)),
            active ? h('span', { className: 'dsha-note' }, t('waited').replace('%s', elapsed)) : null),
          h('h3', { className: 'dsha-question-title' }, record.question || t('cardTitle')),
          h('p', { className: 'dsha-prov' }, `${record.target?.provider || '—'} / ${record.target?.model || '—'}`)),
        record.workItemId ? button(t('workLinked'), () => {store.write(sessionId,{selectedWorkId:record.workItemId});setDockView(sessionId,'work');}) : null,
        record.staleness?.verdict === 'changed' ? h('p', { className: 'dsha-callout warn' }, t('staleNote'),
          record.staleness.changedPaths?.length ? h('span', { className: 'dsha-note' }, record.staleness.changedPaths.join(' · ')) : null) : null,
        active ? h('div', { className: 'dsha-running', role: 'status' }, h('span', { className: 'dsha-spinner', 'aria-hidden': true }),
          h('div', null, h('strong', null, t('waitingTitle')), h('p', { className: 'dsha-note' }, t('waitingHint')))) : null,
        h(AdviceBody, { t, record, expanded, onToggle: () => setExpanded(value => !value) }),
        !active && record.actions?.length ? h('section', { className: 'dsha-action-candidates' },
          h('h4', null, t('workCandidates')), h('p', { className: 'dsha-note' }, t('workCandidatesHint')),
          record.actions.map((candidate, index) => h('div', { className: 'dsha-candidate', key: index },
            h('strong', null, candidate.title), h('p', { className: 'dsha-note' }, candidate.evidence),
            h('p', null, candidate.action), h('p', { className: 'dsha-note' }, `${t('workAcceptance')}：${candidate.acceptance}`),
            button(t('workConvert'), () => makeWork(candidate))))) : null,
        caveat ? h('p', { className: 'dsha-callout' }, caveat) : null,
        record.error?.message ? h('p', { className: 'dsha-callout err', role: 'alert' }, record.error.message) : null,
        record.materials?.kinds?.length ? h('details', { className: 'dsha-details dsha-record-materials' },
          h('summary', null, t('materialUsed'), h('span', { className: 'dsha-note' }, `${record.materials.chars || 0} ${t('chars')}`)),
          h('p', { className: 'dsha-note' }, record.materials.kinds.map(kind => materialName(t, kind)).join(' · ')),
          record.materials.truncated?.length ? h('p', { className: 'dsha-note warn' }, t('truncatedMaterial'), ' ', record.materials.truncated.map(k => materialName(t, k)).join(' · ')) : null,
          record.materials.fromEarlierTurn?.length ? h('p', { className: 'dsha-note warn' }, t('earlierTurnMaterial'), ' ', record.materials.fromEarlierTurn.map(k => materialName(t, k)).join(' · ')) : null) : null,
        !active && record.advice ? h('div', { className: 'dsha-outcome-grid' },
          [[t('verifyLabel'), verifyText(t, record.verification)], [t('dispositionLabel'), dispositionText(t, record.disposition)], [t('deliveryFact'), record.deliveredToModel ? t('deliveredLabel') : t('notDelivered')]].map(([label, value]) =>
            h('div', { key: label }, h('span', { className: 'dsha-note' }, label), h('strong', null, value)))) : null,
        record.verdictNote && !editing ? h('blockquote', { className: 'dsha-quote' }, record.verdictNote) : null,
        h('div', { className: 'dsha-row dsha-card-actions' },
          active ? button(t('cancelConsult'), () => perform(async () => {
            const value = await rpcCall('consult.cancel', { sessionId, consultationId: record.id });
            if (!value?.ok) throw new Error(t('noLongerRunning'));
            setMessage(t('cancelledNote'));
          })) : null,
          !active && record.advice ? button(record.deliveredToModel ? t('actionVerifySent') : t('actionVerify'), () => perform(async () => {
            const value = await rpcCall('consult.deliver', { sessionId, consultationId: record.id });
            if (!value?.ok) throw new Error(value?.message || value?.reason || t('deliveryFailed'));
            setMessage(t('deliveredLabel'));
          }), 'primary', record.deliveredToModel) : null,
          !active && record.advice ? button(t('workConvert'), () => makeWork(null), 'ghost') : null,
          !active && record.advice ? button(t('recordVerdict'), () => {
            const kept = reviewDrafts.get(draftKey);
            setVerdict(kept?.verdict ?? record.verification ?? 'pending');
            setDisposition(kept?.disposition ?? record.disposition ?? 'none');
            setNote(kept?.note ?? record.verdictNote ?? '');
            setEditing(value => !value); setError('');
          }, 'ghost') : null,
          !active && onRetry ? button(t('askAgain'), () => onRetry(record), 'ghost') : null,
          record.advice ? button(t('copyOpinion'), () => perform(async () => { await navigator.clipboard.writeText(record.advice); setMessage(t('copied')); }), 'ghost') : null),
        editing ? h('form', { className: 'dsha-verdict-form', ref: reviewFormRef, onSubmit: saveVerdict },
          h('h4', null, t('recordVerdict')), h('p', { className: 'dsha-note' }, t('manualVerdictHint')),
          h('fieldset', { className: 'dsha-fields', disabled: busy }, h('div', { className: 'dsha-grid two' },
            h('label', { className: 'dsha-field' }, t('verifyLabel'), h('select', { className: 'dsha-select', 'aria-label': t('verifyLabel'), value: verdict, onChange: event => setVerdict(event.target.value) },
              ['pending', 'confirmed', 'rejected', 'inconclusive'].map(v => h('option', { key: v, value: v }, verifyText(t, v))))),
            h('label', { className: 'dsha-field' }, t('dispositionLabel'), h('select', { className: 'dsha-select', 'aria-label': t('dispositionLabel'), value: disposition, onChange: event => setDisposition(event.target.value) },
              ['none', 'accepted', 'fixed', 'deferred'].map(v => h('option', { key: v, value: v }, dispositionText(t, v)))))),
            h('label', { className: 'dsha-field' }, t('verdictReason'), h('textarea', { className: 'dsha-textarea', 'aria-label': t('verdictReason'), rows: 3, value: note,
              required: verdict !== 'pending', maxLength: 4000, placeholder: t('verdictPlaceholder'), onChange: event => setNote(event.target.value) }))),
          h('div', { className: 'dsha-row' }, h('button', { type: 'submit', className: 'dsha-btn primary', disabled: busy }, t('saveVerdict')),
            button(t('cancel'), () => { reviewDrafts.delete(draftKey); setEditing(false); }, 'ghost'))) : null,
        message ? h('p', { className: 'dsha-note ok', role: 'status' }, message) : null,
        error ? h('p', { className: 'dsha-note err', role: 'alert' }, error) : null);
    }

    function verifyText(t, value) {
      if (value === 'confirmed') return t('verifyConfirmed');
      if (value === 'rejected') return t('verifyRejected');
      if (value === 'inconclusive') return t('verifyInconclusive');
      return t('verifyPending');
    }

    function dispositionText(t, value) {
      if (value === 'accepted') return t('dispositionAccepted');
      if (value === 'fixed') return t('dispositionFixed');
      if (value === 'deferred') return t('dispositionDeferred');
      return t('dispositionNone');
    }

    /**
     * The material kinds are stored as ids (they are what the settings file holds
     * and what the conversation compares by); a person reading the card needs the
     * same words the settings page uses, not the ids.
     */
    function materialName(t, kind) {
      if (kind === 'question') return t('materialQuestion');
      if (kind === 'selection') return t('materialSelection');
      if (kind === 'plan') return t('materialPlan');
      if (kind === 'diff') return t('materialDiff');
      if (kind === 'test') return t('materialTest');
      return String(kind || '');
    }

    // ------------------------------------------------------------ advisor panel

    /**
     * The opinion panel. It is anchored under the header pill rather than in the
     * composer area on purpose: everything rendered below the composer lands in
     * the ambient statistics row, where a card either pushes the conversation off
     * screen or reads as a footnote fragment. The header has real width and its
     * ancestors do not scroll, so a panel can hang there without moving anything.
     */
    const discussionDrafts = new Map();
    function DiscussionPanel({item,sessionId,t,rpcCall,bridge}) {
      const draftKey=`${sessionId}:${item.id}`,saved=discussionDrafts.get(draftKey);
      const [maxRounds,setMaxRounds]=useState(3),[preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
      const [asking,setAsking]=useState(false);
      const [phase,setPhase]=useState(saved?.phase || 'clarify'),[message,setMessage]=useState(saved?.message || ''),[evidence,setEvidence]=useState(saved?.evidence || ''),[open,setOpen]=useState(Boolean(saved?.message));
      useEffect(()=>{discussionDrafts.set(draftKey,{phase,message,evidence});},[draftKey,phase,message,evidence]);
      const lock=useRef(false),policy=item.discussion,rounds=policy?.rounds || [],thinking=asking||rounds.some(r=>r.state==='running');
      useEffect(()=>setPreview(null),[item.revision]);
      async function act(fn) {if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await fn();}catch(err){setError(String(err.message||err));}finally{await bridge.reloadRecords(sessionId);lock.current=false;setBusy(false);}}
      async function ask(kind,text) {if(lock.current)return;setAsking(true);try{await act(async()=>{const result=await rpcCall('discussion.ask',{sessionId,workItemId:item.id,input:{requestId:uuid(),phase:kind,message:text,evidence}});if(!result.ok)setError(result.message);else {setOpen(false);setMessage('');setEvidence('');}});}finally{setAsking(false);}}
      const paused=!policy?.enabled,owner=thinking?'dialogOwnerAdvisor':['assigned','working','sending'].includes(item.status)?'dialogOwnerWorker':'dialogOwnerUser';
      const disabled=busy||thinking||paused||policy.used>=policy.maxRounds||['verified','deferred','rejected','uncertain','sending'].includes(item.status);
      return h('section',{className:'dsha-discussion'},
        h('div',{className:'dsha-history-top'},h('h3',null,t('dialogTitle')),h('strong',{className:'dsha-note',role:'status'},t(owner))),
        h('p',{className:'dsha-note'},t('dialogHint')),
        policy ? h('p',{className:'dsha-note'},`${policy.target.provider} / ${policy.target.model} · ${t('dialogBudget',`${policy.used}/${policy.maxRounds}`)}${paused?' · '+t('dialogPaused'):''}`) : null,
        h('div',{className:'dsha-row'},
          h('button',{type:'button',className:'dsha-btn primary',disabled,onClick:()=>ask('plan',t('dialogDefaultPlan'))},t('dialogPlan')),
          h('button',{type:'button',className:'dsha-btn',disabled,onClick:()=>setOpen(v=>!v)},t('dialogAsk')),
          policy?.enabled ? h('button',{type:'button',className:'dsha-btn ghost',onClick:async()=>{try{await rpcCall('discussion.pause',{sessionId,workItemId:item.id});await bridge.reloadRecords(sessionId);}catch(err){setError(String(err.message||err));}}},t('dialogPause')) : null),
        h('details',{className:'dsha-details',open:!policy?true:undefined},h('summary',null,t('dialogSetup')),
          h('p',{className:'dsha-note'},t('dialogPauseHint')),
          h('label',{className:'dsha-field'},t('dialogRounds'),h('select',{className:'dsha-select','aria-label':t('dialogRounds'),value:maxRounds,disabled:busy||thinking,onChange:e=>{setMaxRounds(Number(e.target.value));setPreview(null);}},[1,2,3,4,5].map(n=>h('option',{key:n,value:n},n)))),
          h('button',{type:'button',className:'dsha-btn',disabled:busy||thinking,onClick:()=>act(async()=>setPreview(await rpcCall('discussion.preview',{sessionId,workItemId:item.id,maxRounds})))},t('dialogPreview')),
          preview ? h('div',{className:'dsha-block'},h('pre',{className:'dsha-pre'},preview.text),h('button',{type:'button',className:'dsha-btn primary',disabled:busy,onClick:()=>act(async()=>{await rpcCall('discussion.enable',{sessionId,workItemId:item.id,maxRounds:preview.maxRounds,expectedRevision:preview.revision,expectedDigest:preview.digest});setPreview(null);})},t('dialogEnable'))) : null),
        open ? h('form',{className:'dsha-fields',onSubmit:e=>{e.preventDefault();ask(phase,message);}},
          h('label',{className:'dsha-field'},t('dialogPhase'),h('select',{className:'dsha-select','aria-label':t('dialogPhase'),value:phase,onChange:e=>setPhase(e.target.value)},['plan','clarify','review'].map(p=>h('option',{key:p,value:p},t(`dialogPhase_${p}`))))),
          h('label',{className:'dsha-field'},t('dialogMessage'),h('textarea',{className:'dsha-textarea','aria-label':t('dialogMessage'),value:message,required:true,maxLength:1800,onChange:e=>setMessage(e.target.value)})),
          h('label',{className:'dsha-field'},t('dialogEvidence'),h('textarea',{className:'dsha-textarea','aria-label':t('dialogEvidence'),value:evidence,maxLength:2500,onChange:e=>setEvidence(e.target.value)})),
          h('button',{type:'submit',className:'dsha-btn primary',disabled},t('dialogSend'))) : null,
        error ? h('p',{className:'dsha-callout err',role:'alert'},error) : null,
        rounds.length ? h('div',{className:'dsha-dialogue-list'},rounds.slice().reverse().map((round,index)=>h('article',{key:round.id,className:'dsha-dialogue-round'},
          h('div',{className:'dsha-history-top'},h('strong',null,`${t(`dialogPhase_${round.phase}`)} · ${t(`dialogState_${round.outdated?'stale':round.state}`)}`),h('time',{className:'dsha-note'},fmtDateTime(round.at))),
          h('p',{className:'dsha-note'},`${t('dialogExecutor')}：${round.message}`),
          round.review && round.state==='returned' && !round.outdated ? h(React.Fragment,null,
            h('strong',null,t(`dialogVerdict_${round.review.verdict}`)),
            h('p',null,`${t('dialogImpact')}：${round.review.summary}`),
            h('div',{className:'dsha-score-grid'},round.review.scores.map(score=>h('div',{key:score.dimension,className:'dsha-score'},h('span',null,t(`dialogDimension_${score.dimension}`)),h('strong',null,score.score===null?'—':`${score.score}/5`),h('p',null,score.score===null?`${t('dialogUnknown')} · ${score.reason}`:score.reason)))),
            h('p',{className:'dsha-note'},t('dialogScoreHint')),h('div',{className:'dsha-callout'},h('strong',null,t('dialogNext')),h('p',null,round.review.nextPrompt)))
            : round.outdated?h('p',{className:'dsha-note'},t('dialogState_stale')):round.state==='returned'?h('p',{className:'dsha-note'},t('dialogNoScore')):null,
          round.error ? h('p',{className:'dsha-note'},round.error) : null,
          h('details',{className:'dsha-details'},h('summary',null,t('dialogTranscript')),
            h('p',{className:'dsha-advice'},round.evidence),h('strong',null,t('dialogAdvice')),h('p',{className:'dsha-advice'},round.advice || t(`dialogState_${round.outdated?'stale':round.state}`)),
            round.materialText?h('details',null,h('summary',null,t('dialogMaterial')),h('pre',{className:'dsha-pre'},round.materialText)):null)))) : null);
    }

    const workFormDrafts = new Map();
    function WorkBoard({ t, sessionId, rpcCall, bridge, onConsult, records }) {
      const view = useStore(sessionId);
      const items = view.workItems || [];
      const [form, setForm] = useState(view.workDraft || workFormDrafts.get(sessionId) || null);
      const [filter, setFilter] = useState('active');
      const [query, setQuery] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [message, setMessage] = useState('');
      const [approval, setApproval] = useState(null);
      const [reviewAction, setReviewAction] = useState('');
      const [reviewRevision, setReviewRevision] = useState(null);
      const [evidence, setEvidence] = useState('');
      const [acknowledged, setAcknowledged] = useState(false);
      const lock = useRef(false);
      const item = items.find(i => i.id === view.selectedWorkId);
      const terminal = ['verified', 'deferred', 'rejected'];
      useEffect(() => {
        if (view.workDraft) { setForm(view.workDraft); store.write(sessionId, { workDraft: null }); }
      }, [view.workDraft, sessionId]);
      useEffect(() => { if (form) workFormDrafts.set(sessionId, form); else workFormDrafts.delete(sessionId); }, [form, sessionId]);
      useEffect(() => { setApproval(null); setReviewAction(''); setEvidence(''); setError(''); }, [item?.id]);
      useEffect(() => { setApproval(null); }, [item?.revision]);
      const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
      const button = (label, onClick, cls = 'ghost', disabled = false) => h('button', { type: 'button', className: `dsha-btn ${cls}`, disabled: busy || disabled, onClick }, label);
      async function perform(action) {
        if (lock.current) return;
        lock.current = true; setBusy(true); setError(''); setMessage('');
        try { await action(); await bridge.reloadRecords(sessionId); }
        catch (err) { setError(String(err.message || err)); }
        finally { lock.current = false; setBusy(false); }
      }
      function newWork() { setForm({ requestId: uuid(), title: '', action: '', acceptance: '', priority: 'normal' }); setApproval(null); }
      const selectWork = id => { store.write(sessionId, { selectedWorkId: id }); setForm(null); };
      function save(event) {
        event.preventDefault();
        perform(async () => {
          const result = form.id
            ? await rpcCall('work.edit', { sessionId, workItemId: form.id, expectedRevision: form.revision, input: form })
            : await rpcCall('work.create', { sessionId, input: form });
          setForm(null); store.write(sessionId, { selectedWorkId: result.item.id });
          setMessage(t(result.item.status === 'ready' ? 'workSaved' : 'workExisting'));
        });
      }
      async function recheck() {
        const request = await rpcCall('work.recheck', { sessionId, workItemId: item.id });
        store.write(sessionId, { retryRequest: request }); setDockView(sessionId, null); onConsult(sessionId);
      }
      function renderReport(report, previous = false) {
        return h('section', { key: report.callId || report.at, className: 'dsha-work-section report' },
          h('strong', null, previous ? t('workOldReport') : t('workReport')),
          h('span', {className:'dsha-note'}, t(`report_${report.outcome}`)),
          h('time', {className:'dsha-note', dateTime:report.at}, `${t('workReportedAt')} · ${fmtDateTime(report.at)}`),
          h('p', null, report.summary), h('blockquote', {className:'dsha-quote'}, report.evidence),
          report.nextStep ? h('div',{className:'dsha-callout'},h('strong',null,t('workNextStep')),h('p',null,report.nextStep)) : null,
          report.checks?.length ? h('div',{className:'dsha-checks'},h('strong',null,t('workChecks')),
            report.checks.map((check,index)=>h('div',{key:index,className:`dsha-check ${check.status}`},
              h('span',{className:'dsha-check-status'},t(`check_${check.status}`)),h('strong',null,check.label),h('p',null,check.evidence)))) : null,
          report.checks?.some(check=>check.status!=='passed') ? h('p',{className:'dsha-callout warn'},t('workCheckWarning')) : null,
          h('p',{className:'dsha-note'},t('workReportHint')));
      }
      const feedback = h(React.Fragment, null,
        error ? h('p', { className: 'dsha-callout err', role: 'alert' }, error) : null,
        message ? h('p', { className: 'dsha-note ok', role: 'status' }, message) : null);
      if (form) return h('form', { className: 'dsha-work-form', onSubmit: save },
        h('h3', null, form.id ? t('workEdit') : t('workNew')),
        h('p', { className: 'dsha-note' }, form.consultationId ? t('workFromAdvice') : t('workCreateHint')),
        h('fieldset', { className: 'dsha-fields', disabled: busy },
          h('label', { className: 'dsha-field' }, t('workTitle'), h('input', { className: 'dsha-input', 'aria-label': t('workTitle'), value: form.title, required: true, maxLength: 160, onChange: e => update('title', e.target.value) })),
          h('label', { className: 'dsha-field' }, t('workAction'), h('textarea', { className: 'dsha-textarea', 'aria-label': t('workAction'), value: form.action, required: true, maxLength: 2000, rows: 3, placeholder: t('workActionHint'), onChange: e => update('action', e.target.value) })),
          h('label', { className: 'dsha-field' }, t('workAcceptance'), h('textarea', { className: 'dsha-textarea', 'aria-label': t('workAcceptance'), value: form.acceptance, required: true, maxLength: 2000, rows: 3, placeholder: t('workAcceptanceHint'), onChange: e => update('acceptance', e.target.value) })),
          h('label', { className: 'dsha-field' }, t('workPriority'), h('select', { className: 'dsha-select', 'aria-label': t('workPriority'), value: form.priority, onChange: e => update('priority', e.target.value) },
            ['high','normal','low'].map(p => h('option', { key: p, value: p }, t(`priority_${p}`)))))),
        feedback, h('div', { className: 'dsha-row' }, h('button', { type: 'submit', className: 'dsha-btn primary', disabled: busy }, t('workSave')),
          button(t('cancel'), () => setForm(null))));
      if (item) {
        const report = item.reports?.at(-1), review = item.reviews?.at(-1);
        return h('div', { className: 'dsha-work-detail' },
          h('div', { className: 'dsha-row' }, button(t('workBack'), () => selectWork(null)), h('span', { className: `dsha-work-state ${item.status}` }, t(`workState_${item.status}`))),
          h('h3', null, item.title), h('span', { className: 'dsha-note' }, t(`priority_${item.priority}`)),
          h('div', { className: 'dsha-work-section' }, h('strong', null, t('workAction')), h('p', null, item.action)),
          h('div', { className: 'dsha-work-section acceptance' }, h('strong', null, t('workAcceptance')), h('p', null, item.acceptance)),
          h(DiscussionPanel,{key:item.id,item,sessionId,t,rpcCall,bridge}),
          item.source ? h('details', { className: 'dsha-details' }, h('summary', null, t('workSource')),
            h('p', { className: 'dsha-note' }, item.source.truncated ? t('truncatedNote') : t('workSourceHint')),
            h('p', { className: 'dsha-advice' }, item.source.advice)) : null,
          ['sending','assigned'].includes(item.status) ? h('p', { className: 'dsha-callout' }, t('workAssignedHint')) : null,
          item.status === 'uncertain' ? h('p', { className: 'dsha-callout warn' }, t('workUncertainHint'), h('span', { className: 'dsha-note' }, item.dispatch?.error)) : null,
          !['sending','assigned','uncertain'].includes(item.status) ? h('p',{className:'dsha-callout'},t(`workNext_${item.nextAction || 'prepare'}`)) : null,
          report ? renderReport(report, !terminal.includes(item.status) && report.assignmentId !== item.dispatch?.id) : null,
          item.reports?.length > 1 ? h('details',{className:'dsha-details'},h('summary',null,t('workProgressHistory')),
            item.reports.slice(0,-1).reverse().map(r=>renderReport(r,r.assignmentId!==item.dispatch?.id))) : null,
          review ? h('section', { className: 'dsha-work-section' }, h('strong', null, t('workReviewLog')), h('p', null, review.evidence)) : null,
          item.rechecks?.length ? h('div', { className: 'dsha-block' }, h('strong', null, t('workRechecks')),
            item.rechecks.slice().reverse().map(r => {
              const record = records.find(c => c.id === r.consultationId);
              return record ? h(React.Fragment, { key: r.consultationId }, button(`${t('workRecheckResult')} · ${stateLabel(t, record.state)}`, () => { store.write(sessionId, { selectedId: record.id }); setDockView(sessionId, 'card'); }))
                : h('span', { className: 'dsha-note', key: r.consultationId }, t('workHistoryRemoved'));
            })) : null,
          h('div', { className: 'dsha-row' },
            item.status === 'ready' ? button(t('workHandoff'), () => perform(async () => {
              const result = await rpcCall('work.preview', { sessionId, workItemId: item.id, expectedRevision: item.revision }); setApproval(result);
            }), 'primary') : null,
            item.status === 'ready' ? button(t('workEdit'), () => setForm({ ...item })) : null,
            button(t('workRecheck'), () => perform(recheck), 'ghost', item.status === 'sending'),
            button(t('workReview'), () => { setReviewAction('verify'); setReviewRevision(item.revision); setEvidence(''); setAcknowledged(false); }, 'ghost', item.status === 'sending')),
          approval ? h('section', { className: 'dsha-work-approval' }, h('h4', null, t('workHandoffTitle')),
            h('p', { className: 'dsha-note' }, t('workHandoffHint')), h('pre', { className: 'dsha-pre' }, approval.text),
            h('div', { className: 'dsha-row' }, button(t('workConfirmHandoff'), () => perform(async () => {
              await rpcCall('work.dispatch', { sessionId, workItemId: item.id, expectedRevision: approval.revision, expectedDigest: approval.digest }); setApproval(null);
            }), 'primary'), button(t('cancel'), () => setApproval(null)))) : null,
          reviewAction ? h('form', { className: 'dsha-work-review', onSubmit: event => {
            event.preventDefault(); perform(async () => {
              await rpcCall('work.review', { sessionId, workItemId: item.id, expectedRevision: reviewRevision, action: reviewAction, evidence, acknowledgeDuplicateRisk: acknowledged });
              setReviewAction(''); setEvidence('');
            });
          } }, h('h4', null, t('workReview')), h('label', { className: 'dsha-field' }, t('workDecision'),
            h('select', { className: 'dsha-select', 'aria-label': t('workDecision'), value: reviewAction, disabled: busy, onChange: e => {setReviewAction(e.target.value);setAcknowledged(false);} },
              ['verify','reopen','defer','reject'].map(value => h('option', {key:value,value}, t(`workDecision_${value}`))))),
            h('label', { className: 'dsha-field' }, t('workEvidence'), h('textarea', { className: 'dsha-textarea', 'aria-label': t('workEvidence'), value: evidence, required: true, maxLength: 4000, rows: 3, disabled: busy, onChange: e => setEvidence(e.target.value) })),
            reviewAction === 'reopen' && ['assigned','working','uncertain'].includes(item.status) ? h('label', { className: 'dsha-scope-option' }, h('input', { type: 'checkbox', required: true, checked: acknowledged, onChange: e => setAcknowledged(e.target.checked) }), t('workRepeatAck')) : null,
            h('div', { className: 'dsha-row' }, h('button', {type:'submit',className:'dsha-btn primary',disabled:busy}, t('workSaveDecision')), button(t('cancel'), () => setReviewAction('')))) : null,
          feedback);
      }
      const filtered = items.filter(i => {
        const matches = {all:true, active:!terminal.includes(i.status), review:i.status==='reported', closed:terminal.includes(i.status),
          ready:i.status==='ready', running:['sending','assigned','working'].includes(i.status), attention:['blocked','uncertain'].includes(i.status)};
        const latest = i.reports?.at(-1);
        return matches[filter] && `${i.title} ${i.action} ${i.acceptance} ${latest?.summary || ''} ${latest?.nextStep || ''}`.toLowerCase().includes(query.toLowerCase());
      });
      return h('div', { className: 'dsha-work-board' },
        h('div', { className: 'dsha-work-intro' }, h('h3', null, t('workHeading')), h('p', {className:'dsha-note'}, t('workHint'))),
        h('div', { className: 'dsha-outcome-grid' }, [[t('workActive'), view.workCounts?.active || 0],[t('workAwaiting'), view.workCounts?.awaitingReview || 0],[t('workVerified'), view.workCounts?.verified || 0]].map(([label,value]) => h('div',{key:label},h('span',{className:'dsha-note'},label),h('strong',null,value)))),
        h('div', { className: 'dsha-row' }, button(t('workNew'),newWork,'primary'), button(t('workExport'), () => perform(async () => {const result=await rpcCall('work.export',{sessionId});await navigator.clipboard.writeText(result.markdown);setMessage(t('workExported'));}),'ghost',!items.length)),
        h('input', { type:'search',className:'dsha-input','aria-label':t('workSearch'),placeholder:t('workSearch'),value:query,onChange:e=>setQuery(e.target.value) }),
        h('div', { className: 'dsha-filters', role:'group','aria-label':t('workFilters') }, ['active','ready','running','attention','review','closed','all'].map(value => h('button',{key:value,type:'button','aria-pressed':filter===value,onClick:()=>setFilter(value)},t(`workFilter_${value}`)))),
        h('div', { className:'dsha-list' }, filtered.length ? filtered.map(i => h('button', {key:i.id,type:'button',className:'dsha-history-item dsha-work-item',onClick:()=>selectWork(i.id)},
          h('div',{className:'dsha-history-top'},h('strong',null,t(`workState_${i.status}`)),h('span',null,t(`priority_${i.priority}`))),h('span',{className:'dsha-history-question'},i.title),h('span',{className:'dsha-note'},t(`workNext_${i.nextAction || 'prepare'}`)),h('span',{className:'dsha-note'},(i.dispatch?.id && i.reports?.at(-1)?.assignmentId===i.dispatch.id ? i.reports.at(-1)?.nextStep : '') || i.acceptance)))
          : h('div', {className:'dsha-empty'},h('strong',null,t('workEmpty')),h('p',{className:'dsha-note'},t('workEmptyHint')))), feedback);
    }

    function AdvisorPanel(props) {
      const { t, sessionId, rpcCall, bridge, records, card, onConsult, triggerRef } = props;
      const dockView = useDockView(sessionId);
      const showHistory = dockView === 'history';
      const showWork = dockView === 'work';
      const view = useStore(sessionId);
      const [filter, setFilter] = useState('all');
      const [query, setQuery] = useState('');
      const panelRef = useRef(null);
      const close = () => { setDockView(sessionId, null); triggerRef.current?.focus(); };
      useEffect(() => {
        const before = document.activeElement;
        panelRef.current?.querySelector('button')?.focus();
        return () => { if (!document.activeElement || document.activeElement === document.body) before?.focus?.(); };
      }, []);
      useEffect(() => {
        const dismiss = event => {
          if (!panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setDockView(sessionId, null);
        };
        const escape = event => { if (event.key === 'Escape' && !event.defaultPrevented) close(); };
        document.addEventListener('pointerdown', dismiss);
        document.addEventListener('keydown', escape);
        return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
      }, [sessionId]);
      const filtered = records.filter(record => {
        const match = filter === 'all' || (filter === 'pending' && needsReview(record)) || (filter === 'running' && isPending(record)) ||
          (filter === 'issues' && ['failed', 'refused', 'timed_out', 'cancelled'].includes(record.state));
        return match && `${record.question || ''} ${record.advice || ''} ${record.target?.model || ''}`.toLowerCase().includes(query.toLowerCase());
      });
      function retry(record) {
        store.write(sessionId, { retryRequest: { question: record.question, focus: record.focus } });
        setDockView(sessionId, null); onConsult?.(sessionId);
      }
      return h('section', { className: 'dsha-panel', role: 'dialog', 'aria-label': t('advisorCenter'), ref: panelRef,
        onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } } },
        h('header', { className: 'dsha-panel-head' }, h('div', null, h('span', { className: 'dsha-eyebrow' }, t('sessionOnly')),
          h('h2', { className: 'dsha-panel-title' }, t('advisorCenter'))),
          h('div', { className: 'dsha-panel-actions' },
            h('button', { className: 'dsha-icon-btn', type: 'button', onClick: () => bridge.reloadRecords(sessionId), 'aria-label': t('refresh') }, '↻'),
            h('button', { className: 'dsha-icon-btn', type: 'button', onClick: close, 'aria-label': t('close') }, '×'))),
        h('nav', { className: 'dsha-tabs dsha-panel-tabs', 'aria-label': t('advisorViews') },
          h('button', { type: 'button', 'aria-pressed': showWork, onClick: () => setDockView(sessionId, 'work') }, `${t('workTab')} · ${view.workCounts?.active || 0}`),
          h('button', { type: 'button', 'aria-pressed': !showHistory && !showWork, onClick: () => setDockView(sessionId, 'card') }, t('cardTitle')),
          h('button', { type: 'button', 'aria-pressed': showHistory, onClick: () => setDockView(sessionId, 'history') }, `${t('historyOpen')} · ${records.length}`)),
        h('div', { className: 'dsha-panel-body' },
          view.error ? h('p', { className: 'dsha-callout err', role: 'alert' }, view.error) : null,
          showWork ? h(WorkBoard, { t, sessionId, rpcCall, bridge, onConsult, records }) : showHistory ? h(React.Fragment, null,
            h('label', { className: 'dsha-search' }, h('span', { className: 'dsha-sr-only' }, t('searchHistory')),
              h('input', { className: 'dsha-input', type: 'search', placeholder: t('searchHistory'), value: query, onChange: event => setQuery(event.target.value) })),
            h('div', { className: 'dsha-filters', role: 'group', 'aria-label': t('filterHistory') },
              ['all', 'pending', 'running', 'issues'].map(value => h('button', { type: 'button', key: value, 'aria-pressed': filter === value,
                onClick: () => setFilter(value) }, t(`filter_${value}`)))),
            h('div', { className: 'dsha-list' }, filtered.length ? filtered.map(record => h('button', {
              type: 'button', key: record.id, className: 'dsha-history-item', 'data-owed': needsReview(record),
              'aria-label': `${record.question || t('cardTitle')} · ${stateLabel(t, record.state)}`,
              onClick: () => { store.write(sessionId, { selectedId: record.id }); setDockView(sessionId, 'card'); },
            }, h('div', { className: 'dsha-history-top' }, h('span', { className: `dsha-dot ${stateTone(record.state)}` }),
              h('strong', null, needsReview(record) ? t('owedTag') : stateLabel(t, record.state)), h('time', { dateTime: record.createdAt || undefined }, fmtDateTime(record.createdAt))),
              h('span', { className: 'dsha-history-question' }, record.question || t('cardTitle')),
              h('span', { className: 'dsha-note' }, record.target?.model || '—'))) : h('div', { className: 'dsha-empty' },
                h('strong', null, records.length ? t('noResults') : t('historyEmpty')), h('p', { className: 'dsha-note' }, records.length ? t('changeFilter') : t('emptyHint')))))
          : card ? h(ConsultCardBody, { key: card.id, t, record: card, rpcCall, sessionId, reload: () => bridge.reloadRecords(sessionId), onRetry: retry })
          : h('div', { className: 'dsha-empty' }, h('span', { className: 'dsha-empty-symbol', 'aria-hidden': true }, '◇'),
            h('strong', null, t('historyEmpty')), h('p', { className: 'dsha-note' }, t('emptyHint')))),
        h('footer', { className: 'dsha-panel-footer' }, h('span', { className: 'dsha-note' }, t('opinionNotFact')),
          h('button', { className: 'dsha-btn primary', type: 'button', onClick: () => { setDockView(sessionId, null); onConsult?.(sessionId); } }, t('newConsult'))));
    }

    function HeaderStatus(props) {
      const { t, sessionId, bridge, rpcCall, onConsult } = props;
      const view = useStore(sessionId);
      const dockView = useDockView(sessionId);
      const open = dockView !== null;
      const triggerRef = useRef(null);
      useEffect(() => { bridge.load(sessionId); }, [bridge, sessionId]);
      const records = view.records || [];
      const running = records.filter(isPending);
      const pending = running[0];
      const unverified = records.filter(needsReview);
      const activeWork = view.workCounts?.active || 0;
      const awaitingWorkReport = (view.workItems || []).some(item => ['sending','assigned','working','uncertain','blocked'].includes(item.status) || item.discussion?.rounds?.some(r=>r.state==='running'));
      const now = useNow(Boolean(pending));
      useEffect(() => {
        if (!open && !running.length && !awaitingWorkReport) return undefined;
        const refresh = () => { if (document.visibilityState !== 'hidden') bridge.reloadRecords(sessionId); };
        const timer = setInterval(refresh, running.length ? 1000 : open ? 5000 : 10000);
        document.addEventListener('visibilitychange', refresh);
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
      }, [bridge, sessionId, running.length, open, awaitingWorkReport]);
      const card = records.find(record => record.id === view.selectedId) || pending || records[0] || null;
      let tone = 'quiet';
      let label = t('sectionLabel');
      if (pending) {
        tone = 'warn'; label = t('hdRunning').replace('%s', Math.max(0, Math.floor((now - Date.parse(pending.createdAt)) / 1000)));
      } else if (activeWork) { tone = 'brand'; label = t('workBadge').replace('%s', activeWork); }
      else if (unverified.length) { tone = 'brand'; label = t('hdVerdict').replace('%s', unverified.length); }
      else if (view.error) { tone = 'err'; label = t('loadFailed'); }
      return h('div', { className: 'dsha-hdwrap' },
        h('button', { type: 'button', className: `dsha-hd ${tone}`, ref: triggerRef, disabled: !view.loaded,
          'aria-label': label, 'aria-haspopup': 'dialog', 'aria-expanded': open,
          onClick: () => setDockView(sessionId, open ? null : activeWork ? 'work' : unverified.length ? 'history' : 'card') },
          h('span', { className: 'dsha-dot' }), h('span', null, label)),
        open ? h(AdvisorPanel, { key: sessionId, t, sessionId, rpcCall, bridge, records, card, onConsult, triggerRef }) : null);
    }

    function ToolCallCard(props) {
      const { t, phase, block, toolName } = props;
      const args = block && block.args ? block.args : null;
      const question = args && typeof args.question === 'string' ? args.question : '';

      if (phase === 'result' && block && block.result) {
        const value = block.result.value || block.result;
        const advice = value && typeof value.advice === 'string' ? value.advice : '';
        const outcome = value && value.outcome ? String(value.outcome) : '';
        const truncated = Boolean(value && value.truncated);
        const cancelled = Boolean(value && value.cancelled);
        const timedOut = Boolean(value && value.timedOut);
        const state = cancelled ? 'cancelled' : timedOut ? 'timed_out' : truncated ? 'truncated' : ['refused_no_consent', 'budget_exhausted'].includes(outcome) ? 'refused' : outcome === 'no_advice' ? 'no_advice' : outcome === 'advised' || outcome === 'ok' || (!outcome && advice) ? 'returned' : 'failed';
        return h(
          'div',
          { className: 'dsha-consult' },
          h(
            'div',
            { className: 'dsha-consult-head' },
            h(
              'span',
              { className: 'dsha-status' },
              h('span', { className: `dsha-dot ${stateTone(state)}` }),
              stateLabel(t, state),
            ),
            h('span', { className: 'dsha-meta' }, toolName || ''),
          ),
          question ? h('p', { className: 'dsha-note' }, question) : null,
          truncated ? h('p', { className: 'dsha-note warn' }, t('truncatedNote')) : null,
          advice ? h('p', { className: 'dsha-advice' }, advice) : null,
          !advice && outcome
            ? h('p', { className: 'dsha-note' }, `outcome: ${outcome}`)
            : null,
        );
      }

      return h(
        'div',
        { className: 'dsha-consult' },
        h(
          'div',
          { className: 'dsha-consult-head' },
          h(
            'span',
            { className: 'dsha-status' },
            h('span', { className: 'dsha-dot' }),
            phase === 'preparing' ? t('statePreparing') : t('stateRunning'),
          ),
        ),
        question ? h('p', { className: 'dsha-note' }, question) : null,
      );
    }

    // ------------------------------------------------------------------- module

    return {
      inject: ['slots', 'connection', 'locale'],

      apply(ctx) {
        const styleElement = ensureStyle();
        if (styleElement) {
          try {
            ctx.effect(() => () => styleElement.remove(), 'dsh-advisor.style');
          } catch {
            /* a detached style tag is harmless */
          }
        }

        let bound = null;
        try {
          bound = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : null;
        } catch {
          bound = null;
        }
        const fallback = ZH;
        const t = (key) => {
          const value = bound ? bound(key) : undefined;
          if (typeof value === 'string' && value.length > 0 && value !== key) return value;
          return fallback[key] ?? key;
        };

        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-advisor.locale');
          }
        } catch {
          /* the fallback dictionary already covers both languages we ship */
        }

        const bridge = createBridge(ctx);

        // The composer entry and the confirmation strip need to agree on whether
        // the strip is open, and they are separate slot cells; a context-level
        // signal keeps that decision in one place without a global.
        const openState = { bySession: new Map(), selections: new Map(), listeners: new Set() };
        function isOpenFor(sessionId) {
          return Boolean(openState.bySession.get(sessionId));
        }
        function setOpenFor(sessionId, value, selection = '') {
          if (value) { openState.selections.set(sessionId, selection); setDockView(sessionId, null); }
          if (value) openState.bySession.set(sessionId, true);
          else openState.bySession.delete(sessionId);
          for (const fn of Array.from(openState.listeners)) {
            try {
              fn();
            } catch {
              /* ignore */
            }
          }
        }
        function useOpen(sessionId) {
          const snapshot = useCallback(() => isOpenFor(sessionId), [sessionId]);
          return useSyncExternalStore(
            useCallback((fn) => {
              openState.listeners.add(fn);
              return () => openState.listeners.delete(fn);
            }, []),
            snapshot,
            snapshot,
          );
        }

        // One switch, read in one place: every session-scoped surface is hidden
        // together, so "off" cannot mean "half off" (entry gone, card still
        // polling) the way a per-component flag would drift.
        function useAdvisorEnabled(sessionId) {
          const view = useStore(sessionId);
          const global = useEnabledGlobal();
          useEffect(() => {
            bridge.load(sessionId);
          }, [sessionId]);
          if (global !== null) return global;
          if (!view.loaded) return true;
          return !(view.settings && view.settings.enabled === false);
        }

        function ConsultEntryBound(props) {
          const selectionRef = useRef('');
          const open = useOpen(props.sessionId);
          const enabled = useAdvisorEnabled(props.sessionId);
          if (!enabled) return null;
          return h(ConsultEntry, {
            ...props,
            t,
            consultOpen: open,
            selectionRef,
            openConsult: (sessionId, selection) => setOpenFor(sessionId, !open, selection),
          });
        }

        function ConsultDockBound(props) {
          const open = useOpen(props.sessionId);
          const enabled = useAdvisorEnabled(props.sessionId);
          const draft = typeof props.useInput === 'function' ? props.useInput(state => state.draft) : props.draft;
          if (!enabled) return null;
          return h(ConsultDock, {
            ...props,
            key: props.sessionId,
            draft,
            initialSelection: openState.selections.get(props.sessionId) || '',
            t,
            rpcCall: bridge.rpcCall,
            reload: () => bridge.reloadRecords(props.sessionId),
            consultOpen: open,
            closeConsult: () => {
              setOpenFor(props.sessionId, false);
              document.querySelectorAll('[data-advisor-entry]').forEach(el => {
                if (el.getAttribute('data-advisor-entry') === props.sessionId) el.focus();
              });
            },
          });
        }

        function HeaderStatusBound(props) {
          const enabled = useAdvisorEnabled(props.sessionId);
          if (!enabled) return null;
          return h(HeaderStatus, {
            ...props,
            t,
            bridge,
            rpcCall: bridge.rpcCall,
            onConsult: (sessionId) => setOpenFor(sessionId, true),
          });
        }

        function ToolCallCardBound(props) {
          return h(ToolCallCard, { ...props, t });
        }

        const getService = (name) => { try { return ctx.get(name); } catch { return null; } };
        function SettingsBound(props) {
          return h(SettingsSection, {
            ...props,
            t,
            rpcCall: bridge.rpcCall,
            getService,
          });
        }

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'advisor',
              order: 37,
              label: () => t('sectionLabel'),
              inject: () => ({}),
            },
            SettingsBound,
          ),
        );

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'advisor-consult',
              order: 10,
              label: () => t('consult'),
              inject: () => ({}),
            },
            ConsultEntryBound,
          ),
        );

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'advisor-confirm',
              order: 5,
              inject: () => ({}),
            },
            ConsultDockBound,
          ),
        );

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'advisor-status',
              order: 40,
              label: () => t('sectionLabel'),
              inject: () => ({}),
            },
            HeaderStatusBound,
          ),
        );

        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            {
              name: 'tool.call.toolview',
              key: 'advisor_consult',
              inject: () => ({}),
            },
            ToolCallCardBound,
          ),
        );
      },

      _internals: { CHANNEL, NS, ZH, EN },
    };
  },
});
