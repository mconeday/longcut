// 自定义导航栏高度：状态栏 + 内容条（iOS 44，其他 48）
function metrics() {
  try {
    const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
    const ios = !!(info.system && info.system.toLowerCase().indexOf('ios') + 1)
    const statusBarH = info.statusBarHeight || 0
    const navContentH = ios ? 44 : 48
    return { statusBarH, navContentH, navH: statusBarH + navContentH }
  } catch (raw) {
    return { statusBarH: 0, navContentH: 48, navH: 48 }
  }
}

module.exports = { metrics }
