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
    const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React;

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
      sectionLabel: '顾问',
      pageTitle: '顾问',
      pageHint: '在你需要第二个视角时，把一个具体问题交给另一个模型看。它只在你发起时调用。',

      statusLabel: '插件状态',
      enabledLabel: '启用顾问',
      enabledHint: '关掉后输入区不再出现入口，也不再有任何模型调用；已存的咨询记录保留。',
      statusNeedsModel: '未配置',
      statusReady: '可使用',
      statusBroken: '配置异常',
      statusNoteNeeds: '还没有可用的顾问模型。选定一个模型后即可发起咨询。',
      statusNoteReady: '已配置。这只表示「可以用」，不表示正在调用。',
      statusNoteBroken: '设置无法读取或校验失败。',

      modeLabel: '使用方式',
      modeManual: '只在我要的时候咨询',
      modeManualHint: '会话里不会自己发起。这是默认。',
      modeConfirm: '主力建议后由我确认',
      modeConfirmHint: '主力认为需要第二个视角时会说明卡点，等你点确认。',
      modeAuto: '本会话内已授权，自动发起',
      modeAutoHint: '授权一次后，本会话内的建议直接执行，不再逐次询问。',
      grantLabel: '本会话授权',
      grantOn: '本会话已授权自动咨询',
      grantOff: '本会话未授权',
      grantButton: '授权本会话',
      revokeButton: '撤销本会话授权',
      grantHint: '授权只对当前会话有效，换会话需要重新授权。',

      modelLabel: '顾问模型',
      modelFollowSession: '跟随当前会话模型',
      modelFixed: '指定模型',
      modelProvider: 'Provider',
      modelName: 'Model',
      modelResolved: '实际将使用',
      modelMissing: '（无）',
      modelFollowHint: '当前会话没有默认模型时，咨询会直接说明原因，不会静默换成别的模型。',

      materialsLabel: '材料范围',
      materialsHint: '勾选的材料才会被组装并发送。发送前可以在确认区看全文。',
      materialQuestion: '本次问题',
      materialSelection: '选中内容',
      materialPlan: '当前方案',
      materialDiff: '当前改动',
      materialTest: '测试输出',

      deliveryLabel: '工作方式',
      deliveryShow: '只展示给我',
      deliveryShowHint: '意见停在卡片里，主力不会被打断。',
      deliveryReturn: '返回主力核验',
      deliveryReturnHint: '意见会作为一条消息交给主力，由它说明核验结果或为什么不采纳。',

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

      saved: '已保存',
      saveFailed: '保存失败',
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
      cancel: '取消',
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

      deliveryFact: '交付',
      verifyLabel: '核验状态',
      verifyPending: '尚未确认',
      verifyConfirmed: '主力确认了这条意见',
      verifyRejected: '主力核对后认为不成立',
      verifyInconclusive: '核验无定论',
      dispositionLabel: '处理状态',
      dispositionNone: '未处理',
      dispositionAccepted: '接受',
      dispositionFixed: '已修改',
      dispositionDeferred: '暂不处理',
      deliveredLabel: '已交给主力',
      notDelivered: '未交给主力',

      actionVerify: '让主力核验',
      actionVerifySent: '已交给主力',
      actionMore: '补充材料再问',
      actionDefer: '暂不处理',
      actionRaw: '查看原始意见',
      actionAccept: '标记为已处理',
      actionReject: '主力认为不成立',
      actionInconclusive: '无定论',
      verifyNeedsNote: '请在输入框里写明理由，然后再标记。',
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
    };

    const EN = {
      sectionLabel: 'Advisor',
      pageTitle: 'Advisor',
      pageHint: 'Hand one specific question to another model when you want a second pair of eyes. It is called only when you start it.',

      statusLabel: 'Status',
      enabledLabel: 'Enable the advisor',
      enabledHint: 'When off, the composer entry disappears and no model is ever called. Consultation history is kept.',
      statusNeedsModel: 'Not configured',
      statusReady: 'Ready',
      statusBroken: 'Misconfigured',
      statusNoteNeeds: 'No advisor model is available yet. Pick one to enable consultations.',
      statusNoteReady: 'Configured. This means it can be used, not that it is being called.',
      statusNoteBroken: 'Settings could not be read or validated.',

      modeLabel: 'How it is used',
      modeManual: 'Only when I ask',
      modeManualHint: 'Nothing starts on its own. This is the default.',
      modeConfirm: 'The model suggests, I confirm',
      modeConfirmHint: 'When the working model wants a second opinion it states the blocker and waits for you.',
      modeAuto: 'Authorised in this session, starts automatically',
      modeAutoHint: 'After one grant, suggestions in this session run without another prompt.',
      grantLabel: 'Session grant',
      grantOn: 'This session may consult automatically',
      grantOff: 'This session is not granted',
      grantButton: 'Grant this session',
      revokeButton: 'Revoke session grant',
      grantHint: 'A grant applies to the current session only.',

      modelLabel: 'Advisor model',
      modelFollowSession: 'Follow the current session model',
      modelFixed: 'Use a specific model',
      modelProvider: 'Provider',
      modelName: 'Model',
      modelResolved: 'Actually used',
      modelMissing: '(none)',
      modelFollowHint: 'If the session has no default model, the consultation says so instead of silently choosing another one.',

      materialsLabel: 'Material scope',
      materialsHint: 'Only checked material is assembled and sent. You can read the exact text before sending.',
      materialQuestion: 'The question',
      materialSelection: 'Selection',
      materialPlan: 'Current plan',
      materialDiff: 'Current changes',
      materialTest: 'Test output',

      deliveryLabel: 'Delivery',
      deliveryShow: 'Show to me only',
      deliveryShowHint: 'The opinion stays on the card and the working model is not interrupted.',
      deliveryReturn: 'Hand back for verification',
      deliveryReturnHint: 'The opinion is delivered as a message so the model must state what it checked or why it disagrees.',

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

      saved: 'Saved',
      saveFailed: 'Save failed',
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
      cancel: 'Cancel',
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

      deliveryFact: 'Delivery',
      verifyLabel: 'Verification',
      verifyPending: 'Not established',
      verifyConfirmed: 'The working model confirmed this',
      verifyRejected: 'The working model checked and disagreed',
      verifyInconclusive: 'Inconclusive',
      dispositionLabel: 'Disposition',
      dispositionNone: 'Untouched',
      dispositionAccepted: 'Accepted',
      dispositionFixed: 'Changed',
      dispositionDeferred: 'Deferred',
      deliveredLabel: 'Handed to the model',
      notDelivered: 'Not delivered',

      actionVerify: 'Ask the model to verify',
      actionVerifySent: 'Handed over',
      actionMore: 'Ask again with more material',
      actionDefer: 'Leave it',
      actionRaw: 'View raw opinion',
      actionAccept: 'Mark as handled',
      actionReject: 'Model disagrees',
      actionInconclusive: 'Inconclusive',
      verifyNeedsNote: 'Write the reason in the composer first, then mark.',
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
    };

    const DICT = { zh: ZH, en: EN };

    // ------------------------------------------------------------------ styles

    const CSS = `
.dsha-page { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 40px; max-width: 720px; }
.dsha-h1 { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0; }
.dsha-hint { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); margin: 0; }
.dsha-block { display: flex; flex-direction: column; gap: 8px; }
/* Buttons inside a block are a secondary action next to long text; stretching them
   to the full column width makes them read as a divider bar. */
.dsha-block > .dsha-btn { align-self: flex-start; }
.dsha-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsha-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsha-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.dsha-option { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-primary); }
.dsha-option input { margin-top: 2px; }
.dsha-option-hint { color: var(--dsw-alias-label-secondary); }
.dsha-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.dsha-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.dsha-dot.ok { background: var(--dsw-alias-state-success-primary); }
.dsha-dot.warn { background: var(--dsw-alias-state-warn-primary); }
.dsha-dot.err { background: var(--dsw-alias-state-error-primary); }
.dsha-input, .dsha-select, .dsha-textarea { font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 5px 8px; }
.dsha-textarea { min-height: 62px; resize: vertical; width: 100%; box-sizing: border-box; line-height: 1.55; }
.dsha-num { width: 108px; }
.dsha-btn { font: inherit; font-size: 12px; border-radius: 7px; padding: 5px 11px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsha-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.dsha-btn:disabled { opacity: .5; cursor: default; }
.dsha-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.dsha-btn.ghost { background: transparent; }
.dsha-btn.danger { background: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); color: #fff; }
.dsha-btn.tiny { padding: 2px 8px; font-size: 11px; }
.dsha-pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 8px 10px; max-height: 240px; overflow: auto; margin: 0; color: var(--dsw-alias-label-primary); }
.dsha-note { font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.dsha-note.warn { color: var(--dsw-alias-state-warn-primary); }
.dsha-note.err { color: var(--dsw-alias-state-error-primary); }
.dsha-note.ok { color: var(--dsw-alias-state-success-primary); }

/* The advisor lives in the session header, not under the composer. The strip
   below the composer is a horizontal row that also carries the turn/step/token
   statistics, so anything rendered there competes with a footnote for the same
   line — and expanding in place either clips or shoves those statistics aside.
   The header has real width and no scrolling ancestor, so the pill sits there
   and the panel hangs below it without moving anything. */
.dsha-hdwrap { position: relative; display: inline-flex; align-items: center; }
.dsha-panel { position: absolute; right: 0; top: calc(100% + 6px); z-index: 40; display: flex; flex-direction: column; gap: 0; width: min(560px, 88vw); max-height: min(62vh, 600px); padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-overlay); box-shadow: 0 16px 40px rgba(0,0,0,.18); overflow: hidden; }
/* The head stays put and only the body scrolls: an opinion is long, and a panel
   whose title scrolls away stops saying what is being looked at. */
.dsha-panel-body { display: flex; flex-direction: column; gap: 9px; padding: 11px 13px 12px; overflow-y: auto; }
.dsha-panel-head { display: flex; align-items: center; gap: 10px; min-height: 38px; padding: 0 13px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsha-panel-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); white-space: nowrap; }
.dsha-panel-actions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
.dsha-link { font: inherit; font-size: 11px; color: var(--dsw-alias-label-secondary); background: transparent; border: none; border-radius: 5px; padding: 2px 7px; cursor: pointer; white-space: nowrap; }
.dsha-link:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsha-link[aria-pressed="true"] { color: var(--dsw-alias-brand-primary); }
/* Inline chips inside the card and the confirmation strip: read-only labels for
   the scope of a consultation (which materials go out, which model answers). */
.dsha-chipline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsha-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 2px 9px; background: transparent; cursor: default; white-space: nowrap; }
.dsha-chip.busy { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }

/* The header pill is the only advisor surface visible while the card is
   collapsed, so it has to carry the one fact that matters — something is
   running, or an opinion is waiting on a verdict — and it has to open the
   card when clicked. A pill whose text never changes reads as decoration. */
.dsha-hd { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px; font-weight: 600; line-height: 1; padding: 5px 11px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; }
.dsha-hd:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.dsha-hd:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsha-hd .dsha-dot { width: 7px; height: 7px; }
.dsha-hd.quiet { color: var(--dsw-alias-label-secondary); font-weight: 400; }
/* Filled, not outlined: an outline chip next to the theme and layout icons reads
   as another icon. The one state that asks the person to do something gets the
   solid treatment a badge gets. */
.dsha-hd.brand { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.dsha-hd.brand .dsha-dot { background: #fff; }
.dsha-hd.brand:hover { color: #fff; border-color: var(--dsw-alias-brand-primary); filter: brightness(1.08); }
.dsha-hd.warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.dsha-hd.warn .dsha-dot { background: var(--dsw-alias-state-warn-primary); animation: dsha-pulse 1.6s ease-in-out infinite; }
.dsha-hd.err { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsha-hd.err .dsha-dot { background: var(--dsw-alias-state-error-primary); }
.dsha-hd-ago { font-variant-numeric: tabular-nums; font-weight: 400; opacity: .85; }
@keyframes dsha-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }

.dsha-entry { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: transparent; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
.dsha-entry:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsha-entry[data-open="true"] { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }

.dsha-consult { display: flex; flex-direction: column; gap: 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 11px 13px; }
/* Two lines, not one: the state and the model do not both fit beside the time on
   a narrow card, and wrapping them into each other was what turned labels
   vertical. Line one is what happened, line two is who answered. */
.dsha-consult-head { display: flex; flex-direction: column; gap: 3px; }
.dsha-factline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsha-factline .dsha-status { font-size: 12px; }
.dsha-factline .dsha-when { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsha-prov { font-size: 11px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsha-advice { font-size: 12px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary); margin: 0; }
/* The question is quoted material, so it is set apart from the answer: a left
   rule and the muted colour say "this is what was asked", not "this is a finding". */
.dsha-quote { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); margin: 0; padding-left: 8px; border-left: 2px solid var(--dsw-alias-border-l2); white-space: pre-wrap; word-break: break-word; }
/* Every label in a row refuses to wrap. A vertical "已返回" is not a cramped
   label, it is a broken one: two characters stacked read as decoration. */
.dsha-meta { display: flex; gap: 4px 12px; flex-wrap: wrap; align-items: center; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dsha-meta > span { white-space: nowrap; }
.dsha-meta .dsha-sep { color: var(--dsw-alias-border-l2); }

/* The three facts are a definition list in three columns, because each one is
   answered by a different button below and a run-on sentence makes them look
   like one status. */
.dsha-facts { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0; font-size: 11px; line-height: 1.5; }
.dsha-facts dt { color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsha-facts dd { margin: 0; color: var(--dsw-alias-label-primary); }
.dsha-facts dd[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.dsha-facts dd[data-tone="err"] { color: var(--dsw-alias-state-error-primary); }

/* The history is read as a table: time, state, question, action. Fixed columns
   are what make it scannable — a row where the question starts at a different x
   on every line is a paragraph pretending to be a list. */
.dsha-list { display: flex; flex-direction: column; gap: 1px; max-height: 32vh; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
.dsha-histrow {
  display: grid;
  grid-template-columns: 36px 104px minmax(0, 1fr) 14px;
  align-items: center;
  gap: 8px;
  width: 100%;
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  text-align: left;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 5px 6px;
  cursor: pointer;
}
.dsha-histrow:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.dsha-histrow:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsha-histrow .dsha-when { font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsha-histrow .dsha-state { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; overflow: hidden; }
.dsha-histrow .dsha-ask { color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* An opinion nobody has judged yet is the reason this list is worth opening, so
   that row is the one carrying weight: brand-coloured state, readable question,
   and a chevron that says "this is the one to pick". */
.dsha-histrow[data-owed="true"] .dsha-state { color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dsha-histrow[data-owed="true"] .dsha-ask { color: var(--dsw-alias-label-primary); }
.dsha-histrow .dsha-go { color: var(--dsw-alias-border-l2); font-size: 13px; line-height: 1; text-align: center; }
.dsha-histrow:hover .dsha-go { color: var(--dsw-alias-label-primary); }
.dsha-owed { font-size: 9px; font-weight: 700; letter-spacing: .02em; color: var(--dsw-alias-brand-primary); border: 1px solid var(--dsw-alias-brand-primary); border-radius: 3px; padding: 0 3px; white-space: nowrap; }
.dsha-spacer { flex: 1; }
@media (prefers-reduced-motion: reduce) { .dsha-chip, .dsha-btn, .dsha-entry, .dsha-hd { transition: none; } .dsha-hd.warn .dsha-dot { animation: none; } }
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

    function fmtTime(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function fmtAgo(iso, now) {
      if (!iso) return '';
      const at = new Date(iso).getTime();
      if (!Number.isFinite(at)) return '';
      const seconds = Math.max(0, Math.round((now - at) / 1000));
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m`;
      return `${Math.floor(minutes / 60)}h`;
    }

    /**
     * One tiny store per session, shared by the five slots.
     *
     * The composer bar, the header chip and the card are separate slot cells in
     * separate React roots; without a shared read they would each poll the host
     * and disagree about whether a consultation is running.
     */
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
      return { read, write, subscribe, emit };
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
      const next = value === 'history' ? 'history' : value ? 'card' : null;
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

      async function load(sessionId) {
        if (!sessionId) return null;
        try {
          const [settingsResult, listResult] = await Promise.all([
            rpcCall('settings.get', { sessionId }),
            rpcCall('consult.list', { sessionId }),
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
          const listResult = await rpcCall('consult.list', { sessionId });
          store.write(sessionId, {
            records: (listResult && listResult.records) || [],
            running: (listResult && listResult.running) || 0,
          });
        } catch {
          /* a transient list failure must not blank the card */
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

    function Field(props) {
      return h(
        'label',
        { className: 'dsha-block', style: { gap: '4px' } },
        h('span', { className: 'dsha-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'dsha-hint' }, props.hint) : null,
      );
    }

    function Radio(props) {
      return h(
        'label',
        { className: 'dsha-option' },
        h('input', {
          type: 'radio',
          name: props.name,
          checked: props.checked,
          onChange: props.onChange,
        }),
        h(
          'span',
          null,
          props.title,
          props.hint ? h('span', { className: 'dsha-option-hint' }, ` — ${props.hint}`) : null,
        ),
      );
    }

    function SettingsSection(props) {
      const { t, rpcCall, close } = props;
      const [settings, setSettings] = useState(null);
      const [catalogue, setCatalogue] = useState({ providers: [], models: {} });
      const [resolved, setResolved] = useState(null);
      const [status, setStatus] = useState(null);
      const [error, setError] = useState(null);
      const [saved, setSaved] = useState(null);
      const [check, setCheck] = useState(null);
      const [checking, setChecking] = useState(false);
      const [sessionId, setSessionId] = useState(null);
      const [granted, setGranted] = useState(false);
      const [sessionSelection, setSessionSelection] = useState(null);
      // Deleting the history is the one action here that cannot be undone, and
      // the record it deletes is the only place an unverified opinion exists. So
      // it takes two clicks: the first turns the button into the question.
      const [clearArmed, setClearArmed] = useState(false);

      // The switch lives in the same settings file as everything else, but the
      // composer entry, card and header chip read it from the shared store: they
      // are separate slot cells and never see this component's state. Writing it
      // through means turning the plugin off takes effect in the conversation
      // immediately, instead of after the next full reload.
      function publishEnabled(next) {
        if (!next) return;
        setEnabledGlobal(next.enabled === false ? false : true);
        if (!sessionId) return;
        const current = store.read(sessionId);
        store.write(sessionId, { settings: { ...(current.settings || {}), ...next }, loaded: true });
      }

      const applyResult = useCallback((value) => {
        if (!value) return;
        setSettings(value.settings);
        setStatus(value.status);
        setResolved(value.resolved);
        setGranted(Boolean(value.sessionGranted));
        setSessionSelection(value.sessionSelection || null);
        if (value.providers) setCatalogue({ providers: value.providers, models: value.models || {} });
        publishEnabled(value.settings);
      }, [sessionId]);

      // The settings section is root-scoped, so it has no sessionId of its own.
      // It reads the currently open session from the UI session service when one
      // is available, because "actually used" and the session grant are both
      // per-session facts and showing them globally would be a lie.
      useEffect(() => {
        let cancelled = false;
        (async () => {
          let current = null;
          try {
            const uiSession = ctx_get('uiSession');
            current = uiSession?.adapter?.current?.getSnapshot?.()?.sessionId ?? null;
          } catch {
            current = null;
          }
          if (cancelled) return;
          setSessionId(current);
          try {
            const value = await rpcCall('settings.get', { sessionId: current });
            if (!cancelled) applyResult(value);
          } catch (err) {
            if (!cancelled) setError(String(err && err.message ? err.message : err));
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [applyResult, rpcCall]);

      function ctx_get(name) {
        try {
          return props.getService ? props.getService(name) : null;
        } catch {
          return null;
        }
      }

      const patch = useCallback(
        async (change) => {
          try {
            const value = await rpcCall('settings.patch', { patch: change });
            setSettings(value.settings);
            publishEnabled(value.settings);
            setSaved(Date.now());
            setError(null);
            // Re-read so "actually used" reflects the new target rather than a
            // locally recomputed guess.
            const fresh = await rpcCall('settings.get', { sessionId });
            applyResult(fresh);
          } catch (err) {
            setError(String(err && err.message ? err.message : err));
            setSaved(null);
          }
        },
        [applyResult, rpcCall, sessionId],
      );

      async function toggleGrant() {
        try {
          const value = await rpcCall('settings.grant', { sessionId, granted: !granted });
          setSettings(value.settings);
          setGranted(Boolean(value.granted));
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        }
      }

      async function runCheck() {
        setChecking(true);
        setCheck(null);
        try {
          const value = await rpcCall('check.connection', { sessionId });
          setCheck(value);
        } catch (err) {
          setCheck({ ok: false, code: 'exception', message: String(err && err.message ? err.message : err) });
        } finally {
          setChecking(false);
        }
      }

      async function clearHistory() {
        if (!clearArmed) {
          setClearArmed(true);
          return;
        }
        try {
          await rpcCall('consult.clear', { sessionId });
          setClearArmed(false);
          setCheck((prev) => prev);
          setSaved(Date.now());
        } catch (err) {
          setClearArmed(false);
          setError(String(err && err.message ? err.message : err));
        }
      }

      if (error && !settings) {
        return h(
          'div',
          { className: 'dsha-page' },
          h('div', { className: 'dsha-note err' }, `${t('loadFailed')}: ${error}`),
        );
      }
      if (!settings) {
        return h('div', { className: 'dsha-page' }, h('div', { className: 'dsha-note' }, t('starting')));
      }

      const tone = status === 'ready' ? 'ok' : status === 'needs-model' ? 'warn' : 'err';
      const statusText =
        status === 'ready' ? t('statusReady') : status === 'needs-model' ? t('statusNeedsModel') : t('statusBroken');
      const statusNote =
        status === 'ready' ? t('statusNoteReady') : status === 'needs-model' ? t('statusNoteNeeds') : t('statusNoteBroken');

      const providers = catalogue.providers || [];
      const modelsFor = (providerId) => (catalogue.models && catalogue.models[providerId]) || [];
      const targetMode = settings.target.mode === 'fixed' ? 'fixed' : 'session';
      const chosenProvider = settings.target.provider || (providers[0] && providers[0].id) || '';
      const chosenModel = settings.target.model || (modelsFor(chosenProvider)[0] && modelsFor(chosenProvider)[0].id) || '';

      const materialKeys = ['question', 'selection', 'plan', 'diff', 'test'];
      const materialLabels = {
        question: t('materialQuestion'),
        selection: t('materialSelection'),
        plan: t('materialPlan'),
        diff: t('materialDiff'),
        test: t('materialTest'),
      };

      return h(
        'div',
        { className: 'dsha-page' },
        h(
          'div',
          { className: 'dsha-block' },
          h('h1', { className: 'dsha-h1' }, t('pageTitle')),
          h('p', { className: 'dsha-hint' }, t('pageHint')),
        ),

        // 0. master switch -----------------------------------------------------
        // First block on purpose: someone who wants the plugin gone should not
        // have to read six sections of preferences to find the off switch.
        h(
          'div',
          { className: 'dsha-block' },
          h(
            'label',
            { className: 'dsha-option' },
            h('input', {
              type: 'checkbox',
              checked: settings.enabled !== false,
              onChange: () => patch({ enabled: settings.enabled === false }),
            }),
            h('span', null, t('enabledLabel')),
          ),
          h('p', { className: 'dsha-note' }, t('enabledHint')),
        ),

        // 1. status ------------------------------------------------------------
        h(
          'div',
          { className: 'dsha-block' },
          h('span', { className: 'dsha-label' }, t('statusLabel')),
          h(
            'div',
            { className: 'dsha-row' },
            h('span', { className: 'dsha-status' }, h('span', { className: `dsha-dot ${tone}` }), statusText),
            resolved && resolved.label
              ? h('span', { className: 'dsha-note' }, `${t('modelResolved')}: ${resolved.label}`)
              : null,
          ),
          h('p', { className: 'dsha-note' }, statusNote),
        ),

        // 2. mode --------------------------------------------------------------
        h(
          'div',
          { className: 'dsha-block' },
          h('span', { className: 'dsha-label' }, t('modeLabel')),
          h(Radio, {
            name: 'dsha-mode',
            checked: settings.mode === 'manual',
            onChange: () => patch({ mode: 'manual' }),
            title: t('modeManual'),
            hint: t('modeManualHint'),
          }),
          h(Radio, {
            name: 'dsha-mode',
            checked: settings.mode === 'confirm',
            onChange: () => patch({ mode: 'confirm' }),
            title: t('modeConfirm'),
            hint: t('modeConfirmHint'),
          }),
          h(Radio, {
            name: 'dsha-mode',
            checked: settings.mode === 'auto',
            onChange: () => patch({ mode: 'auto' }),
            title: t('modeAuto'),
            hint: t('modeAutoHint'),
          }),
          sessionId
            ? h(
                'div',
                { className: 'dsha-row' },
                h('span', { className: 'dsha-note' }, granted ? t('grantOn') : t('grantOff')),
                h(
                  'button',
                  { className: 'dsha-btn tiny', type: 'button', onClick: toggleGrant },
                  granted ? t('revokeButton') : t('grantButton'),
                ),
              )
            : null,
          h('p', { className: 'dsha-note' }, t('grantHint')),
        ),

        // 3. model -------------------------------------------------------------
        h(
          'div',
          { className: 'dsha-block' },
          h('span', { className: 'dsha-label' }, t('modelLabel')),
          h(Radio, {
            name: 'dsha-target',
            checked: targetMode === 'session',
            onChange: () => patch({ target: { mode: 'session', provider: null, model: null } }),
            title: t('modelFollowSession'),
          }),
          sessionSelection
            ? h('span', { className: 'dsha-note' }, `${sessionSelection.provider}/${sessionSelection.model}`)
            : h('span', { className: 'dsha-note' }, t('modelMissing')),
          h('p', { className: 'dsha-note' }, t('modelFollowHint')),
          h(Radio, {
            name: 'dsha-target',
            checked: targetMode === 'fixed',
            onChange: () =>
              patch({
                target: { mode: 'fixed', provider: chosenProvider || null, model: chosenModel || null },
              }),
            title: t('modelFixed'),
          }),
          h(
            'div',
            { className: 'dsha-row' },
            h('span', { className: 'dsha-note' }, t('modelProvider')),
            h(
              'select',
              {
                className: 'dsha-select',
                value: settings.target.provider || '',
                disabled: targetMode !== 'fixed',
                onChange: (event) => {
                  const provider = event.target.value;
                  const models = modelsFor(provider);
                  patch({
                    target: {
                      mode: 'fixed',
                      provider: provider || null,
                      model: (models[0] && models[0].id) || null,
                    },
                  });
                },
              },
              h('option', { value: '' }, '—'),
              providers.map((provider) =>
                h('option', { key: provider.id, value: provider.id }, provider.label || provider.id),
              ),
            ),
            h('span', { className: 'dsha-note' }, t('modelName')),
            h(
              'select',
              {
                className: 'dsha-select',
                value: settings.target.model || '',
                disabled: targetMode !== 'fixed',
                onChange: (event) =>
                  patch({
                    target: {
                      mode: 'fixed',
                      provider: settings.target.provider || chosenProvider || null,
                      model: event.target.value || null,
                    },
                  }),
              },
              h('option', { value: '' }, '—'),
              modelsFor(settings.target.provider || chosenProvider).map((model) =>
                h('option', { key: model.id, value: model.id }, model.label || model.id),
              ),
            ),
          ),
        ),

        // 4. materials ---------------------------------------------------------
        h(
          'div',
          { className: 'dsha-block' },
          h('span', { className: 'dsha-label' }, t('materialsLabel')),
          h('p', { className: 'dsha-hint' }, t('materialsHint')),
          h(
            'div',
            { className: 'dsha-row', style: { gap: '14px' } },
            materialKeys.map((kind) =>
              h(
                'label',
                { key: kind, className: 'dsha-option' },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(settings.materials[kind]),
                  onChange: () => {
                    const next = { ...settings.materials, [kind]: !settings.materials[kind] };
                    // The question is the one material that cannot be dropped:
                    // without it the advisor has nothing to answer.
                    if (kind === 'question' && !next.question) next.question = true;
                    patch({ materials: next });
                  },
                }),
                h('span', null, materialLabels[kind]),
              ),
            ),
          ),
        ),

        // 5. delivery ----------------------------------------------------------
        h(
          'div',
          { className: 'dsha-block' },
          h('span', { className: 'dsha-label' }, t('deliveryLabel')),
          h(Radio, {
            name: 'dsha-delivery',
            checked: settings.delivery === 'show',
            onChange: () => patch({ delivery: 'show' }),
            title: t('deliveryShow'),
            hint: t('deliveryShowHint'),
          }),
          h(Radio, {
            name: 'dsha-delivery',
            checked: settings.delivery === 'return',
            onChange: () => patch({ delivery: 'return' }),
            title: t('deliveryReturn'),
            hint: t('deliveryReturnHint'),
          }),
        ),

        // 6. advanced ----------------------------------------------------------
        h(
          'div',
          { className: 'dsha-block' },
          h('span', { className: 'dsha-label' }, t('advancedLabel')),
          h(
            'div',
            { className: 'dsha-row', style: { gap: '16px' } },
            h(Field, { label: t('advancedTokens') },
              h('input', {
                className: 'dsha-input dsha-num',
                type: 'number',
                min: 64,
                value: settings.advanced.maxAdviceTokens,
                onChange: (event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value) || value <= 0) return;
                  patch({ advanced: { maxAdviceTokens: Math.round(value) } });
                },
              }),
            ),
            h(Field, { label: t('advancedDeadline') },
              h('input', {
                className: 'dsha-input dsha-num',
                type: 'number',
                min: 1000,
                step: 1000,
                value: settings.advanced.consultDeadlineMs,
                onChange: (event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value) || value < 0) return;
                  patch({ advanced: { consultDeadlineMs: Math.round(value) } });
                },
              }),
            ),
          ),
          h(
            'div',
            { className: 'dsha-row', style: { gap: '16px' } },
            h(Field, { label: t('advancedBudget') },
              h('input', {
                className: 'dsha-input dsha-num',
                type: 'number',
                min: 0,
                value: settings.advanced.maxConsultationsPerSession,
                onChange: (event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value) || value < 0) return;
                  patch({ advanced: { maxConsultationsPerSession: Math.round(value) } });
                },
              }),
            ),
            h(Field, { label: t('advancedHistory') },
              h('input', {
                className: 'dsha-input dsha-num',
                type: 'number',
                min: 1,
                value: settings.advanced.historyLimit,
                onChange: (event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value) || value < 1) return;
                  patch({ advanced: { historyLimit: Math.round(value) } });
                },
              }),
            ),
          ),
          h('p', { className: 'dsha-note' }, t('advancedHint')),
        ),

        // 7. connection check + history ---------------------------------------
        h(
          'div',
          { className: 'dsha-card' },
          h('span', { className: 'dsha-label' }, t('checkLabel')),
          h('p', { className: 'dsha-note' }, t('checkHint')),
          h(
            'div',
            { className: 'dsha-row' },
            h(
              'button',
              { className: 'dsha-btn', type: 'button', onClick: runCheck, disabled: checking },
              checking ? t('checking') : t('checkButton'),
            ),
            h(
              'button',
              {
                className: clearArmed ? 'dsha-btn danger' : 'dsha-btn ghost',
                type: 'button',
                onClick: clearHistory,
                // Escape and blur both disarm: an armed destructive button must
                // not survive a click elsewhere and fire later by surprise.
                onBlur: () => setClearArmed(false),
                onKeyDown: (event) => {
                  if (event.key === 'Escape') setClearArmed(false);
                },
              },
              clearArmed ? t('clearConfirm') : t('clearButton'),
            ),
            saved ? h('span', { className: 'dsha-note ok' }, t('saved')) : null,
          ),
          clearArmed ? h('p', { className: 'dsha-note err' }, `${t('clearWarn')} ${t('clearCancel')}`) : null,
          check
            ? h(
                'p',
                { className: `dsha-note ${check.ok ? 'ok' : 'err'}` },
                check.ok
                  ? `${t('checkOk')} · ${check.model} · ${check.elapsedMs}ms`
                  : `${t('checkFail')} · ${check.code || ''} ${check.message || ''}`,
              )
            : null,
          error ? h('p', { className: 'dsha-note err' }, `${t('saveFailed')}: ${error}`) : null,
        ),

        close
          ? h(
              'div',
              { className: 'dsha-row' },
              h('button', { className: 'dsha-btn ghost', type: 'button', onClick: close }, t('close')),
            )
          : null,
      );
    }

    // ------------------------------------------------------------- entry point

    function ConsultEntry(props) {
      const { t, sessionId, openConsult, consultOpen } = props;
      return h(
        'button',
        {
          type: 'button',
          className: 'dsha-entry',
          'data-open': consultOpen ? 'true' : 'false',
          onClick: () => openConsult(sessionId),
          title: t('consultTitle'),
        },
        t('consult'),
      );
    }

    // ------------------------------------------------------- confirmation strip

    function ConsultDock(props) {
      const { t, sessionId, rpcCall, consultOpen, closeConsult, draft, reload } = props;
      const view = useStore(sessionId);
      const [question, setQuestion] = useState('');
      const [focus, setFocus] = useState('general');
      const [preview, setPreview] = useState(null);
      const [showText, setShowText] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      // Opening the strip seeds the question from the composer draft: the user
      // has usually already typed the thing they want reviewed, and making them
      // type it twice is how an entry point stops being used.
      useEffect(() => {
        if (!consultOpen) return;
        setQuestion((current) => (current === '' ? String(draft || '') : current));
        setError(null);
      }, [consultOpen, draft]);

      const kindLabels = {
        question: t('materialQuestion'),
        selection: t('materialSelection'),
        plan: t('materialPlan'),
        diff: t('materialDiff'),
        test: t('materialTest'),
      };

      async function doPreview() {
        setBusy(true);
        setError(null);
        try {
          const value = await rpcCall('materials.preview', {
            sessionId,
            request: { question: question || '（预览）', focus },
          });
          setPreview(value);
          setShowText(Boolean(value && value.ok));
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy(false);
        }
      }

      async function doStart() {
        setBusy(true);
        setError(null);
        try {
          const value = await rpcCall('consult.start', {
            sessionId,
            request: { question: question.trim(), focus },
          });
          if (value && value.accepted) {
            // Open the card: the person just asked for this, so the result must
            // be where they are looking when it settles, not one click away.
            setDockView(sessionId, 'card');
            closeConsult();
            setQuestion('');
            setPreview(null);
            setShowText(false);
            // The card lives in a different slot with its own store; refresh it
            // here so the result is visible the moment this strip closes instead
            // of waiting for the next mount.
            if (reload) await reload();
          } else if (value && value.record && value.record.error) {
            setError(value.record.error.message || t('stateRefused'));
          }
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy(false);
        }
      }

      if (!consultOpen) return null;

      const resolvedLabel = view.resolved && view.resolved.label ? view.resolved.label : t('modelMissing');
      const scope = view.settings ? view.settings.materials : null;

      return h(
        'div',
        { className: 'dsha-dock' },
        h(
          'div',
          { className: 'dsha-dock-head' },
          h('span', { className: 'dsha-dock-title' }, t('consultTitle')),
          h(
            'button',
            { className: 'dsha-btn tiny ghost', type: 'button', onClick: closeConsult, disabled: busy },
            t('cancel'),
          ),
        ),
        h(
          'div',
          { className: 'dsha-block', style: { gap: '4px' } },
          h('span', { className: 'dsha-label' }, t('consultQuestion')),
          h('textarea', {
            className: 'dsha-textarea',
            value: question,
            placeholder: t('consultQuestionPlaceholder'),
            onChange: (event) => setQuestion(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'dsha-chipline' },
          h('span', null, `${t('consultModel')}: `),
          h('strong', { style: { color: 'var(--dsw-alias-label-primary)' } }, resolvedLabel),
        ),
        h(
          'div',
          { className: 'dsha-chipline' },
          h('span', null, `${t('consultMaterials')}: `),
          scope
            ? Object.keys(kindLabels)
                .filter((kind) => scope[kind])
                .map((kind) => h('span', { key: kind, className: 'dsha-chip' }, kindLabels[kind]))
            : null,
        ),
        h(
          'div',
          { className: 'dsha-row' },
          h(
            'button',
            { className: 'dsha-btn tiny ghost', type: 'button', onClick: doPreview, disabled: busy },
            showText ? t('hideMaterials') : t('viewMaterials'),
          ),
          h('span', { className: 'dsha-spacer' }),
          h(
            'button',
            {
              className: 'dsha-btn primary',
              type: 'button',
              onClick: doStart,
              disabled: busy || question.trim() === '',
            },
            busy ? t('starting') : t('startConsult'),
          ),
        ),
        preview && !preview.ok
          ? h('p', { className: 'dsha-note err' }, `${preview.reason}`)
          : null,
        preview && preview.ok
          ? h(
              'div',
              { className: 'dsha-block', style: { gap: '6px' } },
              h(
                'span',
                { className: 'dsha-note' },
                `${preview.chars} ${t('chars')} · ${preview.summary}`,
              ),
              (preview.materials || []).map((material) =>
                h(
                  'span',
                  { key: material.kind, className: 'dsha-note' },
                  `${kindLabels[material.kind] || material.kind}: ${material.absent ? t('absentMaterial') : `${material.chars} ${t('chars')}${material.truncated ? ` ${t('truncatedMaterial')}` : ''}${material.fromEarlierTurn ? ` ${t('earlierTurnMaterial')}` : ''}`}`,
                ),
              ),
              showText && preview.text ? h('pre', { className: 'dsha-pre' }, preview.text) : null,
            )
          : null,
        error ? h('p', { className: 'dsha-note err' }, error) : null,
      );
    }

    // ----------------------------------------------------------- consultation card

    function AdviceBody(props) {
      const { t, record, expanded, onToggle } = props;
      const text = String(record.advice || '');
      if (text === '') return null;
      const head = expanded ? text : previewOf(text, 4, 380);
      const cut = !expanded && text.trim() !== head.trim();
      return h(
        'div',
        { className: 'dsha-block', style: { gap: '4px' } },
        h('p', { className: 'dsha-advice' }, head),
        cut || expanded
          ? h(
              'button',
              { className: 'dsha-btn tiny ghost', type: 'button', onClick: onToggle },
              expanded ? t('cardCollapse') : t('cardFull'),
            )
          : null,
      );
    }

    function ConsultCardBody(props) {
      const { t, record, rpcCall, sessionId, noteText, reload } = props;
      const [expanded, setExpanded] = useState(false);
      const [busy, setBusy] = useState(false);
      const [localNote, setLocalNote] = useState(null);
      const active = isPending(record);
      const now = useNow(active);

      // Every write below changes the record on the host. Re-reading it is what
      // makes "核验状态: 尚未确认" turn into the verdict the user just recorded;
      // patching local state instead would let the card claim a state the stored
      // record does not have.
      async function annotate(patch) {
        setBusy(true);
        try {
          const value = await rpcCall('consult.annotate', {
            sessionId,
            consultationId: record.id,
            patch,
          });
          if (value && value.record) setLocalNote(null);
          if (reload) await reload();
        } catch (err) {
          setLocalNote(String(err && err.message ? err.message : err));
        } finally {
          setBusy(false);
        }
      }

      async function deliver() {
        setBusy(true);
        setLocalNote(null);
        try {
          const value = await rpcCall('consult.deliver', {
            sessionId,
            consultationId: record.id,
          });
          if (!value.ok) setLocalNote(value.message || value.reason);
          if (reload) await reload();
        } catch (err) {
          setLocalNote(String(err && err.message ? err.message : err));
        } finally {
          setBusy(false);
        }
      }

      async function cancelRun() {
        setBusy(true);
        try {
          await rpcCall('consult.cancel', { sessionId, consultationId: record.id });
        } catch (err) {
          setLocalNote(String(err && err.message ? err.message : err));
        } finally {
          setBusy(false);
          if (reload) await reload();
        }
      }

      const caveat = stateCaveat(t, record);
      const waited = active && record.createdAt ? Math.round((now - new Date(record.createdAt).getTime()) / 1000) : 0;
      const staleness = record.staleness || null;

      return h(
        'div',
        { className: 'dsha-consult' },
        h(
          'div',
          { className: 'dsha-consult-head' },
          h(
            'div',
            { className: 'dsha-factline' },
            h(
              'span',
              { className: 'dsha-status' },
              h('span', { className: `dsha-dot ${stateTone(record.state)}` }),
              stateLabel(t, record.state),
            ),
            h('span', { className: 'dsha-when' }, fmtTime(record.createdAt)),
            active ? h('span', { className: 'dsha-when' }, t('waited').replace('%s', String(waited))) : null,
          ),
          record.target && (record.target.model || record.target.provider)
            ? h(
                'span',
                { className: 'dsha-prov' },
                `${record.target.provider || ''}${record.target.provider && record.target.model ? ' / ' : ''}${record.target.model || ''}`,
              )
            : null,
        ),

        staleness && staleness.verdict === 'changed'
          ? h(
              'div',
              { className: 'dsha-block', style: { gap: '2px' } },
              h('span', { className: 'dsha-note warn' }, t('staleNote')),
              (staleness.changedPaths || []).length > 0
                ? h(
                    'span',
                    { className: 'dsha-note' },
                    `${t('stalePaths')} ${(staleness.changedPaths || []).slice(0, 6).join(', ')}`,
                  )
                : null,
            )
          : null,

        // The question is context, not content: it is quoted so the opinion below
        // is read as an answer to something specific.
        record.question ? h('p', { className: 'dsha-quote' }, record.question) : null,

        h(AdviceBody, {
          t,
          record,
          expanded,
          onToggle: () => setExpanded((value) => !value),
        }),

        caveat ? h('p', { className: `dsha-note ${record.state === 'failed' || record.state === 'refused' ? 'err' : 'warn'}` }, caveat) : null,

        record.error && record.error.message
          ? h('p', { className: 'dsha-note err' }, `${record.error.code || ''} ${record.error.message}`.trim())
          : null,

        record.reason === 'session-budget-exhausted' || record.reason === 'no-model'
          ? h('p', { className: 'dsha-note warn' }, String(record.reason))
          : null,

        record.materials && record.materials.kinds && record.materials.kinds.length > 0
          ? h(
              'div',
              { className: 'dsha-meta' },
              h('span', null, `${record.materials.chars} ${t('chars')}`),
              h('span', { className: 'dsha-sep' }, '·'),
              // Localized names, not the raw kind ids: "question · plan" is the
              // settings vocabulary, and the card is read by a person.
              h('span', null, (record.materials.kinds || []).map((kind) => materialName(t, kind)).join(' · ')),
              record.materials.truncated && record.materials.truncated.length > 0
                ? h('span', { className: 'dsha-note warn' }, `${t('truncatedMaterial')} ${record.materials.truncated.join(', ')}`)
                : null,
              record.materials.fromEarlierTurn && record.materials.fromEarlierTurn.length > 0
                ? h('span', { className: 'dsha-note warn' }, `${t('earlierTurnMaterial')} ${record.materials.fromEarlierTurn.join(', ')}`)
                : null,
            )
          : null,

        // Three separate facts, shown as a small definition list. They are
        // separate columns rather than one sentence because each one is answered
        // by a different button below, and a run-on line makes them look like one
        // status.
        h(
          'dl',
          { className: 'dsha-facts' },
          h('dt', null, t('verifyLabel')),
          h('dd', { 'data-tone': record.verification === 'confirmed' ? 'ok' : record.verification === 'rejected' ? 'err' : '' }, verifyText(t, record.verification)),
          h('dt', null, t('dispositionLabel')),
          h('dd', null, dispositionText(t, record.disposition)),
          h('dt', null, t('deliveryFact')),
          h('dd', null, record.deliveredToModel ? t('deliveredLabel') : t('notDelivered')),
        ),
        record.verdictNote ? h('p', { className: 'dsha-quote' }, record.verdictNote) : null,

        h(
          'div',
          { className: 'dsha-row' },
          active
            ? h(
                'button',
                { className: 'dsha-btn tiny', type: 'button', onClick: cancelRun, disabled: busy },
                busy ? t('cancelling') : t('cancelConsult'),
              )
            : null,

          !active && record.advice && !record.deliveredToModel
            ? h(
                'button',
                { className: 'dsha-btn tiny primary', type: 'button', onClick: deliver, disabled: busy },
                t('actionVerify'),
              )
            : null,

          !active && record.advice
            ? h(
                'button',
                {
                  className: 'dsha-btn tiny ghost',
                  type: 'button',
                  disabled: busy,
                  title: t('verifyHint'),
                  onClick: () =>
                    annotate({
                      verification: 'confirmed',
                      verdictNote: noteText || '',
                      disposition: 'accepted',
                    }),
                },
                t('actionAccept'),
              )
            : null,

          !active && record.advice
            ? h(
                'button',
                {
                  className: 'dsha-btn tiny ghost',
                  type: 'button',
                  disabled: busy,
                  onClick: () => annotate({ verification: 'rejected', verdictNote: noteText || '' }),
                },
                t('actionReject'),
              )
            : null,

          !active
            ? h(
                'button',
                {
                  className: 'dsha-btn tiny ghost',
                  type: 'button',
                  disabled: busy,
                  onClick: () => annotate({ disposition: 'deferred' }),
                },
                t('actionDefer'),
              )
            : null,
        ),

        localNote ? h('p', { className: 'dsha-note err' }, localNote) : null,
      );
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
    function AdvisorPanel(props) {
      const { t, sessionId, rpcCall, bridge, noteText, records, card } = props;
      const dockView = useDockView(sessionId);
      const showHistory = dockView === 'history';

      return h(
        'div',
        { className: 'dsha-panel' },
        h(
          'div',
          { className: 'dsha-panel-head' },
          h('span', { className: 'dsha-panel-title' }, showHistory ? t('historyLabel') : t('cardTitle')),
          h(
            'div',
            { className: 'dsha-panel-actions' },
            h(
              'button',
              {
                className: 'dsha-link',
                type: 'button',
                'aria-pressed': showHistory ? 'true' : 'false',
                onClick: () => setDockView(sessionId, showHistory ? 'card' : 'history'),
              },
              showHistory ? t('cardTitle') : `${t('historyOpen')} ${records.length}`,
            ),
            h(
              'button',
              {
                className: 'dsha-link',
                type: 'button',
                onClick: () => setDockView(sessionId, null),
              },
              t('cardCollapse'),
            ),
          ),
        ),

        h(
          'div',
          { className: 'dsha-panel-body' },
          showHistory
          ? h(
              'div',
              { className: 'dsha-list' },
              records.length === 0
                ? h('span', { className: 'dsha-note' }, t('historyEmpty'))
                : records.map((record) => {
                    // An opinion nobody has judged yet is the whole reason the
                    // person opened this list; mark the row so the queue can be
                    // worked top to bottom instead of guessed at.
                    const owed = Boolean(
                      record.advice &&
                        !isPending(record) &&
                        record.verification !== 'confirmed' &&
                        record.verification !== 'rejected',
                    );
                    return h(
                      'button',
                      {
                        key: record.id,
                        type: 'button',
                        className: 'dsha-histrow',
                        'data-owed': owed ? 'true' : 'false',
                        title: String(record.question || ''),
                        onClick: () => {
                          store.write(sessionId, {
                            records: [record, ...records.filter((entry) => entry.id !== record.id)],
                          });
                          setDockView(sessionId, 'card');
                        },
                      },
                      h('span', { className: 'dsha-when' }, fmtTime(record.createdAt)),
                      h(
                        'span',
                        { className: 'dsha-state' },
                        h('span', { className: `dsha-dot ${stateTone(record.state)}` }),
                        owed ? h('span', { className: 'dsha-owed' }, t('owedTag')) : null,
                        h('span', null, stateLabel(t, record.state)),
                      ),
                      h('span', { className: 'dsha-ask' }, String(record.question || '')),
                      h('span', { className: 'dsha-go', 'aria-hidden': 'true' }, '›'),
                    );
                  }),
            )
          : card
            ? h(ConsultCardBody, {
                t,
                record: card,
                rpcCall,
                sessionId,
                noteText,
                reload: () => bridge.reloadRecords(sessionId),
              })
            : h('span', { className: 'dsha-note' }, t('historyEmpty')),
        ),
      );
    }

    // -------------------------------------------------------------- header pill

    /**
     * The header pill. While the card is collapsed this is the only advisor
     * surface on screen, so it reports the state that actually asks something of
     * the person — a consultation in flight, or a settled opinion nobody has
     * verified yet — and clicking it opens that opinion. A pill showing the
     * configured mode alone reads as a static label and gets ignored.
     */
    function HeaderStatus(props) {
      const { t, sessionId, bridge, rpcCall, noteText } = props;
      const view = useStore(sessionId);
      const dockView = useDockView(sessionId);
      const open = dockView !== null;

      useEffect(() => {
        bridge.load(sessionId);
      }, [bridge, sessionId]);

      const records = view.records || [];
      const running = records.filter(isPending);
      const pending = running[0] || null;
      // An opinion that arrived and has not been judged yet. `verification` stays
      // 'pending' until a person marks it, so this is a real queue, not a guess.
      const unverified = records.filter(
        (record) => !isPending(record) && record.advice && record.verification !== 'confirmed' && record.verification !== 'rejected',
      );
      const now = useNow(Boolean(pending));

      // Poll only while something is in flight: the record's own state is the
      // progress report, and there is nothing to poll for once it has settled.
      useEffect(() => {
        if (running.length === 0) return undefined;
        const id = setInterval(() => bridge.reloadRecords(sessionId), 900);
        return () => clearInterval(id);
      }, [bridge, sessionId, running.length]);

      const settled = records.filter((record) => !isPending(record));
      const card = running[0] || settled[0] || null;

      if (view.error && !view.loaded) return null;
      // Anything at all to show? No records and nothing running means this
      // session has never consulted, and an empty pill would just add noise.
      if (!pending && unverified.length === 0 && records.length === 0) return null;

      let tone = 'quiet';
      let label = '';
      let detail = null;
      let title = '';

      if (pending) {
        const waited = pending.createdAt ? Math.max(0, Math.round((now - new Date(pending.createdAt).getTime()) / 1000)) : 0;
        tone = 'warn';
        label = t('hdRunning').replace('%s', String(waited));
        detail = String(pending.question || '').slice(0, 24) || null;
        title = t('hdExpand');
      } else if (unverified.length > 0) {
        tone = 'brand';
        label = t('hdVerdict').replace('%s', String(unverified.length));
        detail = null;
        title = t('hdVerdictHint');
      } else {
        const last = records[0];
        const mode = view.mode || (view.settings && view.settings.mode) || 'manual';
        label = mode === 'auto' ? t('hdAuto') : t('hdLast').replace('%s', stateLabel(t, last.state));
        detail = last && last.createdAt ? fmtTime(last.createdAt) : null;
        title = open ? t('hdCollapse') : t('hdExpand');
      }

      return h(
        'div',
        { className: 'dsha-hdwrap' },
        h(
          'button',
          {
            type: 'button',
            className: `dsha-hd ${tone}`,
            'data-open': open ? 'true' : 'false',
            'data-tone': tone,
            title,
            'aria-label': `${label} — ${title}`,
            'aria-expanded': open ? 'true' : 'false',
            // A pill reporting pending verdicts opens that list; otherwise it opens the
            // single latest opinion.
            onClick: () => setDockView(sessionId, open ? null : tone === 'brand' ? 'history' : 'card'),
          },
          h('span', { className: 'dsha-dot' }),
          h('span', null, label),
          detail ? h('span', { className: 'dsha-hd-ago' }, detail) : null,
        ),
        open
          ? h(AdvisorPanel, { t, sessionId, rpcCall, bridge, noteText, records, card })
          : null,
      );
    }

    // ------------------------------------------------- model-initiated tool card

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
        const state = cancelled ? 'cancelled' : timedOut ? 'timed_out' : truncated ? 'truncated' : outcome === 'ok' || advice ? 'returned' : 'failed';
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
        const openState = { bySession: new Map(), listeners: new Set() };
        function isOpenFor(sessionId) {
          return Boolean(openState.bySession.get(sessionId));
        }
        function setOpenFor(sessionId, value) {
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
          const open = useOpen(props.sessionId);
          const enabled = useAdvisorEnabled(props.sessionId);
          if (!enabled) return null;
          return h(ConsultEntry, {
            ...props,
            t,
            consultOpen: open,
            openConsult: (sessionId) => setOpenFor(sessionId, true),
          });
        }

        function ConsultDockBound(props) {
          const open = useOpen(props.sessionId);
          const enabled = useAdvisorEnabled(props.sessionId);
          if (!enabled) return null;
          return h(ConsultDock, {
            ...props,
            t,
            rpcCall: bridge.rpcCall,
            reload: () => bridge.reloadRecords(props.sessionId),
            consultOpen: open,
            closeConsult: () => setOpenFor(props.sessionId, false),
          });
        }

        function HeaderStatusBound(props) {
          const enabled = useAdvisorEnabled(props.sessionId);
          // The verdict reason usually lives in the composer draft, so read it here
          // too; the panel's "the model disagreed" needs a reason without a modal.
          const draft = typeof props.useInput === 'function' ? props.useInput((state) => state.draft) : '';
          if (!enabled) return null;
          return h(HeaderStatus, {
            ...props,
            t,
            bridge,
            rpcCall: bridge.rpcCall,
            noteText: String(draft || ''),
          });
        }

        function ToolCallCardBound(props) {
          return h(ToolCallCard, { ...props, t });
        }

        function SettingsBound(props) {
          return h(SettingsSection, {
            ...props,
            t,
            rpcCall: bridge.rpcCall,
            getService: (name) => {
              try {
                return ctx.get(name);
              } catch {
                return null;
              }
            },
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
