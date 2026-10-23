const store = require('../../utils/store.js')
const files = require('../../utils/files.js')
const net = require('../../utils/net.js')

// P8 设置与隐私：网络请求数与已用空间均为真实统计
const VERSION = '1.0.0'
const S5_STEPS = [
  '① 打开手机的飞行模式',
  '② 回到这里再选一张图',
  '③ 仍能生成 PDF，就说明没有联网',
]

function pdfDir() {
  const base = (wx.env && wx.env.USER_DATA_PATH) ? wx.env.USER_DATA_PATH : ''
  return base + '/pdf'
}

Page({
  data: {
    usedText: '0 MB',
    netCount: 0,
    version: VERSION,
    sheetOpen: false,
    steps: S5_STEPS,
  },

  onLoad(options) {
    void options
  },

  onShow() { this.refresh() },

  // 刷新已用空间与网络请求次数
  refresh() {
    this.setData({
      usedText: files.sizeText(files.dirSize(pdfDir())),
      netCount: net.count(),
    })
  },

  // 清理本地 PDF 与缩略图，同时清历史
  onClearFiles() {
    const dir = pdfDir()
    const bytes = files.dirSize(dir)
    wx.showModal({
      title: '清理本地文件？',
      content: '会删掉 ' + files.sizeText(bytes) + ' 的历史 PDF 和缩略图。原图从来没存过，不受影响。',
      confirmText: '清理',
      confirmColor: '#C2362B',
      success: (res) => {
        if (!res.confirm) return
        store.clearHistory()
        const list = files.listFiles(dir)
        for (let i = 0; i < list.length; i++) {
          if (files.exists(list[i])) files.unlink(list[i])
        }
        this.refresh()
        wx.showToast({ title: '已清理', icon: 'success' })
      },
    })
  },

  onS5Open() { this.setData({ sheetOpen: true }) },
  onS5Close() { this.setData({ sheetOpen: false }) },

  onHelp() {
    wx.showModal({
      title: '使用帮助',
      content: '① 从相册选一张长截图\n② 选纸张，确认分页（可手动微调）\n③ 导出 PDF，打印时选「实际大小」',
      showCancel: false,
      confirmText: '知道了',
    })
  },

  onAbout() {
    wx.showModal({
      title: '关于',
      content: '长图转PDF v' + VERSION + '\n选图、分页、生成 PDF 全部在本机完成；不联网、不上传、不留存原图。',
      showCancel: false,
      confirmText: '知道了',
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
