const store = require('../../utils/store.js')
const paper = require('../../utils/paper.js')
const pdfJob = require('../../utils/pdfJob.js')
const files = require('../../utils/files.js')
const nav = require('../../utils/nav.js')

// P6 导出结果：loading / ok / over / error / nospace / view / empty
Page({
  data: {
    state: 'loading',
    done: 0,
    total: 0,
    compressTip: '',
    filename: '',
    pages: 0,
    paperName: '',
    sizeText: '',
    dateText: '',
    cover: '',              // 封面缩略图，空则用固定图标
    degradedTip: '',
    tooManyTip: '',
    extraTip: '',
    errTitle: 'PDF 没有生成成功',
    errSub: '选图、纸张和分页都还在，重试不用重新设置。',
    overSize: '',
    fromHistory: false,     // 查看态：从历史进入
    rnOpen: false,          // 重命名半屏
    rnValue: '',
    rnErr: '',
    statusBarH: 0,
    navContentH: 48,
  },

  navMetrics() {
    return nav.metrics()
  },

  onLoad(options) {
    if (options && options.ts) {
      this.setData(Object.assign({ fromHistory: !!(options.from === 'history') }, this.navMetrics()))
      this.startView(Number(options.ts))
      return
    }
    this.setData(this.navMetrics())
    this.start()
  },

  // 导航栏小房子：回首页并清草稿
  onNavHome() {
    store.resetJob()
    wx.reLaunch({ url: '/pages/home/index' })
  },

  onUnload() {
    if (this.ctl) this.ctl.cancelled = true
    // 成功态离开时清草稿
    if (this.data.state === 'ok') store.resetJob()
  },

  // 查看态：读历史条目，只信磁盘
  startView(ts) {
    this.viewTs = ts
    const item = store.loadHistory().filter((it) => it.ts === ts)[0]
    if (!item || !files.exists(item.path)) {
      this.setData({ state: 'empty' })
      return
    }
    this.viewItem = item
    this.result = { filePath: item.path, filename: item.filename, pages: item.pages }
    this.setting = { paper: item.paper || 'a4' }
    this.setData({
      state: 'view',
      filename: item.filename,
      pages: item.pages,
      cover: (item.cover && files.exists(item.cover)) ? item.cover : '',
      paperName: paper.resolve({ paper: item.paper }).name,
      sizeText: (Number(item.size) || 0).toFixed(1) + ' MB',
      dateText: files.dateText(item.ts),
    })
  },

  // 打开重命名半屏
  onRename() {
    if ((this.data.state !== 'view' && this.data.state !== 'ok') || !this.viewItem) return
    this.setData({ rnOpen: true, rnErr: '', rnValue: this.viewItem.filename.replace(/\.pdf$/i, '') })
  },

  onRnInput(e) {
    this.setData({ rnValue: e.detail.value, rnErr: '' })
  },

  onRnCancel() {
    this.setData({ rnOpen: false, rnErr: '' })
  },

  // 确认重命名：先改磁盘再改历史条目
  onRnConfirm() {
    const item = this.viewItem
    if (!item) { this.setData({ rnOpen: false }); return }
    const base = (this.data.rnValue || '').trim()
    if (!base) { this.setData({ rnErr: '文件名不能为空' }); return }
    if (/[\\/:*?"<>|]/.test(base)) { this.setData({ rnErr: '不能包含 / \\ : * ? " < > |' }); return }
    const newName = base + '.pdf'
    if (newName === item.filename) { this.setData({ rnOpen: false }); return }
    const dir = item.path.replace(/\/[^/]+$/, '')
    const newPath = dir + '/' + newName
    const newCover = item.cover ? newPath.replace(/\.pdf$/, '.cover.jpg') : ''
    try {
      const fsm = wx.getFileSystemManager()
      fsm.renameSync(item.path, newPath)
      // 封面改名失败不致命，条目清空 cover 走默认图标
      if (item.cover) {
        try { fsm.renameSync(item.cover, newCover) }
        catch (raw) { this._rnCoverLost = true }
      }
    } catch (raw) {
      this.setData({ rnErr: '改名没成功，文件可能被占用，稍后再试' })
      return
    }
    store.renameHistory(this.viewTs, {
      filename: newName,
      path: newPath,
      cover: this._rnCoverLost ? '' : newCover,
    })
    this._rnCoverLost = false
    this.viewItem = Object.assign({}, item, { filename: newName, path: newPath, cover: newCover })
    this.result = { filePath: newPath, filename: newName, pages: this.result.pages }
    this.setData({ rnOpen: false, filename: newName, cover: this.viewItem.cover && files.exists(this.viewItem.cover) ? this.viewItem.cover : '' })
    wx.showToast({ title: '已重命名', icon: 'none' })
  },

  // 开始导出
  start() {
    const job = store.get(store.KEY_JOB, {})
    const setting = store.get(store.KEY_SETTING, paper.DEFAULTS)
    const pages = (job && job.pages) || []
    if (!pages.length) {
      this.setData({
        state: 'error',
        errTitle: '没有可导出的分页',
        errSub: '回预览页重新分一次页，再导出。',
      })
      return
    }
    this.job = job
    this.setting = setting
    this.ctl = { cancelled: false }
    const resolved = paper.resolve(setting)
    this.setData({
      state: 'loading',
      done: 0,
      total: pages.length,
      compressTip: '',
      pages: pages.length,
      paperName: resolved.name,
      extraTip: '',
    })

    pdfJob.run({
      imgPath: job.img,
      sources: job.sources && job.sources.length ? job.sources : null,
      imgW: job.imgW || job.w,
      scaledK: job.scaledK || 1,
      pages: pages,
      setting: setting,
      page: this,
    }, {
      onPage: (done, total) => this.setData({ done: done, total: total }),
      onAttempt: (n) => {
        if (n > 1) {
          this.setData({ compressTip: '正在压缩到 10MB 以内…（第 ' + n + ' 次尝试）' })
        }
      },
    }, this.ctl).then((res) => this.finish(res)).catch((err) => this.onError(err))
  },

  // 导出结束：入历史并切到成功态
  finish(res) {
    if (this.ctl.cancelled) return
    this.result = res
    const SKIP_TEXT = {
      read: '原图文件读不出来',
      jpeg: '原图不是标准 JPEG',
      comps: '原图是黑白/四色 JPEG',
      orientation: '原图带了旋转标记',
      dim: '原图尺寸对不上',
      tall: '原图太长',
      size: '原图加起来太大',
    }
    const degradedTip = res.direct
      ? '这一份每页都是原图像素（裁切时没重新压过），预览里看着糊不影响打印'
      : (res.directSkip
        ? '这次导出没能用原图（' + (SKIP_TEXT[res.directSkip] || res.directSkip) + '），清晰度是压缩后的，打印会糊一些'
        : (res.quality < 0.88
          ? '为了放进 10MB，已把清晰度降到 ' + Math.round(res.quality * 100) + '%，打印仍然清楚'
          : ''))
    const tooManyTip = res.pages > 30
      ? res.pages + ' 页，转发给好友时对方需要一点时间接收'
      : ''

    const commit = (cover) => {
      const ts = store.addHistory({
        filename: res.filename,
        pages: res.pages,
        paper: this.setting.paper,
        size: res.sizeMB,
        path: res.filePath,
        cover: cover || '',
      })
      this.viewTs = ts
      this.viewItem = { filename: res.filename, path: res.filePath, cover: cover || '' }
      if (this.ctl.cancelled) return
      // 直嵌模式无法分批，超限时如实报体积
      if (res.overLimit && !res.direct) {
        this.setData({
          state: 'over',
          overSize: res.sizeMB.toFixed(1),
          degradedTip: degradedTip,
        })
        return
      }
      this.setData({
        state: 'ok',
        filename: res.filename,
        sizeText: res.sizeMB.toFixed(1) + ' MB',
        cover: cover || '',
        degradedTip: degradedTip,
        tooManyTip: tooManyTip || (res.overLimit ? '原图直出，文件偏大，发送时多等一会儿' : ''),
      })
    }
    if (res.coverPath) return commit(res.coverPath)
    this.buildDirectCover(res).then(commit)
  },

  // 直嵌模式补一张封面：先压 1500，失败再按源图虚拟高
  buildDirectCover(res) {
    const job = this.job || {}
    const srcs = (job.sources && job.sources.length) ? job.sources : null
    const first = srcs ? srcs[0].path : job.img
    if (!first || !wx.compressImage) return Promise.resolve('')
    const dest = (wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '')
      + '/pdf/' + res.filename.replace(/\.pdf$/, '.cover.jpg')
    const tryHeight = (h) => new Promise((resolve) => {
      wx.compressImage({
        src: first,
        quality: 80,
        compressedHeight: h,
        success: (r) => {
          wx.getFileSystemManager().copyFile({
            srcPath: r.tempFilePath,
            destPath: dest,
            success: () => resolve(dest),
            fail: () => resolve(''),
          })
        },
        fail: () => resolve(''),
      })
    })
    let fallbackH = 3000
    if (srcs && srcs[0] && srcs[0].h) {
      fallbackH = Math.max(600, Math.min(Math.round(srcs[0].h * (Number(srcs[0].scale) || 1)), 4000))
    }
    return tryHeight(1500).then((ok) => (ok ? ok : tryHeight(fallbackH)))
  },

  onError(err) {
    if (!err || err.code === 'CANCELLED') return
    if (err.code === 'NOSPACE') {
      this.setData({ state: 'nospace' })
      return
    }
    this.setData({
      state: 'error',
      errTitle: 'PDF 没有生成成功',
      errSub: err.code === 'DRAW_FAILED'
        ? '有一页没能画出来。重试一次；还是不行就回预览页调整分页再导出。'
        : '选图、纸张和分页都还在，重试不用重新设置。',
    })
  },

  platform() {
    try {
      const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
      return (info && info.platform) || ''
    } catch (raw) {
      return ''
    }
  },

  fileExists(filePath) {
    return files.exists(filePath)
  },

  // 转发文件：失败时降级到 ASCII 名、再降级到 openDocument
  shareFile(filePath, fileName) {
    if (!wx.shareFileMessage) {
      wx.showToast({ title: '当前微信版本不支持转发文件', icon: 'none' })
      return
    }
    if (!this.fileExists(filePath)) {
      wx.showToast({ title: '文件已不在本机，请重新导出', icon: 'none' })
      return
    }
    this.tryShare(filePath, fileName, true)
  },

  tryShare(filePath, fileName, allowFallback) {
    wx.shareFileMessage({
      filePath: filePath,
      fileName: fileName,
      fail: (raw) => {
        const msg = String((raw && raw.errMsg) || '')
        if (msg.indexOf('cancel') >= 0) return
        if (!allowFallback) return this.shareFallback(filePath, msg)
        const ascii = 'screenshot_' + (this.result && this.result.pages ? this.result.pages : '') + 'p.pdf'
        const dest = (wx.env.USER_DATA_PATH) + '/pdf/' + ascii
        const fsm = wx.getFileSystemManager()
        fsm.copyFile({
          srcPath: filePath,
          destPath: dest,
          success: () => this.tryShare(dest, ascii, false),
          fail: () => this.shareFallback(filePath, msg),
        })
      },
    })
  },

  // 兜底：打开文档，系统菜单里可转发或存储
  shareFallback(filePath, errMsg) {
    console.error('[shareFileMessage]', errMsg)
    wx.openDocument({
      filePath: filePath,
      fileType: 'pdf',
      showMenu: true,
      fail: () => wx.showToast({ title: '转发失败，可试试重新导出', icon: 'none' }),
    })
  },

  onShare() {
    if (!this.result) return
    this.shareFile(this.result.filePath, this.result.filename)
  },

  // 保存：PC 用 saveFileToDisk，手机用 openDocument
  onSave() {
    if (!this.result) return
    const plat = this.platform()
    if ((plat === 'windows' || plat === 'mac') && wx.saveFileToDisk) {
      wx.saveFileToDisk({
        filePath: this.result.filePath,
        success: () => wx.showToast({ title: '已保存', icon: 'success' }),
        fail: (raw) => {
          const msg = String((raw && raw.errMsg) || '')
          if (msg.indexOf('cancel') >= 0) return
          wx.showToast({ title: '保存失败，可以先转发到微信', icon: 'none' })
        },
      })
      return
    }
    if (!wx.openDocument) {
      wx.showToast({ title: '当前微信版本不支持保存', icon: 'none' })
      return
    }
    if (!this.fileExists(this.result.filePath)) {
      wx.showToast({ title: '文件已不在本机，请重新导出', icon: 'none' })
      return
    }
    wx.openDocument({
      filePath: this.result.filePath,
      fileType: 'pdf',
      showMenu: true,
      fail: (raw) => {
        const msg = String((raw && raw.errMsg) || '')
        if (msg.indexOf('cancel') >= 0) return
        wx.showToast({ title: '保存失败，可以先转发到微信', icon: 'none' })
      },
    })
  },

  onHistory() {
    wx.navigateTo({ url: '/pages/history/index' })
  },

  // 空态出口：删除该条记录
  onDeleteRecord() {
    if (this.viewTs) store.removeHistory(this.viewTs)
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/history/index' }),
    })
  },

  // 继续生成：清草稿并回首页
  onAgain() {
    store.resetJob()
    wx.reLaunch({ url: '/pages/home/index' })
  },
  onRetry() { this.start() },
  onRetrySpace() { this.start() },
  onCleanHistory() { wx.navigateTo({ url: '/pages/history/index' }) },
  onBackPreview() {
    wx.redirectTo({ url: '/pages/preview/index' })
  },
  onPrintTip() {
    wx.showModal({
      title: '打印设置',
      content: '在打印对话框里把缩放选成「实际大小 / 100%」，不要选「适应页面」，否则内容会被缩小。',
      showCancel: false,
      confirmText: '知道了',
    })
  },

  // 超限仍允许导出
  onForceExport() {
    if (!this.result) return
    this.shareFile(this.result.filePath, this.result.filename)
    wx.showToast({ title: '已生成，转发时可能失败', icon: 'none' })
  },

  // 分成 2 份：同一管线跑两遍
  onSplit() {
    if (this.splitting || !this.job) return
    this.splitting = true
    const pages = this.job.pages
    const mid = Math.ceil(pages.length / 2)
    const halves = [pages.slice(0, mid), pages.slice(mid)]
    const name = paper.resolve(this.setting).name
    const job = this.job
    const ctl = this.ctl = { cancelled: false }
    this.setData({ state: 'loading', done: 0, total: pages.length, compressTip: '正在分成 2 份…' })

    const runPart = (list, idx) => pdfJob.run({
      imgPath: job.img,
      sources: job.sources && job.sources.length ? job.sources : null,
      imgW: job.imgW || job.w,
      scaledK: job.scaledK || 1,
      pages: list,
      setting: this.setting,
      page: this,
      filename: pdfJob.stampText() + '_' + list.length + '页_' + name + '_第' + idx + '份.pdf',
    }, {}, ctl)

    runPart(halves[0], 1)
      .then((a) => runPart(halves[1], 2).then((b) => {
        this.splitting = false
        if (ctl.cancelled) return
        ;[a, b].forEach((f) => {
          const ts = store.addHistory({
            filename: f.filename, pages: f.pages, paper: this.setting.paper, size: f.sizeMB, path: f.filePath,
            cover: f.coverPath || '',
          })
          // 页面显示第 1 份，其条目用于重命名
          if (f === a) {
            this.viewTs = ts
            this.viewItem = { filename: a.filename, path: a.filePath, cover: a.coverPath || '' }
          }
        })
        this.result = a
        this.setData({
          state: 'ok',
          filename: a.filename,
          sizeText: a.sizeMB.toFixed(1) + ' MB',
          cover: a.coverPath || '',
          degradedTip: '',
          tooManyTip: '',
          extraTip: '已分成 2 份，第 2 份「' + b.filename + '」也在历史里',
        })
        wx.showActionSheet({
          itemList: ['转发第 1 份', '转发第 2 份'],
          success: (r) => {
            const f = r.tapIndex === 0 ? a : b
            this.shareFile(f.filePath, f.filename)
          },
        })
      }))
      .catch((err) => {
        this.splitting = false
        this.onError(err)
      })
  },

  onShareAppMessage() {
    return {
      title: '我把长截图转成 PDF 了，打印很清楚',
      path: '/pages/home/index',
      imageUrl: '/assets/home/hero.png',
    }
  },
})
