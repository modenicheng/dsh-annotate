/**
 * dsh-marker content script 3/4 (ui) — the language table.
 *
 * Two locales, keyed identically. `pickLanguage` is the only place that maps a
 * browser locale onto a table, so the rest of the UI never inspects a locale
 * string. Loaded before the other `ui/` parts; publishes `ns.ui.strings`.
 */
;(function installUiStrings(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  const ui = (ns.ui = ns.ui || {})

  // `scripting.executeScript` may inject these files a second time when the
  // manifest-declared content script has not answered yet, so installing twice
  // must be a no-op rather than a second set of nodes and listeners.
  if (ui.strings) return

  const STRINGS = {
    en: {
      modeAuto: 'Annotation mode',
      modeSelection: 'Pick: text',
      modeElement: 'Pick: element',
      modeRegion: 'Pick: region',
      hintAuto: 'click element · drag region · Shift+drag text',
      hintSelection: 'select text',
      hintElement: 'click an element',
      hintRegion: 'drag a region',
      hideLayers: 'Hide layers',
      showLayers: 'Show layers',
      exit: 'Exit (Esc)',
      composerSelection: 'Selected text',
      composerElement: 'Element',
      composerRegion: 'Region',
      placeholder: 'What about this?  Enter sends · Shift+Enter adds a line',
      send: 'Send',
      sendMark: 'Send mark',
      sending: 'Sending…',
      cancel: 'Cancel',
      saved: 'Annotation sent',
      savedMark: 'Mark sent without a comment',
      sendFailed: 'Send failed — is the DeepSeek Harness host running?',
      anchorFailed: 'Could not build an anchor for that',
      anchorInvalid: 'Anchor failed protocol validation',
      pickTitle: 'The agent asks',
      pickCancelHint: 'Esc cancels',
      pickCancelled: 'Pick cancelled',
      noComment: '(no comment)',
      agentNote: 'Agent',
      stateOpen: 'open',
      stateResolved: 'resolved',
      stateWontFix: "won't fix",
      kindSelection: 'selection',
      kindElement: 'element',
      kindRegion: 'region',
      offscreen: 'Anchor is outside the viewport',
      deleteAnnotation: 'Delete annotation',
      openCard: 'Click to keep this card open',
      deleting: 'Deleting…',
      deletedOne: 'Annotation deleted',
      deleteFailed: 'Could not delete the annotation',
      clearResolved: 'Clear resolved',
      clearAll: 'Clear all',
      clearConfirm: 'Confirm deleting {n}',
      clearing: 'Deleting…',
      clearNothing: 'No annotations to clear',
      clearNothingResolved: 'No resolved annotations',
      clearedCount: 'Deleted {n} annotations',
      clearedPartial: 'Deleted {n}, {failed} failed',
      targetChoose: 'Send to',
      targetSearch: 'Search sessions…',
      targetLoading: 'Reading sessions…',
      targetEmpty: 'No matching session',
      targetFailed: 'Could not read the session list',
      targetLatest: 'Most recent session',
      targetRunning: 'running',
      targetUntitled: 'untitled session',
      targetHint: 'The mention is appended to that session’s composer; nothing is sent.',
      chipLabel: 'annotation · {summary}',
      timeNow: 'just now',
      timeMinutes: '{n} min ago',
      timeHours: '{n} h ago',
      timeDays: '{n} d ago',
    },
    zh: {
      modeAuto: '批注模式',
      modeSelection: '选择：文本',
      modeElement: '选择：元素',
      modeRegion: '选择：区域',
      hintAuto: '点元素 · 拖框 · Shift+划词',
      hintSelection: '划词选择',
      hintElement: '点击元素',
      hintRegion: '拖框选区域',
      hideLayers: '隐藏标注',
      showLayers: '显示标注',
      exit: '退出（Esc）',
      composerSelection: '选中文本',
      composerElement: '元素',
      composerRegion: '区域',
      placeholder: '想说点什么？Enter 发送 · Shift+Enter 换行',
      send: '发送',
      sendMark: '只发标记',
      sending: '发送中…',
      cancel: '取消',
      saved: '已发送批注',
      savedMark: '已发送标记（无评论）',
      sendFailed: '发送失败——DeepSeek Harness 宿主在运行吗？',
      anchorFailed: '无法为该目标生成锚点',
      anchorInvalid: '锚点未通过协议校验',
      pickTitle: '智能体在问',
      pickCancelHint: 'Esc 取消',
      pickCancelled: '已取消这次选择',
      noComment: '（没有评论）',
      agentNote: '智能体',
      stateOpen: '待处理',
      stateResolved: '已解决',
      stateWontFix: '不修',
      kindSelection: '文本',
      kindElement: '元素',
      kindRegion: '区域',
      offscreen: '锚点已不在视口内',
      deleteAnnotation: '删除批注',
      openCard: '点击固定批注卡片',
      deleting: '删除中…',
      deletedOne: '已删除批注',
      deleteFailed: '删除失败',
      clearResolved: '清空已解决',
      clearAll: '清空全部',
      clearConfirm: '确认清空 {n} 条',
      clearing: '清空中…',
      clearNothing: '没有可清空的批注',
      clearNothingResolved: '没有已解决的批注',
      clearedCount: '已删除 {n} 条批注',
      clearedPartial: '已删除 {n} 条，{failed} 条失败',
      targetChoose: '插入到',
      targetSearch: '搜索会话…',
      targetLoading: '正在读取会话…',
      targetEmpty: '没有匹配的会话',
      targetFailed: '读取会话列表失败',
      targetLatest: '最近的会话',
      targetRunning: '运行中',
      targetUntitled: '未命名会话',
      targetHint: '批注会加到那个会话的输入框末尾，不会自动发送。',
      chipLabel: '批注 · {summary}',
      timeNow: '刚刚',
      timeMinutes: '{n} 分钟前',
      timeHours: '{n} 小时前',
      timeDays: '{n} 天前',
    },
  }

  function pickLanguage(language) {
    return String(language || '')
      .toLowerCase()
      .startsWith('zh')
      ? 'zh'
      : 'en'
  }

  ui.strings = { STRINGS, pickLanguage }
})(globalThis)
