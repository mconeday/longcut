const store = require('../../utils/store.js')
const paper = require('../../utils/paper.js')

// P2 纸张设置：纸张比例、预计页数、尺寸标注同步刷新
const KEY_FOLD = 'p2Folded'
const MINI_W = 300              // rpx：纸形宽上限
const MINI_H_MAX = 424          // rpx：纸形高上限
const MINI_FOLD_H = 152         // rpx：折叠态纸形高
const SEAM_INSET = 2            // rpx：缝隙离纸边的距离
const JPEG_BYTES_PER_PX = 0.5   // 单页体积估算
const AMBER_PAGES = 30          // 超过则折叠提示

Page({
  data: {
    specs: paper.SPECS,
    setting: Object.assign({}, paper.DEFAULTS),
    contentW: 190,
    contentH: 277,
    pages: 0,

    // 纸张卡
    paperW: 0,
    paperH: 0,
    padRpx: 0,
    caption: '',
    paperName: '',
    paperSize: '',
    folded: false,
    estText: '0',

    // 多图
    multi: false,
    seams: [],
    seamNote: '',
    perImage: false,
    showSwitch: false,
    switchNote: '',
    degraded: false,

    // 状态提示
    short: false,
    tooMany: false,
    tooManyText: '',
    hintText: '',
    hintWarn: false,
    noSize: false,
    btnText: '生成预览',
  },

  onLoad() {
    const s = store.get(store.KEY_SETTING, null)
    const folded = store.get(KEY_FOLD, false) === true
    const job = store.get(store.KEY_JOB, {})
    this.setData({
      setting: Object.assign({}, paper.DEFAULTS, s || {}),
      folded: folded,
      perImage: !!job.onePerPage,
    })
    this.refresh()
  },

  onShow() {
    this.refresh()
  },

  // 重算纸形、页数、提示文案
  refresh() {
    const setting = this.data.setting
    const res = paper.resolve(setting)
    const job = store.get(store.KEY_JOB, {})
    const images = (job.images && job.images.length)
      ? job.images
      : (job.img ? [{ path: job.img, width: job.imgW, height: job.h }] : [])
    const w = job.w || (images[0] && images[0].width) || 1080
    const totalH = job.h || 0
    const cap = paper.capacity(w, setting)

    const multi = images.length >= 2
    const perImage = multi && !!this.data.perImage
    // 预计页数
    const pages = totalH
      ? (perImage
        ? images.reduce((n, x) => n + Math.max(1, Math.ceil((x.height || 0) / cap)), 0)
        : Math.max(1, Math.ceil(totalH / cap)))
      : 0

    const ratio = res.ratio
    let paperH
    let paperW
    if (this.data.folded) {
      paperH = MINI_FOLD_H
      paperW = Math.round(paperH / ratio)
    } else {
      paperH = Math.min(MINI_W * ratio, MINI_H_MAX)
      paperW = paperH / ratio
      if (paperW > MINI_W) { paperW = MINI_W; paperH = paperW * ratio }
      paperH = Math.round(paperH)
      paperW = Math.round(paperW)
    }
    const padRpx = Math.round(res.margin / res.mmW * paperW)

    // 拼接缝位置按累计高度映射到内容区
    const seams = []
    if (multi && totalH > 0) {
      const contentH = Math.max(1, paperH - padRpx * 2)
      let cum = 0
      for (let i = 0; i < images.length - 1; i++) {
        cum += images[i].height || 0
        const top = Math.round(Math.min(
          Math.max(cum / totalH * contentH, SEAM_INSET),
          contentH - SEAM_INSET
        ))
        seams.push(top)
      }
    }

    const tight = res.margin >= 25 || res.contentWmm < 100
    const perPagePx = cap * w
    const mb = Math.max(0.1, Math.round(perPagePx * JPEG_BYTES_PER_PX / 1024 / 1024 * 10) / 10)
    const noSize = totalH === 0
    const short = !multi && !noSize && totalH <= cap && !this.data.shortSplit

    this.setData({
      contentW: res.contentWmm,
      contentH: res.contentHmm,
      pages,
      paperW,
      paperH,
      padRpx,
      caption: res.name + ' · ' + res.mmW + '×' + res.mmH + 'mm · '
        + (res.landscape ? '横向' : '纵向') + ' · 边距' + res.margin + 'mm',
      paperName: res.name,
      paperSize: res.mmW + '×' + res.mmH + ' mm',
      estText: noSize ? '—' : String(pages),
      multi,
      seams,
      seamNote: multi ? images.length + ' 张图拼接 · 跨图处会自动切分' : '',
      perImage,
      showSwitch: multi && images.some((x) => (x.height || 0) < cap),
      switchNote: perImage ? '已按每图一页排版，共 ' + pages + ' 页' : '',
      degraded: !!job.degraded,
      short,
      tooMany: !short && pages > AMBER_PAGES,
      tooManyText: '内容较长，共 ' + pages + ' 页。建议先看分页效果，再决定要不要换 A5',
      hintWarn: tight,
      hintText: tight
        ? '边距较大，正文可能变小，建议 10–15mm'
        : '内容区 ' + res.contentWmm + '×' + res.contentHmm + 'mm · 单页约 ' + mb + 'MB',
      noSize,
      btnText: short ? '生成 PDF' : '生成预览',
    })

    store.set(store.KEY_SETTING, setting)
    this.writeJob(perImage)
  },

  // 只同步每图一页开关，不写页边界
  writeJob(perImage) {
    const job = store.get(store.KEY_JOB, {})
    if (!job || (!job.images && !job.img)) return
    if (job.onePerPage === perImage) return
    job.onePerPage = perImage
    store.set(store.KEY_JOB, job)
  },

  onPaper(e) { this.setData({ 'setting.paper': e.currentTarget.dataset.key }); this.refresh() },
  onOrient(e) { this.setData({ 'setting.landscape': e.currentTarget.dataset.v === '1' }); this.refresh() },
  onMargin(e) { this.setData({ 'setting.margin': Number(e.detail.value) }); this.refresh() },
  onQuick(e) { this.setData({ 'setting.margin': Number(e.currentTarget.dataset.v) }); this.refresh() },

  // 折叠或展开纸张卡
  onFold() {
    const folded = !this.data.folded
    this.setData({ folded })
    store.set(KEY_FOLD, folded)
    this.refresh()
  },

  onSwitch() {
    this.setData({ perImage: !this.data.perImage })
    this.refresh()
  },

  // 超短图改为仍然分页
  onShortSplit() {
    this.setData({ shortSplit: true })
    this.refresh()
  },

  onNext() {
    if (this.data.noSize) {
      wx.showToast({ title: '读不到这张图的尺寸', icon: 'none' })
      return
    }
    this.writeJob(this.data.perImage)
    // navigateTo：P3 的返回依赖 navigateBack
    wx.navigateTo({ url: '/pages/process/index' })
  },

  onShareAppMessage() {
    return {
      title: '长截图一键分页转 PDF，打印清晰不糊',
      path: '/pages/home/index',
      imageUrl: '/assets/home/hero.png',
    }
  },
})
