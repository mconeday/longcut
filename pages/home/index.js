const store = require('../../utils/store.js')

// P1 首页选图：先选后排序，进 P3 前不做可行性预判
const MAX_COUNT = 4               // 单次最多选 4 张
const SPLIT_ROWS = 20000          // 分段建议的每段行数
const LONG_PRESS_MS = 400         // 长按拖动排序
const THUMB_PITCH_RPX = 160       // 缩略图间距

function srcOf(f) {
  return {
    path: f.tempFilePath,
    width: f.width || 0,
    height: f.height || 0,
    size: f.size || 0,
  }
}

Page({
  data: {
    images: [],
    count: 0,
    totalH: 0,
    maxCount: MAX_COUNT,
    s1Open: false,
    s1Title: '',
    s1Body: '',
    s1Seg: 2,
    s1Steps: false,        // false = 建议页，true = 三步说明
    s1Kind: '',            // height | size | count | total
    // 拖动排序状态
    dragIdx: -1,
    dragStyle: '',
    shifts: [],
    scanning: false,
  },

  onShow() {
    const job = store.get(store.KEY_JOB, {})
    const images = (job.images && job.images.length) ? job.images : []
    // 已有分页结果说明是从后续页面返回，不当作待选
    if (job.pages && job.pages.length) return
    if (!images.length) {
      this.setData({ images: [], count: 0, totalH: 0 })
      return
    }
    // 补一次缺失的宽高
    const broken = images.some((x) => !(x.width > 0) || !(x.height > 0))
    if (!broken) {
      this.setData({ images: images, count: images.length, totalH: images.reduce((s, x) => s + (x.height || 0), 0) })
      return
    }
    this.refillDims(images)
  },

  // 补齐宽高，补不出的丢掉
  refillDims(images) {
    this.setData({ images: images.slice(), count: images.length, totalH: 0, scanning: true })
    const push = () => this.setData({ images: images.slice() })
    this.fillDims(images, push).then((ok) => {
      this.setData({ scanning: false })
      const dropped = images.length - ok.length
      if (!ok.length) {
        store.set(store.KEY_JOB, {})
        this.setData({ images: [], count: 0, totalH: 0 })
        return
      }
      this.commit(ok, store.get(store.KEY_JOB, {}).degraded)
      if (dropped) wx.showToast({ title: dropped + ' 张读不到尺寸已去掉', icon: 'none' })
    })
  },

  // 串行补齐尺寸，每张落定回调一次
  fillDims(list, onStep) {
    let chain = Promise.resolve()
    list.forEach((it) => {
      if (it.width > 0 && it.height > 0) return
      chain = chain.then(() => new Promise((resolve) => {
        wx.getImageInfo({
          src: it.path,
          success: (info) => { it.width = info.width; it.height = info.height; if (onStep) onStep(); resolve() },
          fail: () => { if (onStep) onStep(); resolve() },
        })
      }))
    })
    return chain.then(() => list.filter((x) => x.width > 0 && x.height > 0))
  },

  onUnload() {
    if (this.pressTimer) clearTimeout(this.pressTimer)
  },

  // 选图前先确认隐私授权
  withPrivacy(go) {
    if (wx.requirePrivacyAuthorize) {
      wx.requirePrivacyAuthorize({
        success: go,
        fail: (raw) => {
          const m = (raw && raw.errMsg) || ''
          wx.showToast({
            title: m.indexOf('deny') >= 0 ? '需要同意隐私指引才能选图'
              : '隐私指引未配置，请在小程序后台声明后重试',
            icon: 'none',
          })
        },
      })
    } else {
      go()
    }
  },

  // 从相册选图
  onPick() {
    if (this.data.scanning) return
    const left = MAX_COUNT - this.data.images.length
    if (left <= 0) {
      wx.showToast({ title: '最多 ' + MAX_COUNT + ' 张', icon: 'none' })
      return
    }
    this.withPrivacy(() => {
      wx.chooseMedia({
        count: left,
        mediaType: ['image'],
        sourceType: ['album'],
        success: (res) => {
          this.lastSource = 'album'
          this.accept((res.tempFiles || []).map(srcOf))
        },
        fail: (res) => {
          if (res.errMsg && res.errMsg.indexOf('cancel') < 0) {
            wx.showToast({ title: '选图失败', icon: 'none' })
          }
        },
      })
    })
  },

  // 从聊天记录选图
  onPickChat() {
    if (this.data.scanning) return
    if (!wx.chooseMessageFile) {
      wx.showToast({ title: '当前微信版本不支持', icon: 'none' })
      return
    }
    const left = MAX_COUNT - this.data.images.length
    if (left <= 0) {
      wx.showToast({ title: '最多 ' + MAX_COUNT + ' 张', icon: 'none' })
      return
    }
    this.withPrivacy(() => {
      wx.chooseMessageFile({
        count: left,
        type: 'image',
        success: (res) => {
          this.lastSource = 'chat'
          this.accept((res.tempFiles || []).map((f) => ({
            path: f.path, width: 0, height: 0, size: f.size || 0,
          })))
        },
        fail: (res) => {
          if (res.errMsg && res.errMsg.indexOf('cancel') < 0) {
            wx.showToast({ title: '导入失败', icon: 'none' })
          }
        },
      })
    })
  },

  // 加号沿用上一次的来源
  onAddMore() {
    if (this.lastSource === 'chat') this.onPickChat()
    else this.onPick()
  },

  // 收到选图结果：缺尺寸先进加载态补齐
  accept(list) {
    if (!list.length) return
    const prev = this.data.images.slice()
    if (list.some((x) => !(x.width > 0) || !(x.height > 0))) {
      const merged = prev.concat(list)
      this.setData({ images: merged, count: merged.length, totalH: 0, scanning: true })
      const push = () => this.setData({ images: merged.slice() })
      this.fillDims(list, push).then((ok) => {
        this.setData({ scanning: false })
        const dropped = list.length - ok.length
        if (!ok.length) {
          this.setData({ images: prev, count: prev.length, totalH: prev.reduce((s, x) => s + x.height, 0) })
          wx.showToast({ title: '读不到图片尺寸，请重新选择', icon: 'none' })
          return
        }
        this.acceptFrom(prev, ok)
        if (dropped) wx.showToast({ title: dropped + ' 张读不到尺寸已去掉', icon: 'none' })
      })
      return
    }
    this.acceptFrom(prev, list)
  },

  // 合并已选并校验张数
  acceptFrom(prev, list) {
    const next = prev.concat(list)
    if (next.length > MAX_COUNT) {
      if (prev.length !== this.data.images.length || this.data.totalH !== prev.reduce((s, x) => s + x.height, 0)) {
        this.setData({ images: prev, count: prev.length, totalH: prev.reduce((s, x) => s + x.height, 0) })
      }
      this.showS1({
        kind: 'count',
        title: '已选 ' + next.length + ' 张',
        body: '一次最多 ' + MAX_COUNT + ' 张，多余的先去掉再选。',
      })
      return
    }
    this.commit(next, false)
  },

  // 打开半屏建议
  showS1(o) {
    const totalH = (o.pending || this.data.images).reduce((s, x) => s + (x.height || 0), 0)
    const seg = totalH ? Math.max(2, Math.ceil(totalH / SPLIT_ROWS)) : 2
    this.s1Pending = o.pending || null
    this.setData({
      s1Open: true, s1Steps: false,
      s1Title: o.title, s1Body: o.body, s1Kind: o.kind, s1Seg: seg,
    })
  },

  onS1Split() {
    this.setData({ s1Steps: true })
  },

  // 仍然继续：标记 degraded 并进 P2
  onS1Continue() {
    const list = this.s1Pending
    this.setData({ s1Open: false, s1Steps: false })
    this.s1Pending = null
    if (list) this.commit(list, true)
  },

  onS1Other() {
    this.setData({ s1Open: false, s1Steps: false })
    this.s1Pending = null
  },

  // 去相册裁图，清空已选
  onS1Pick() {
    this.setData({ s1Open: false, s1Steps: false })
    this.s1Pending = null
    store.set(store.KEY_JOB, {})
    this.setData({ images: [], count: 0, totalH: 0 })
    wx.showToast({ title: '裁好再选进来就行', icon: 'none' })
  },

  onS1Close() { this.setData({ s1Open: false, s1Steps: false }) },
  noop() {},

  // 写入草稿
  commit(images, degraded) {
    const w = images.reduce((m, x) => Math.max(m, x.width || 0), 0)
    const h = images.reduce((s, x) => s + (x.height || 0), 0)
    store.set(store.KEY_JOB, {
      images: images,
      w: w,
      h: h,
      degraded: !!degraded,
    })
    this.setData({ images: images, count: images.length, totalH: h })
  },

  // 删除一张
  onRemove(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (!(i >= 0) || i >= this.data.images.length) return
    const next = this.data.images.slice()
    next.splice(i, 1)
    this.commit(next, store.get(store.KEY_JOB, {}).degraded)
    if (!next.length) store.set(store.KEY_JOB, {})
  },

  // 长按开始拖动
  onThumbTouchStart(e) {
    if (this.data.scanning) return
    const i = Number(e.currentTarget.dataset.i)
    const del = e.target && e.target.dataset && e.target.dataset.del !== undefined
    this.drag = { from: i, x: e.touches[0].clientX, active: false, slot: i, moved: false, del: !!del }
    if (del) return
    this.pressTimer = setTimeout(() => {
      if (!this.drag) return
      this.drag.active = true
      this.setData({ dragIdx: i })
      this.paintDrag(0, i)
      try { wx.vibrateShort({ type: 'light' }) } catch (raw) {}
    }, LONG_PRESS_MS)
  },

  // 拖动中：跟手并按槽位让位
  onThumbTouchMove(e) {
    const d = this.drag
    if (!d) return
    const dx = e.touches[0].clientX - d.x
    if (!d.moved && Math.abs(dx) < 3) return
    d.moved = true
    if (!d.active) return
    const slot = Math.max(0, Math.min(this.data.images.length - 1, d.from + Math.round(dx / this.pitchPx())))
    const crossed = slot !== d.slot
    d.slot = slot
    this.paintDrag(dx, slot)
    if (crossed) { try { wx.vibrateShort({ type: 'light' }) } catch (raw) {} }
  },

  // 计算拖动位移，其余图按槽位平移
  paintDrag(dx, slot) {
    const from = this.drag.from
    const n = this.data.images.length
    const dxRpx = Math.round(dx * 750 / this.winW())
    const dragStyle = 'transform: translateX(' + dxRpx + 'rpx) scale(1.06); transition: none;'
    const shifts = []
    for (let i = 0; i < n; i++) {
      if (from < i && i <= slot) shifts.push(-THUMB_PITCH_RPX)
      else if (slot <= i && i < from) shifts.push(THUMB_PITCH_RPX)
      else shifts.push(0)
    }
    this.setData({ dragStyle, shifts })
  },

  clearDrag() {
    this.setData({ dragIdx: -1, dragStyle: '', shifts: [] })
  },

  // 抬手：删除或落位
  onThumbTouchEnd() {
    if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = null }
    const d = this.drag
    this.drag = null
    if (!d) return
    if (d.del) {
      if (!d.moved) this.onRemove({ currentTarget: { dataset: { i: d.from } } })
      return
    }
    if (!d.active) return
    this.clearDrag()
    if (d.moved && d.slot !== d.from) {
      const next = this.data.images.slice()
      const [it] = next.splice(d.from, 1)
      next.splice(d.slot, 0, it)
      this.commit(next, store.get(store.KEY_JOB, {}).degraded)
    }
  },

  // 拖动被打断：只清理状态
  onThumbTouchCancel() {
    if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = null }
    this.drag = null
  },

  winW() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      return (info && info.windowWidth) || 375
    } catch (raw) { return 375 }
  },

  pitchPx() {
    return THUMB_PITCH_RPX * this.winW() / 750
  },

  onNext() {
    if (this.data.scanning) return
    if (!this.data.images.length) {
      this.onPick()
      return
    }
    const job = store.get(store.KEY_JOB, {})
    if (!job.images || !job.images.length) this.commit(this.data.images, job.degraded)
    wx.navigateTo({ url: '/pages/paper/index' })
  },

  onHistory() { wx.navigateTo({ url: '/pages/history/index' }) },

  onPrivacy() { wx.navigateTo({ url: '/pages/settings/index?s5=1' }) },

  // 转发小程序卡片：不定义本方法，右上角「转发给朋友」是灰的
  onShareAppMessage() {
    return {
      title: '长截图一键分页转 PDF，打印清晰不糊',
      path: '/pages/home/index',
      imageUrl: '/assets/home/hero.png',
    }
  },
})
