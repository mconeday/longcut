// 全局状态：图片路径与纸张设置走 storage
const net = require('./utils/net.js')

App({
  globalData: {
    version: '1.0.0',
  },
  onLaunch() {
    // 安装网络计数钩子
    net.install()
  },
})
