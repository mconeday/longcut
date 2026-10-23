const store = require('../../utils/store.js')
const imageJob = require('../../utils/imageJob.js')
const paper = require('../../utils/paper.js')
const paginate = require('../../utils/paginate.js')

// 四阶段：前三个在本页跑，生成 PDF 在 P6
const STAGE_NAMES = ['读取图片', '分析分页', '排版分页', '生成 PDF']
const STAGE_TEXT = ['正在读取图片…', '正在分析分页位置…', '正在排版分页…', '正在生成 PDF…']

// 进度达到该比例才允许停止并保留已排页数
const STOP_KEEP_RATIO = 0.40

// 分段建议的每段行数
const SPLIT_LIMIT = 20000

const KEY_HINT = 'p3HintShown'

Page({
  data: {
    stageNames: STAGE_NAMES,
    stageText: STAGE_TEXT[0],
    stage: 0,
    pct: 0,
    canStop: false,
    slow: false,
    slowText: '',
    phase: 'run',          // run | error | stopped
    degraded: false,
    errTitle: '',
    errSub: '',
    // 停止态
    donePages: 0,
    estTotal: 0,
    // 分段处理
    splitOpen: false,
    splitCount: 2,
    splitNow: '',
    splitMulti: false,
    splitPic: 0,
    splitKeep: 0,
    splitRest: 0,
    // 首次提示
    hint: false,
  },

  onLoad(options) {
    this.ctl = { cancelled: false }
    this.pctShown = -1
    this.scannedRows = 0
    this.resumeToken = (options && options.resume) ? options.resume : ''

    // 600ms 后才允许点停止，防误触
    this.stopTimer = setTimeout(() => this.setData({ canStop: true }), 600)
    // 超过 8s 显示长耗时提示
    this.slowTimer = setTimeout(() => {
      this.setData({ slow: true })
      this.refreshSlow()
    }, 8000)

    this.showFirstHint()
    this.start()
  },

  // 首次进入显示一行提示，12s 后收起
  showFirstHint() {
    if (store.get(KEY_HINT, 0)) return
    store.set(KEY_HINT, 1)
    this.setData({ hint: true })
    this.hintTimer = setTimeout(() => this.setData({ hint: false }), 12000)
  },

  onUnload() {
    this.clearTimers()
    if (this.ctl) this.ctl.cancelled = true
  },

  clearTimers() {
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null }
    if (this.slowTimer) { clearTimeout(this.slowTimer); this.slowTimer = null }
    if (this.hintTimer) { clearTimeout(this.hintTimer); this.hintTimer = null }
  },

  start() {
    const job = store.get(store.KEY_JOB, {})
    const images = job.images && job.images.length ? job.images : (job.img ? [{ path: job.img }] : [])
    if (!images.length) {
      wx.redirectTo({ url: '/pages/home/index' })
      return
    }
    const setting = store.get(store.KEY_SETTING, paper.DEFAULTS)
    this.setting = setting
    this.planCap = paper.capacity(job.w || images[0].width || 1080, setting)
    this.imgH = job.h || 0
    this.onePerPage = !!job.onePerPage

    this.setData({ phase: 'run', stage: 0, stageText: STAGE_TEXT[0], pct: 0, slow: false, degraded: !!job.degraded })
    this.pctShown = -1
    this.scannedRows = 0
    this.retryTimes = 0

    // 有续扫令牌时沿用上次的扫描结果
    const resume = this.resumeToken ? imageJob.takeResume(this.resumeToken) : null
    this.resumeToken = ''
    if (resume) {
      this.imgH = resume.height
      this.setData({ pct: Math.round(resume.scanned / Math.max(1, resume.height) * 100) })
    }

    imageJob.run(
      {
        images: images.map((it) => ({ path: it.path, width: it.width, height: it.height, size: it.size })),
        setting: setting,
        page: this,
        onePerPage: this.onePerPage,
        resume: resume,
      },
      {
        onProgress: (stage, pct, extra) => this.onProgress(stage, pct, extra),
        onStage: (stage) => {
          if (this.data.phase !== 'run') return
          const tail = this.retryTimes ? '（已降低清晰度，第 ' + this.retryTimes + ' 次重试）' : ''
          this.setData({ stage: stage, stageText: (STAGE_TEXT[stage] || '') + tail })
        },
      },
      this.ctl
    )
      .then((res) => this.done(job, res))
      .catch((err) => this.onError(err, job))
  },

  // 进度回调：整数百分比才刷新
  onProgress(stage, pct, extra) {
    if (extra && typeof extra.rows === 'number') this.scannedRows = extra.rows
    if (extra && typeof extra.height === 'number' && extra.height) this.imgH = extra.height
    if (extra && extra.retry) {
      this.retryTimes = extra.retry
      this.setData({
        stageText: '正在降低清晰度重试（第 ' + extra.retry + ' 次）',
        slow: false,
      })
    }
    const n = Math.round(pct * 100)
    if (n !== this.pctShown) {
      this.pctShown = n
      this.setData({ pct: n })
    }
    if (this.data.slow) this.refreshSlow()
  },

  // 估算已完成页数
  refreshSlow() {
    const cap = this.planCap || 1
    const done = this.scannedRows ? Math.floor(this.scannedRows / cap) : 0
    const total = this.imgH ? Math.ceil(this.imgH / cap) : 0
    this.setData({ slowText: '内容较长，请稍候（已完成 ' + done + '/' + total + ' 页）' })
  },

  // 完成：写入分页结果并跳预览
  done(job, res) {
    this.clearTimers()
    if (this.ctl.cancelled) return
    const next = Object.assign({}, job, {
      pages: res.pages,
      cap: res.cap,
      imgW: res.width,
      imgH: res.height,
      blocks: res.blocks,
      stats: res.stats,
      degraded: res.degraded,
      lowContrast: res.lowContrast,
      stampCount: res.stampCount || 0,
      sources: res.sources,
      breaks: res.breaks,
      scaledK: res.scaledK,
      memWarn: res.memWarn || 0,
      ms: res.ms,
      setting: res.setting,
      partial: null,
      partialToken: '',
    })
    store.set(store.KEY_JOB, next)
    this.setData({ pct: 100 })
    // 留一帧让 100% 显示
    setTimeout(() => {
      if (!this.ctl.cancelled) wx.redirectTo({ url: '/pages/preview/index' })
    }, 180)
  },

  // 停止：已扫比例够高则保留已排页数，否则回上一页
  onStop() {
    if (!this.data.canStop || this.data.phase !== 'run') return
    this.ctl.cancelled = true
    this.clearTimers()

    const partial = this.ctl.partial
    const scanned = (partial && partial.scanned) || 0
    const h = (partial && partial.height) || this.imgH || 0
    const ratio = h ? scanned / h : 0
    if (!partial || ratio < STOP_KEEP_RATIO) {
      wx.showToast({ title: '已停止，参数都还在', icon: 'none' })
      setTimeout(() => wx.navigateBack({ delta: 1 }), 320)
      return
    }
    this.enterStopped(partial)
  },

  // 用已扫部分跑一次分页，进入停止态
  enterStopped(partial) {
    const cap = this.planCap || 1
    let pages = []
    try {
      const r = paginate.plan(partial.scan, partial.scanned, cap, {
        breaks: partial.breaks || [],
        onePerPage: this.onePerPage,
      })
      pages = r.pages
    } catch (raw) {
      pages = paginate.evenSplit(partial.scanned, cap).pages
    }
    // 末页切点还会被后续行改写，只取已定的部分
    const settled = pages.slice(0, Math.max(0, pages.length - 1))
    if (!settled.length) {
      wx.showToast({ title: '已停止，参数都还在', icon: 'none' })
      setTimeout(() => wx.navigateBack({ delta: 1 }), 320)
      return
    }
    const estTotal = Math.max(settled.length, Math.ceil((partial.height || this.imgH) / cap))
    const token = 'pk' + Date.now()
    imageJob.stashResume(token, partial)

    this.setData({
      phase: 'stopped',
      donePages: settled.length,
      estTotal: estTotal,
      stage: 2,
      stageText: STAGE_TEXT[2],
    })
    this.settled = settled
    this.token = token
  },

  // 查看已排好的页
  onViewPages() {
    if (!this.settled) return
    const job = store.get(store.KEY_JOB, {})
    const next = Object.assign({}, job, {
      pages: this.settled.map((p, i) => ({ index: i + 1, from: p.from, to: p.to, h: p.to - p.from })),
      cap: this.planCap,
      imgW: (this.ctl.partial && this.ctl.partial.width) || job.imgW,
      imgH: (this.ctl.partial && this.ctl.partial.height) || job.imgH,
      blocks: [],
      sources: (this.ctl.partial && this.ctl.partial.sources) || job.sources,
      breaks: (this.ctl.partial && this.ctl.partial.breaks) || job.breaks,
      scaledK: (this.ctl.partial && this.ctl.partial.scaledK) || job.scaledK || 1,
      setting: this.setting,
      partial: { done: this.settled.length, est: this.data.estTotal },
      partialToken: this.token,
    })
    store.set(store.KEY_JOB, next)
    wx.redirectTo({ url: '/pages/preview/index' })
  },

  onBackPaper() { wx.navigateBack({ delta: 1 }) },

  // 失败：按错误码给文案与诊断快照
  onError(err, job) {
    this.clearTimers()
    const code = (err && err.code) || 'UNKNOWN'
    if (code === 'CANCELLED') return
    if (this.ctl.cancelled) return

    const h = (err && err.height) || this.imgH || 0
    const count = Math.max(2, h ? Math.ceil(h / SPLIT_LIMIT) : 2)
    const picCount = (err && err.count) || 1
    const canSplit = code === 'MEMORY' || code === 'DRAW_FAILED'
    const splitMulti = canSplit && picCount > 1
    const keep = splitMulti ? Math.ceil(picCount / 2) : 0
    const tried = (err && err.tried) || []
    const triedText = tried.length
      ? '已经压到 ' + Math.round(tried[tried.length - 1] * 100) + '% 重试过，还是不行。'
      : ''

    let title = '这张图太大，本机内存不够'
    let sub = '已选图和纸张都还在。'
    if (code === 'READ_FAILED' || code === 'NO_SIZE' || code === 'DECODE_FAILED') {
      title = err.index ? '第 ' + err.index + ' 张图没能读进来' : '图片没能读进来'
      sub = '已选图和纸张都还在，可以重试一次；还不行就删掉那一张再生成。'
    } else if (code === 'MEMORY') {
      title = '内存不够，压缩后还是处理不完'
      sub = triedText + '已选图和纸张都还在，可以少选几张、或者先裁掉不需要的部分。'
    } else if (code === 'DRAW_FAILED') {
      if (err && err.shrunk) {
        title = err.index ? '第 ' + err.index + ' 张图有一截画不出来' : '这张图有一截画不出来'
        sub = '已经降过清晰度重试过一次，还是不行。可以在相册里把这张图裁成两半，'
          + '或者换成原图重新保存一次再选。'
      } else {
        title = '这张图太大，本机画不出来'
        sub = triedText + '已选图和纸张都还在，可以重试一次。'
      }
    }
    this.setData({
      phase: 'error', errTitle: title, errSub: sub,
      canSplit: canSplit, splitCount: count,
      splitMulti: splitMulti, splitPic: picCount, splitKeep: keep, splitRest: picCount - keep,
      splitNow: '在相册里把这张长图裁成 ' + count + ' 段（每段不超过 ' + SPLIT_LIMIT + 'px 高）',
    })
  },

  onSplit() { this.setData({ splitOpen: true }) },
  onSplitClose() { this.setData({ splitOpen: false }) },
  noop() {},

  // 分段处理：多图时先留一部分再回首页选图
  onSplitPick() {
    this.setData({ splitOpen: false })
    if (this.data.splitMulti && this.data.splitKeep > 0) {
      const job = store.get(store.KEY_JOB, {})
      const list = (job.images || []).slice(0, this.data.splitKeep)
      const w = list.reduce((m, x) => Math.max(m, x.width || 0), 0)
      const h = list.reduce((s, x) => s + (x.height || 0), 0)
      const next = Object.assign({}, job, { images: list, w: w, h: h })
      delete next.pages          // 首页见到 pages 就不恢复已选
      store.set(store.KEY_JOB, next)
      wx.showToast({ title: '先留了前 ' + list.length + ' 张', icon: 'none' })
    }
    wx.reLaunch({ url: '/pages/home/index?split=1' })
  },

  // 重试
  onRetry() {
    if (this.retrying) return
    this.retrying = true
    this.ctl = { cancelled: false }
    this.pctShown = -1
    this.scannedRows = 0
    this.retryTimes = 0
    this.setData({ phase: 'run', stage: 0, stageText: STAGE_TEXT[0], pct: 0, slow: false, canStop: true })
    this.slowTimer = setTimeout(() => { this.setData({ slow: true }); this.refreshSlow() }, 8000)
    this.start()
    setTimeout(() => { this.retrying = false }, 500)
  },

  onBackHome() {
    wx.navigateBack({ delta: 2, fail: () => wx.reLaunch({ url: '/pages/home/index' }) })
  },

  onShareAppMessage() {
    return {
      title: '长截图一键分页转 PDF，打印清晰不糊',
      path: '/pages/home/index',
      imageUrl: '/assets/home/hero.png',
    }
  },
})
