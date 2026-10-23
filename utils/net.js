// 网络请求计数：包一层 wx 网络 API，真实调用次数
const NAMES = ['request', 'downloadFile', 'uploadFile', 'connectSocket']

let calls = 0
let installed = false

// 安装计数钩子，重复调用无副作用
function install() {
  if (installed) return false
  if (typeof wx === 'undefined') return false
  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[i]
    const raw = wx[name]
    if (typeof raw !== 'function') continue
    wx[name] = (function (fn) {
      return function () {
        calls++
        return fn.apply(wx, arguments)
      }
    })(raw)
  }
  installed = true
  return true
}

function count() { return calls }
function reset() { calls = 0 }
function isInstalled() { return installed }

module.exports = { install: install, count: count, reset: reset, isInstalled: isInstalled }
