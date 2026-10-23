/* 本地磁盘文件工具：存在性、删除、体积统计 */
function fsm() {
  try {
    return wx.getFileSystemManager()
  } catch (raw) {
    return null
  }
}

// 文件是否存在
function exists(filePath) {
  if (!filePath) return false
  const m = fsm()
  if (!m || !m.accessSync) return false
  try {
    m.accessSync(filePath)
    return true
  } catch (raw) {
    return false
  }
}

// 删除文件，返回是否删除成功
function unlink(filePath) {
  if (!filePath) return false
  const m = fsm()
  if (!m || !m.unlinkSync) return false
  try {
    m.unlinkSync(filePath)
    return true
  } catch (raw) {
    return false
  }
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

// 格式化为 'MM-DD HH:mm'
function dateText(ts) {
  const d = new Date(ts)
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 单个文件字节数，读不到记 0
function statSize(p) {
  const m = fsm()
  if (!m || !m.statSync) return 0
  try {
    const st = m.statSync(p)
    return (st && st.size) || 0
  } catch (raw) {
    return 0
  }
}

// 是否目录
function isDir(p) {
  const m = fsm()
  if (!m || !m.statSync) return false
  try {
    const st = m.statSync(p)
    return !!(st && typeof st.isDirectory === 'function' && st.isDirectory())
  } catch (raw) {
    return false
  }
}

function readdir(dir) {
  const m = fsm()
  if (!m || !m.readdirSync) return []
  try {
    return m.readdirSync(dir) || []
  } catch (raw) {
    return []
  }
}

// 递归统计目录体积，最多 4 层
function dirSize(dir, depth) {
  const d = depth || 0
  if (!dir || d > 4) return 0
  let total = 0
  const names = readdir(dir)
  for (let i = 0; i < names.length; i++) {
    const p = dir + '/' + names[i]
    if (isDir(p)) total += dirSize(p, d + 1)
    else total += statSize(p)
  }
  return total
}

// 列出目录下所有文件路径，最多 4 层
function listFiles(dir, depth) {
  const d = depth || 0
  if (!dir || d > 4) return []
  const out = []
  const names = readdir(dir)
  for (let i = 0; i < names.length; i++) {
    const p = dir + '/' + names[i]
    if (isDir(p)) out.push.apply(out, listFiles(p, d + 1))
    else out.push(p)
  }
  return out
}

// 体积文案，MB 保留一位小数
function sizeText(bytes) {
  const b = Number(bytes) || 0
  if (b <= 0) return '0 MB'
  const mb = b / (1024 * 1024)
  if (mb < 0.1) return '0.1 MB'
  return mb.toFixed(1) + ' MB'
}

module.exports = {
  exists: exists,
  unlink: unlink,
  dateText: dateText,
  pad: pad,
  statSize: statSize,
  dirSize: dirSize,
  listFiles: listFiles,
  sizeText: sizeText,
}
