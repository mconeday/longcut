// 纸张规格与页容量计算，全局唯一定义处
const SPECS = [
  { key: 'a4',     name: 'A4',     mmW: 210, mmH: 297, bw: 56, bh: 79 },
  { key: 'a5',     name: 'A5',     mmW: 148, mmH: 210, bw: 46, bh: 65 },
  { key: 'letter', name: 'Letter', mmW: 216, mmH: 279, bw: 58, bh: 75 },
  { key: 'r4',     name: '4R',     mmW: 102, mmH: 152, bw: 50, bh: 74 },
]

const DEFAULTS = { paper: 'a4', landscape: false, margin: 10 }

// 解析设置，返回纸张与内容区尺寸
function resolve(setting) {
  const s = Object.assign({}, DEFAULTS, setting || {})
  const spec = SPECS.find(x => x.key === s.paper) || SPECS[0]
  const mmW = s.landscape ? spec.mmH : spec.mmW
  const mmH = s.landscape ? spec.mmW : spec.mmH
  const margin = Math.max(0, Number(s.margin) || 0)
  const contentWmm = Math.max(1, mmW - margin * 2)
  const contentHmm = Math.max(1, mmH - margin * 2)
  return {
    key: spec.key,
    name: spec.name,
    landscape: !!s.landscape,
    margin,
    mmW, mmH,
    contentWmm, contentHmm,
    ratio: mmH / mmW,
    contentRatio: contentHmm / contentWmm,
  }
}

// 每页可容纳的原图像素行数
function capacity(imgWidth, setting) {
  const p = resolve(setting)
  return Math.max(1, Math.round(imgWidth * p.contentHmm / p.contentWmm))
}

module.exports = { SPECS, DEFAULTS, resolve, capacity }
