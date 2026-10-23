const store = require('../../utils/store.js')
const files = require('../../utils/files.js')
const nav = require('../../utils/nav.js')

// P7 历史列表：左滑删除、清空、点行查看
const SWIPE_W = 80          // 左滑露出宽度

Page({
  onLoad() { this.setData(nav.metrics()) },

  data: {
    list: [],
    empty: true,
    canClear: false,
  },

  onShow() { this.refresh() },

  // 读历史并组装展示字段
  refresh() {
    const list = store.loadHistory().map((it) => {
      const sizeMB = Number(it.size) || 0
      // 文件已不在本机时如实标记
      const gone = !files.exists(it.path)
      return {
        ts: it.ts,
        filename: it.filename || '未命名.pdf',
        pages: it.pages || 0,
        paper: it.paper || 'a4',
        sizeText: sizeMB ? sizeMB.toFixed(1) + ' MB' : '',
        metaText: gone
          ? (it.pages || 0) + ' 页 · 文件已不在本机'
          : (it.pages || 0) + ' 页' + (sizeMB ? ' · ' + sizeMB.toFixed(1) + ' MB' : '')
            + ' · ' + files.dateText(it.ts),
        gone: gone,
        x: 0,
      }
    })
    this.setData({ list: list, empty: !list.length, canClear: list.length > 0 })
  },

  // 左滑开始
  onTouchStart(e) {
    const i = Number(e.currentTarget.dataset.i)
    const row = this.data.list[i]
    if (!row) return
    this.touch = {
      i: i,
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      base: row.x || 0,
      moved: false,
      vertical: false,
    }
  },

  // 左滑中，竖向优先交给列表滚动
  onTouchMove(e) {
    const t = this.touch
    if (!t) return
    const dx = e.touches[0].clientX - t.x
    const dy = e.touches[0].clientY - t.y
    if (!t.moved && Math.abs(dy) > Math.abs(dx)) { t.vertical = true; return }
    if (t.vertical) return
    if (!t.moved && Math.abs(dx) < 8) return
    t.moved = true
    const x = Math.max(-SWIPE_W, Math.min(0, t.base + dx))
    this.setData({ ['list[' + t.i + '].x']: x })
  },

  // 左滑结束，过半则展开
  onTouchEnd() {
    const t = this.touch
    this.touch = null
    if (!t || !t.moved) return
    const row = this.data.list[t.i]
    const open = row && row.x < -SWIPE_W / 2
    this.closeAll(open ? t.i : -1, open ? -SWIPE_W : 0)
  },

  // 收起所有行，只保留指定行
  closeAll(keepIndex, keepX) {
    const patch = {}
    for (let i = 0; i < this.data.list.length; i++) {
      patch['list[' + i + '].x'] = i === keepIndex ? keepX : 0
    }
    this.setData(patch)
  },

  // 封面加载失败则清空，回落默认图标
  onCoverErr(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (!(i >= 0) || !this.data.list[i] || !this.data.list[i].cover) return
    this.setData({ ['list[' + i + '].cover']: '' })
  },

  // 点行进入查看态
  onOpen(e) {
    const i = Number(e.currentTarget.dataset.i)
    const row = this.data.list[i]
    if (!row) return
    if (row.x) { this.closeAll(-1, 0); return }
    wx.navigateTo({ url: '/pages/result/index?ts=' + row.ts + '&from=history' })
  },

  // 删除单条
  onDelete(e) {
    const i = Number(e.currentTarget.dataset.i)
    const row = this.data.list[i]
    if (!row) return
    wx.showModal({
      title: '删除这份 PDF？',
      content: '删掉后要重新选图、重新排 ' + row.pages + ' 页。',
      confirmText: '删除',
      confirmColor: '#C2362B',
      success: (res) => {
        if (!res.confirm) { this.closeAll(-1, 0); return }
        store.removeHistory(row.ts)
        this.refresh()
        wx.showToast({ title: '已删除', icon: 'success' })
      },
    })
  },

  // 清空全部
  onClearAll() {
    const list = this.data.list
    if (!list.length) return
    let totalPages = 0
    for (let i = 0; i < list.length; i++) totalPages += list[i].pages || 0
    wx.showModal({
      title: '清空全部历史文件？',
      content: list.length + ' 份 PDF 会被删除，删掉后要重新选图、重新排 ' + totalPages + ' 页。',
      confirmText: '清空',
      confirmColor: '#C2362B',
      success: (res) => {
        if (!res.confirm) return
        store.clearHistory()
        this.refresh()
        wx.showToast({ title: '已清空', icon: 'success' })
      },
    })
  },

  onShareAppMessage() {
    return {
      title: '长截图一键分页转 PDF，打印清晰不糊',
      path: '/pages/home/index',
      imageUrl: '/assets/home/hero.png',
    }
  },
})
