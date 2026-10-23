const store = require('../../utils/store.js')
const src = require('../../utils/sources.js')
const nav = require('../../utils/nav.js')

// P4 预览：按页裁一段虚拟长图画到 canvas，含缩略条
const THUMB_W_RPX = 80      // 40px
const THUMB_H_RPX = 112     // 56px
const THUMB_GAP_RPX = 8     // 4px
const THUMB_PITCH_RPX = THUMB_W_RPX + THUMB_GAP_RPX

const KEY_AUTH = 'authHintCount'   // 前 2 次进 P4 才提示
const AUTH_MAX = 2

function winWidth() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    return (info && info.windowWidth) || 375
  } catch (raw) { return 375 }
}

function pixelRatio() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    return (info && info.pixelRatio) || 1
  } catch (raw) {
    return 1
  }
}
const DPR = pixelRatio()

Page({
  data: {
    total: 0,
    cur: 1,
    degraded: false,
    scaledK: 1,
    scaledPercent: 100,
    memWarn: 0,
    tcW: 10,                // 离屏缩略画布的 CSS 尺寸
    tcH: 10,
    amberClosed: false,
    tooMany: false,
    drawState: 'idle',      // idle | loading | ok | fail
    leaving: false,         // 离场遮罩
    hasBack: true,
    paperH: 0,              // 纸面高度，0 用 CSS 默认
    // 缩略条
    strip: '',
    stripW: 0,
    thumbH: 0,
    pitch: 0,
    useNums: false,         // 页数太多时退回页码
    thumbs: [],
    authHint: false,
    lowContrast: false,
    stampCount: 0,
    partial: null,
  },

  onLoad() {
    this.setData(nav.metrics())
    this.seq = 0
    this.node = null
    this.imgs = {}          // path -> image（纸面画布）
    this.thumbImgs = {}     // path -> image（缩略条画布）
    this.loading = {}
    this.ready = false
    this.thumbDone = false
  },

  onReady() {
    this.ready = true
    this.paint()
    setTimeout(() => this.layoutPaper(), 80)
  },

  onShow() {
    if (this.data.leaving) this.setData({ leaving: false })
    this.setData({ hasBack: (typeof getCurrentPages === 'function') ? getCurrentPages().length > 1 : true })
    const job = store.get(store.KEY_JOB, {})
    const pages = job.pages || []
    if (!pages.length) {
      wx.redirectTo({ url: '/pages/home/index' })
      return
    }
    this.job = job
    this.pages = pages
    this.sources = src.fromJob(job)
    const total = pages.length
    const auth = this.checkAuthHint()
    const sk = Number(job.scaledK) || 1
    this.setData({
      total,
      cur: Math.min(Math.max(1, this.data.cur), total),
      degraded: !!job.degraded,
      scaledK: sk,
      scaledPercent: Math.round(sk * 100),
      memWarn: Number(job.memWarn) || 0,
      lowContrast: !!job.lowContrast,
      stampCount: Number(job.stampCount) || 0,
      tooMany: total > 30,
      partial: job.partial || null,
      authHint: auth,
    })
    this.planThumbs(total)
    this.paint()
    setTimeout(() => this.layoutPaper(), 80)
  },

  // 按剩余空间算纸高
  layoutPaper() {
    if (!this.ready) return
    try {
      wx.createSelectorQuery()
        .in(this)
        .select('.stage')
        .boundingClientRect()
        .select('.paper-wrap')
        .boundingClientRect()
        .exec((res) => {
          const stage = res && res[0]
          const wrap = res && res[1]
          if (!stage || !wrap || stage.bottom == null || wrap.top == null) return
          const h = Math.round(stage.bottom - wrap.top - 32)
          if (h < 240 || Math.abs(h - (this.data.paperH || 0)) <= 1) return
          this.setData({ paperH: h }, () => {
            this.node = null
            this.paint()
          })
        })
    } catch (raw) {}
  },

  // 前两次进 P4 显示授权提示
  checkAuthHint() {
    const n = store.get(KEY_AUTH, 0) || 0
    if (n >= AUTH_MAX) return false
    store.set(KEY_AUTH, n + 1)
    return true
  },

  onUnload() {
    this.seq++
    this.imgs = {}
    this.thumbImgs = {}
    this.loading = {}
    this.node = null
  },

  // 计算缩略条尺寸，必要时退回页码
  planThumbs(total) {
    const u = winWidth() / 750
    const pitch = THUMB_PITCH_RPX * u
    const thumbW = THUMB_W_RPX * u
    const thumbH = THUMB_H_RPX * u
    const stripW = total * pitch - (THUMB_GAP_RPX * u)
    // 整条超出画布单边上限则用页码
    if (stripW > 4000) {
      this.setData({
        useNums: true, strip: '', stripW: 0, thumbH: 0, pitch: 0,
        thumbs: this.pages.map((p, i) => i),
      })
      return
    }
    const same = this.data.stripW === Math.round(stripW) && this.data.pitch === Math.round(pitch)
    // 页边界变化也要重画整条
    const sig = this.pages.map((p) => p.from + '-' + p.to).join(',')
    const pagesChanged = this.thumbSig !== sig
    this.thumbSig = sig
    const patch = {
      useNums: false,
      stripW: Math.round(stripW),
      thumbH: Math.round(thumbH),
      pitch: Math.round(pitch),
      thumbW: Math.round(thumbW),
      tcW: Math.max(10, Math.round(stripW)),
      tcH: Math.max(10, Math.round(thumbH)),
      thumbs: this.pages.map((p, i) => i),
    }
    this.setData(patch)
    if (!same || pagesChanged) {
      this.thumbDone = false
      this.setData({ strip: '' })
    }
    if (!this.data.strip && !this.thumbDone) this.buildThumbs(total)
  },

  // 画整条缩略图并导出一次
  buildThumbs(total) {
    if (this.thumbDone || this.thumbBuilding) return
    this.thumbBuilding = true
    const u = winWidth() / 750
    const pitch = THUMB_PITCH_RPX * u
    const thumbW = THUMB_W_RPX * u
    const thumbH = THUMB_H_RPX * u
    const cssW = Math.round(this.data.stripW)
    const cssH = Math.round(thumbH)
    const scale = Math.min(DPR, Math.max(1, 4000 / cssW))
    this.getThumbCanvas()
      .then((node) => {
        node.width = Math.max(1, Math.round(cssW * scale))
        node.height = Math.max(1, Math.round(cssH * scale))
        const ctx = node.getContext('2d')
        ctx.fillStyle = '#FFFFFF'
        ctx.fillRect(0, 0, node.width, node.height)
        let i = 0
        const step = () => {
          if (i >= total) return Promise.resolve(node)
          const page = this.pages[i]
          const segs = src.pageSegments(this.sources, page.from, page.to)
          return Promise.all(segs.map((s) => this.img(s.src.path, node, true))).then((imgs) => {
            const x = i * pitch * scale
            const w = thumbW * scale
            const h = thumbH * scale
            const scaleFit = Math.min(w / (this.job.imgW || 1), h / Math.max(1, page.h))
            const dw = Math.round((this.job.imgW || 1) * scaleFit)
            const dh = Math.round(page.h * scaleFit)
            const dx = x + Math.round((w - dw) / 2)
            const dy = Math.round((h - dh) / 2)
            let cum = 0
            for (let k = 0; k < segs.length; k++) {
              const seg = segs[k]
              const sh = k === segs.length - 1 ? dh - cum : Math.round(seg.vH * scaleFit)
              if (sh <= 0) continue
              try {
                ctx.drawImage(imgs[k], 0, seg.sy, seg.src.w, seg.sh, dx, dy + cum, dw, sh)
              } catch (raw) {}
              cum += sh
            }
            i++
            // 已画过的源图不再保留
            this.dropThumbBefore(page.to)
            // 让出一帧，保持手势响应
            return new Promise((r) => setTimeout(r, 0)).then(step)
          })
        }
        return step()
      })
      .then((node) => this.exportStrip(node))
      .catch(() => { this.thumbBuilding = false; this.setData({ useNums: true }) })
  },

  // 导出缩略条图片
  exportStrip(node) {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: node,
        fileType: 'png',
        success: (res) => {
          this.thumbDone = true
          this.thumbBuilding = false
          this.setData({ strip: res.tempFilePath })
          resolve(res.tempFilePath)
        },
        fail: (raw) => {
          this.thumbBuilding = false
          this.setData({ useNums: true })
          reject(raw)
        },
      })
    })
  },

  // 取缩略条画布：离屏优先，老基础库退回页面节点
  getThumbCanvas() {
    if (this.thumbNode) return Promise.resolve(this.thumbNode)
    if (wx.createOffscreenCanvas) {
      try {
        const c = wx.createOffscreenCanvas({ type: '2d', width: 1, height: 1 })
        if (c && typeof c.getContext === 'function' && typeof c.createImage === 'function') {
          this.thumbNode = c
          return Promise.resolve(c)
        }
      } catch (raw) {}
    }
    this.setData({ legacyThumbCanvas: true })
    const query = (left) => new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#thumb-canvas')
        .fields({ node: true })
        .exec((res) => {
          const r = res && res[0]
          if (r && r.node) {
            this.thumbNode = r.node
            return resolve(r.node)
          }
          if (left <= 0) return reject(new Error('no thumb canvas'))
          setTimeout(() => resolve(query(left - 1)), 50)
        })
    })
    return query(3)
  },

  // 画当前页
  paint() {
    if (!this.ready) return
    const page = this.pages && this.pages[this.data.cur - 1]
    if (!page || !this.sources.length) return
    const seq = ++this.seq
    const segs = src.pageSegments(this.sources, page.from, page.to)
    if (!this.node) this.setData({ drawState: 'loading' })

    this.getCanvas()
      .then((node) => Promise.all(segs.map((s) => this.img(s.src.path, node))).then((imgs) => {
        if (seq !== this.seq) return
        const ok = this.drawPage(node, segs, imgs, page)
        this.keepOnly(segs.map((s) => s.src.path))
        this.setData({ drawState: ok ? 'ok' : 'fail' })
      }))
      .catch((raw) => {
        if (seq !== this.seq) return
        this.lastErr = raw
        this.setData({ drawState: 'fail' })
      })
  },

  // 取纸面画布，按物理像素开
  getCanvas() {
    if (this.node) return Promise.resolve(this.node)
    return new Promise((resolve, reject) => {
      if (!wx.createSelectorQuery) return reject(new Error('no selector query'))
      wx.createSelectorQuery()
        .in(this)
        .select('#page-canvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const r = res && res[0]
          if (!r || !r.node) return reject(new Error('no canvas node'))
          const node = r.node
          node.width = Math.max(1, Math.round((r.width || 260) * DPR))
          node.height = Math.max(1, Math.round((r.height || 362) * DPR))
          this.node = node
          resolve(node)
        })
    })
  },

  // 降采样时先压缩再解码，路径按源图缓存
  usableSrc(path) {
    if (!(Number(this.data.scaledK) < 1)) return Promise.resolve(path)
    this.cpaths = this.cpaths || {}
    if (this.cpaths[path]) return Promise.resolve(this.cpaths[path])
    const list = this.sources || []
    let s = null
    for (let i = 0; i < list.length; i++) if (list[i].path === path) s = list[i]
    const h = Math.max(1, Math.round((s && s.h) || 8192))
    return new Promise((resolve) => {
      wx.compressImage({
        src: path,
        quality: 90,
        compressedHeight: h,
        success: (r) => {
          this.cpaths[path] = r.tempFilePath
          resolve(r.tempFilePath)
        },
        fail: () => resolve(path),
      })
    })
  },

  // 取图片对象，按画布分开缓存
  img(path, node, forThumb) {
    const cache = forThumb ? this.thumbImgs : this.imgs
    const key = (forThumb ? 't:' : 'p:') + path
    if (cache[path]) return Promise.resolve(cache[path])
    if (this.loading[key]) return this.loading[key]
    this.loading[key] = this.usableSrc(path).then((src) => new Promise((resolve, reject) => {
      const im = node.createImage()
      im.onload = () => {
        delete this.loading[key]
        cache[path] = im
        resolve(im)
      }
      im.onerror = (raw) => {
        delete this.loading[key]
        reject(raw || new Error('decode failed'))
      }
      im.src = src
    }))
    return this.loading[key]
  },

  // 只保留本页用到的源图
  keepOnly(paths) {
    for (const k in this.imgs) {
      if (paths.indexOf(k) < 0) delete this.imgs[k]
    }
  },

  // 丢弃整张已在 y 之前的缩略源图
  dropThumbBefore(y) {
    const list = this.sources || []
    for (let i = 0; i < list.length; i++) {
      if (list[i].top + list[i].sh <= y) delete this.thumbImgs[list[i].path]
    }
  },

  // 按段绘制一页
  drawPage(node, segs, imgs, page) {
    const ctx = node.getContext('2d')
    const W = node.width
    const H = node.height
    ctx.clearRect(0, 0, W, H)
    const vW = this.job.imgW || (segs[0] && segs[0].src.w) || 1
    const vH = Math.max(1, page.h)
    if (!vW || !vH) return false
    const k = Math.min(W / vW, H / vH)
    const dw = Math.round(vW * k)
    const dh = Math.round(vH * k)
    const dx = Math.round((W - dw) / 2)
    const dy = Math.round((H - dh) / 2)
    let cum = 0
    try {
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]
        const sh = i === segs.length - 1 ? dh - cum : Math.round(seg.vH * k)
        if (sh <= 0) continue
        ctx.drawImage(imgs[i], 0, seg.sy, seg.src.w, seg.sh, dx, dy + cum, dw, sh)
        cum += sh
      }
      return true
    } catch (raw) {
      this.lastErr = raw
      return false
    }
  },

  onPrev() {
    if (this.data.cur <= 1) return
    this.setData({ cur: this.data.cur - 1 })
    this.paint()
  },
  onNext() {
    if (this.data.cur >= this.data.total) return
    this.setData({ cur: this.data.cur + 1 })
    this.paint()
  },
  // 跳到指定页，非法值忽略
  onJump(e) {
    const p = Number(e.currentTarget.dataset.p)
    if (!p || p < 1 || p > this.data.total || p === this.data.cur) return
    this.setData({ cur: p })
    this.paint()
  },
  onRepaint() {
    this.node = null
    this.imgs = {}
    this.thumbImgs = {}
    this.loading = {}
    this.paint()
  },

  // 停止态继续处理剩余页
  onContinue() {
    const t = this.job && this.job.partialToken
    if (!t) { wx.redirectTo({ url: '/pages/process/index' }); return }
    wx.redirectTo({ url: '/pages/process/index?resume=' + t })
  },

  // 离场遮罩：先盖住纸面再跳页
  leave(url, how) {
    if (this.data.leaving) return
    this.setData({ leaving: true })
    const go = () => {
      if (!this.data.leaving) return
      if (how === 'navigateTo') wx.navigateTo({ url: url })
      else if (how === 'reLaunch') wx.reLaunch({ url: url })
      else wx.redirectTo({ url: url })
    }
    if (wx.nextTick) wx.nextTick(go)
    else setTimeout(go, 0)
  },

  // 进 P5 用 navigateTo，P5 返回依赖 navigateBack
  onAdjust() { this.leave('/pages/adjust/index', 'navigateTo') },

  // 进 P6 用 reLaunch，清空页面栈
  onExport() { this.leave('/pages/result/index', 'reLaunch') },

  onNavPaper() {
    wx.reLaunch({ url: '/pages/paper/index' })
  },

  // 琥珀条收起，重算纸高
  onCloseAmber() {
    this.setData({ amberClosed: true })
    setTimeout(() => this.layoutPaper(), 80)
  },

  onShareAppMessage() {
    return {
      title: '长截图一键分页转 PDF，打印清晰不糊',
      path: '/pages/home/index',
      imageUrl: '/assets/home/hero.png',
    }
  },
})
