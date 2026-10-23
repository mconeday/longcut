const store = require('../../utils/store.js')
const cutsUtil = require('../../utils/cuts.js')
const srcUtil = require('../../utils/sources.js')
const nav = require('../../utils/nav.js')

// P5 微调分页：拖动吸附改切点，按钮按块移动，共用撤销栈
// 切点位置统一存原图像素，渲染时才乘 scale

const TIP_DEFAULT = '上下滑动看图，拖动蓝色抓手改切点'
const SNAP_RADIUS = 30      // 吸附半径（原图像素）
const UNDO_MAX = 5          // 撤销栈深度
const LONG_PRESS_MS = 500   // 长按首触延迟
const REPEAT_MS = 400       // 连发间隔
const MIN_BAND = 4          // 空白带阈值，与算法同参
const MIN_PAGE = 40         // 最小页高（原图像素）

function hintText(reason, dir) {
  if (reason === 'content') return '⊘ 这里不能切'
  if (reason === 'top') return '⤒ 已到图的最上面'
  if (reason === 'bottom') return '⤓ 已到图的最下面'
  return dir < 0 ? '⤒ 已到上一处切点' : '⤓ 已到下一处切点'
}

Page({
  data: {
    tip: TIP_DEFAULT,
    tipWarn: false,          // 边界提示换色
    pageCount: 0,
    pics: [],                // 长图由 N 张源图铺成
    imgHCss: 0,
    zones: [],               // 禁切区
    bands: [],               // 切口带
    ticks: [],               // 刻度切点
    mode: 'default',         // default 浏览态 | edit 选中态
    sel: -1,
    dangerIdx: -1,           // 落点在内容里的切口
    canUp: true,
    canDown: true,
    canUndo: false,
  },

  onLoad() {
    this.setData(nav.metrics())
    const job = store.get(store.KEY_JOB, {})
    const pages = job.pages || []
    const sources = srcUtil.fromJob(job)
    if (!pages.length || !sources.length) {
      wx.redirectTo({ url: '/pages/preview/index' })
      return
    }
    this.job = job
    this.sources = sources
    this.imgH = job.imgH || pages[pages.length - 1].to
    this.imgW = job.imgW || 1080
    this.blocks = cutsUtil.decodeBlocks(job.blocks)
    this.gaps = cutsUtil.gapsFromBlocks(this.blocks, this.imgH, MIN_BAND)
    this.cuts = pages.slice(0, -1).map((p) => p.to)
    // forced 切点本身在内容里，允许在内容内微调
    this.forced = this.cuts.map((y) => !cutsUtil.inGap(y, this.gaps))
    this.undoStack = cutsUtil.createUndo(UNDO_MAX)
    this.origCount = this.cuts.length + 1
    this.dirty = false
    this.scrollTop = 0
    this.viewH = 500
    this.scale = this.computeScale()
    this.buildView()
    this.measureStage()
  },

  // 量取视口高度
  measureStage() {
    if (!wx.createSelectorQuery) return
    wx.createSelectorQuery()
      .in(this)
      .select('.stage')
      .boundingClientRect((r) => { if (r && r.height) this.viewH = r.height })
      .exec()
  },

  // 当前操作的切口：选中态优先，否则取离屏幕中心最近的一条
  activeIndex() {
    if (!this.cuts.length) return -1
    if (this.data.sel >= 0) return this.data.sel
    const center = (this.scrollTop || 0) + this.viewH / 2
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < this.cuts.length; i++) {
      const d = Math.abs(this.cuts[i] * this.scale - center)
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  },

  onScroll(e) {
    const top = e.detail.scrollTop || 0
    this.scrollTop = top
    // 最近切口变化时才重排
    const next = this.activeIndex()
    if (next !== this.activeRendered) this.buildView()
  },

  onShow() {
    // 有改动时拦截系统返回
    if (this.dirty && wx.enableAlertBeforeUnload) {
      try {
        wx.enableAlertBeforeUnload({
          message: '放弃这次的调整？放弃后分页会恢复成原来的 ' + this.origCount + ' 页',
        })
      } catch (raw) {}
    }
  },

  computeScale() {
    let winW = 375
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      winW = (info && info.windowWidth) || 375
    } catch (raw) {}
    return (winW * 670 / 750) / this.imgW
  },

  // 重算铺图、禁切区、切口带与刻度
  buildView() {
    const s = this.scale
    // 禁切区只画看得见的部分
    const zones = []
    const bs = this.blocks
    for (let i = 0; i < bs.length && zones.length < 600; i++) {
      const h = (bs[i].bottom - bs[i].top) * s
      if (h >= 3) zones.push({ y: Math.round(bs[i].top * s), h: Math.round(h) })
    }
    const active = this.activeIndex()
    this.activeRendered = active
    // 每张图的高用两条边的取整差，避免拼接处白缝
    const pics = this.sources.map((x) => {
      const top = Math.round(x.top * s)
      const bottom = Math.round((x.top + x.sh) * s)
      return { path: x.path, top: top, h: Math.max(1, bottom - top) }
    })
    const bands = cutsUtil.bandLayout(this.cuts, this.gaps, s, active, this.imgH)
      .map((b, i) => ({
        y: b.y,
        top: b.top,
        bh: b.bh,
        mini: b.mini,
        lineOnly: b.lineOnly,
        label: '第' + (i + 2) + '页',
      }))
    this.setData({
      pics: pics,
      imgHCss: Math.round(this.imgH * s),
      pageCount: this.realPageCount(),
      zones: zones,
      bands: bands,
      ticks: this.cuts.map((y) => ({ y: Math.round(y * s) })),
    })
  },

  // 选中一条切口
  select(i) {
    if (this.data.mode === 'edit' && this.data.sel === i) return
    clearTimeout(this.hintTimer)
    this.setData({
      mode: 'edit',
      sel: i,
      tipWarn: false,
      tip: '正在调整第 ' + (i + 2) + ' 页的分页位置 · 每次跨一条消息',
    })
    this.buildView()
    this.refreshButtons()
  },

  exitEdit() {
    clearTimeout(this.hintTimer)
    this.setData({ mode: 'default', sel: -1, tip: TIP_DEFAULT, tipWarn: false })
    this.buildView()
  },

  onFinishAdjust() { this.exitEdit() },
  onStageTap() { if (this.data.mode === 'edit') this.exitEdit() },
  noop() {},

  // 拖动开始
  onBandTouchStart(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (!(i >= 0) || !(i < this.cuts.length)) return
    this.select(i)
    this.drag = {
      i: i,
      startY: e.touches[0].clientY,
      startCut: this.cuts[i],
      preview: null,
      orig: this.cuts.slice(),
      bounds: cutsUtil.boundsFor(this.cuts, i, this.imgH, MIN_PAGE),
    }
  },

  // 拖动中：只夹边界，松手才判落点
  onBandTouchMove(e) {
    const d = this.drag
    if (!d) return
    const dy = e.touches[0].clientY - d.startY
    d.preview = cutsUtil.clampCut(d.startCut + dy / this.scale, d.bounds.lo, d.bounds.hi)
    this.previewCut(d.i, d.preview)
    // 落点进内容时切红
    const danger = !cutsUtil.inGap(d.preview, this.gaps)
    const want = danger ? d.i : -1
    if (this.data.dangerIdx !== want) this.setData({ dangerIdx: want })
  },

  // 拖动结束：吸附、保留或回弹
  onBandTouchEnd() {
    const d = this.drag
    this.drag = null
    if (!d) return
    if (this.data.dangerIdx !== -1) this.setData({ dangerIdx: -1 })
    const candidate = d.preview != null ? d.preview : d.startCut
    const res = cutsUtil.landDrag(d.startCut, candidate, d.bounds.lo, d.bounds.hi, this.gaps, SNAP_RADIUS)
    this.cuts[d.i] = res.cut
    this.previewCut(d.i, res.cut)
    if (Math.round(res.cut) !== Math.round(d.startCut)) {
      this.undoStack.push(d.orig)
      this.dirty = true
      this.setData({ canUndo: true, pageCount: this.realPageCount() })
      if (res.snapped) this.vibrate()
    }
    if (!res.ok) {
      this.flashHint('⊘ 这里不能切')
      this.vibrate('heavy')
    }
    this.refreshButtons()
  },

  // 按钮按下，长按后连发
  onNavTouchStart(e) {
    if (this.data.mode !== 'edit' || this.data.sel < 0) return
    const dir = Number(e.currentTarget.dataset.dir)
    const s = this.btn = {
      dir: dir,
      orig: this.cuts.slice(),
      moved: false,
      hinted: false,
      timer: null,
      interval: null,
    }
    this.doStep(dir, false)
    s.timer = setTimeout(() => {
      s.interval = setInterval(() => this.doStep(s.dir, true), REPEAT_MS)
    }, LONG_PRESS_MS)
  },

  // 按钮抬起，一次按压记一条撤销
  onNavTouchEnd() {
    const s = this.btn
    this.btn = null
    if (!s) return
    if (s.timer) clearTimeout(s.timer)
    if (s.interval) clearInterval(s.interval)
    if (s.moved) {
      this.undoStack.push(s.orig)
      this.dirty = true
      this.setData({ canUndo: true, pageCount: this.realPageCount() })
    }
  },

  // 按块移动一次
  doStep(dir, repeating) {
    const s = this.btn
    if (!s) return
    const i = this.data.sel
    if (i < 0) return
    const b = cutsUtil.boundsFor(this.cuts, i, this.imgH, MIN_PAGE)
    const res = cutsUtil.jump(this.cuts[i], dir, b.lo, b.hi, this.gaps, {
      loEdge: b.lo === 0,
      hiEdge: b.hi === this.imgH,
    })
    if (!res.ok) {
      if (s.interval) clearInterval(s.interval)
      s.interval = null
      if (!s.hinted) {
        s.hinted = true
        this.flashHint(hintText(res.reason, dir))
        this.vibrate()
      }
      return
    }
    if (!s.moved) { s.moved = true; this.vibrate() }
    this.cuts[i] = res.cut
    this.previewCut(i, res.cut)
    this.refreshButtons()
  },

  // 拖动中的即时反馈
  previewCut(i, yImg) {
    const y = Math.round(yImg * this.scale)
    const patch = {}
    patch['bands[' + i + '].y'] = y
    patch['bands[' + i + '].top'] = y - 22
    patch['ticks[' + i + '].y'] = y
    this.setData(patch)
  },

  // 更新上下按钮可用态
  refreshButtons() {
    const i = this.data.sel
    if (i < 0) return
    const b = cutsUtil.boundsFor(this.cuts, i, this.imgH, MIN_PAGE)
    const up = cutsUtil.jump(this.cuts[i], -1, b.lo, b.hi, this.gaps, {
      loEdge: b.lo === 0, hiEdge: b.hi === this.imgH,
    })
    const down = cutsUtil.jump(this.cuts[i], 1, b.lo, b.hi, this.gaps, {
      loEdge: b.lo === 0, hiEdge: b.hi === this.imgH,
    })
    this.setData({ canUp: up.ok, canDown: down.ok })
  },

  // 提示条临时换文案，2s 后复原
  flashHint(text) {
    clearTimeout(this.hintTimer)
    this.setData({ tip: text, tipWarn: true })
    this.hintTimer = setTimeout(() => {
      const i = this.data.sel
      this.setData({
        tip: i >= 0
          ? '正在调整第 ' + (i + 2) + ' 页的分页位置 · 每次跨一条消息'
          : TIP_DEFAULT,
        tipWarn: false,
      })
    }, 2000)
  },

  onUndo() {
    const prev = this.undoStack.undo()
    if (!prev) return
    this.cuts = prev
    this.dirty = true
    this.buildView()
    this.setData({ canUndo: this.undoStack.size() > 0 })
    this.refreshButtons()
  },

  vibrate(type) {
    try { wx.vibrateShort({ type: type || 'light' }) } catch (raw) {}
  },

  // 与导出同口径的真实页数
  realPageCount() {
    return cutsUtil.pagesFromCuts(this.cuts, this.imgH, {
      minPage: MIN_PAGE,
      blocks: this.blocks,
    }).length
  },

  // 应用切点，回 P4
  onUsePages() {
    const pages = cutsUtil.pagesFromCuts(this.cuts, this.imgH, {
      minPage: MIN_PAGE,
      blocks: this.blocks,
    })
    const job = Object.assign({}, this.job, {
      pages: pages,
      cuts: this.cuts.map((y) => ({ y: y, forced: !cutsUtil.inGap(y, this.gaps) })),
    })
    store.set(store.KEY_JOB, job)
    try { if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload() } catch (raw) {}
    wx.navigateBack()
  },

  onUnload() {
    try { if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload() } catch (raw) {}
  },

  onShareAppMessage() {
    return {
      title: '长截图一键分页转 PDF，打印清晰不糊',
      path: '/pages/home/index',
      imageUrl: '/assets/home/hero.png',
    }
  },
})
