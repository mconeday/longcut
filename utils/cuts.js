/* P5 切口带几何：切点取值、吸附、步进、页边界、带布局（纯函数）
 * 单位均为原图像素，像素→CSS 的换算由页面层乘 scale
 */
// job.blocks 平铺数组 → [{top,bottom}]
function decodeBlocks(flat) {
  const out = []
  if (!flat) return out
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out.push({ top: flat[i], bottom: flat[i + 1] })
  }
  return out
}

// 内容块之间的空白带
function gapsFromBlocks(blocks, h, minBand) {
  const gaps = []
  let prev = 0
  for (let i = 0; i < blocks.length; i++) {
    const top = Math.min(blocks[i].top, h)
    const bottom = Math.min(blocks[i].bottom, h)
    if (top - prev >= minBand) gaps.push({ top: prev, bottom: top })
    prev = Math.max(prev, bottom)
  }
  if (h - prev >= minBand) gaps.push({ top: prev, bottom: h })
  return gaps
}

function clampCut(y, lo, hi) {
  return Math.max(lo, Math.min(hi, y))
}

// y 所在空白带，不在返回 null
function inGap(y, gaps) {
  for (let i = 0; i < gaps.length; i++) {
    if (y >= gaps[i].top && y <= gaps[i].bottom) return gaps[i]
  }
  return null
}

// 切口 i 的可动范围，两侧各留 minPage
function boundsFor(cuts, i, h, minPage) {
  const m = minPage || 0
  const lo = i > 0 ? cuts[i - 1] + m : 0
  const hi = i < cuts.length - 1 ? cuts[i + 1] - m : h
  return { lo: lo, hi: hi }
}

// 吸附到 radius 内最近的空白带中心，没有返回 null
function snap(y, lo, hi, gaps, radius) {
  const c = clampCut(y, lo, hi)
  let best = null
  let bestD = Infinity
  for (let i = 0; i < gaps.length; i++) {
    const top = Math.max(gaps[i].top, lo)
    const bottom = Math.min(gaps[i].bottom, hi)
    if (bottom - top < 1) continue
    const mid = Math.floor((top + bottom) / 2)
    const d = Math.abs(mid - c)
    if (d < bestD) { bestD = d; best = mid }
  }
  return bestD <= radius ? best : null
}

// 拖动松手落点：吸附 → 落在空白带 → 回弹起点
function landDrag(startCut, candidate, lo, hi, gaps, radius) {
  const c = clampCut(candidate, lo, hi)
  const snapped = snap(c, lo, hi, gaps, radius)
  if (snapped != null) return { ok: true, cut: snapped, snapped: true }
  if (inGap(c, gaps)) return { ok: true, cut: Math.round(c), snapped: false }
  return { ok: false, cut: Math.round(startCut) }
}

// 按步长移动切口，越界或进内容返回失败原因
function step(cut, dir, lo, hi, gaps, opts) {
  opts = opts || {}
  const stepPx = opts.stepPx || 5
  const dest = cut + dir * stepPx
  if (dest < lo) return { ok: false, reason: opts.loEdge ? 'top' : 'neighbor' }
  if (dest > hi) return { ok: false, reason: opts.hiEdge ? 'bottom' : 'neighbor' }
  if (opts.fromSafe !== false && !inGap(dest, gaps)) return { ok: false, reason: 'content' }
  return { ok: true, cut: dest }
}

// 跳到该方向上最近的空白带中点
function jump(cut, dir, lo, hi, gaps, opts) {
  opts = opts || {}
  let best = null
  for (let i = 0; i < gaps.length; i++) {
    if (cut >= gaps[i].top && cut <= gaps[i].bottom) continue
    const top = Math.max(gaps[i].top, lo)
    const bottom = Math.min(gaps[i].bottom, hi)
    if (bottom - top < 1) continue
    const mid = Math.floor((top + bottom) / 2)
    if (dir < 0) {
      if (mid < cut && mid >= lo && (best === null || mid > best)) best = mid
    } else {
      if (mid > cut && mid <= hi && (best === null || mid < best)) best = mid
    }
  }
  if (best === null) {
    if (dir < 0) return { ok: false, reason: opts.loEdge ? 'top' : 'neighbor' }
    return { ok: false, reason: opts.hiEdge ? 'bottom' : 'neighbor' }
  }
  return { ok: true, cut: best }
}

// 区间 [from,to] 内的内容高度
function contentIn(blocks, from, to) {
  let sum = 0
  if (!blocks) return 0
  for (let i = 0; i < blocks.length; i++) {
    const t = Math.max(blocks[i].top, from)
    const b = Math.min(blocks[i].bottom, to)
    if (b > t) sum += b - t
  }
  return sum
}

// 切点 → 页边界；末段过矮且无内容时并回上一页
function pagesFromCuts(cuts, h, opts) {
  const o = opts || {}
  const minPage = o.minPage || 0
  const inkTail = o.inkTail === undefined ? 4 : o.inkTail

  const ys = []
  let prev = 0
  for (let i = 0; i < cuts.length; i++) {
    const y = Math.round(clampCut(cuts[i], prev + 1, h))
    ys.push(y)
    prev = y
  }

  if (ys.length) {
    const tailTop = ys[ys.length - 1]
    const tailH = h - tailTop
    const empty = o.blocks ? contentIn(o.blocks, tailTop, h) < inkTail : false
    if (tailH < minPage && empty) ys.pop()
  }

  const pages = []
  let from = 0
  for (let i = 0; i < ys.length; i++) {
    pages.push({ index: i + 1, from: from, to: ys[i], h: ys[i] - from })
    from = ys[i]
  }
  if (h - from > 0) {
    pages.push({ index: ys.length + 1, from: from, to: h, h: h - from })
  }
  return pages
}

/* 切口带布局：带高 8~24px，过近的带收成虚线条 */
const BAND_PX = 24        // 带本体高
const BAND_MIN_PX = 8     // 最矮高度
const HOT_PX = 44         // 触控热区
const DENSE_PX = 48       // 密集判定距离

function bandLayout(cuts, gaps, scale, activeIdx, h) {
  const out = []
  const full = []
  const order = []
  const n = cuts.length
  if (!n) return out

  for (let i = 0; i < n; i++) order.push(i)
  order.sort(function (a, b) {
    if (a === activeIdx) return -1
    if (b === activeIdx) return 1
    return a - b
  })

  const yOf = cuts.map(function (c) { return Math.round(c * scale) })
  const mini = new Array(n).fill(false)

  for (let k = 0; k < order.length; k++) {
    const i = order[k]
    let tooClose = false
    for (let m = 0; m < full.length; m++) {
      if (Math.abs(yOf[i] - yOf[full[m]]) < DENSE_PX) { tooClose = true; break }
    }
    if (tooClose) mini[i] = true
    else full.push(i)
  }

  for (let i = 0; i < n; i++) {
    const y = yOf[i]
    const g = inGap(cuts[i], gaps)
    const gapPx = g ? (g.bottom - g.top) * scale : BAND_PX
    const bh = Math.max(BAND_MIN_PX, Math.min(BAND_PX, Math.round(gapPx)))
    out.push({
      y: y,
      top: Math.round(y - HOT_PX / 2),
      bh: bh,
      mini: mini[i],
      lineOnly: !!g && gapPx < BAND_MIN_PX,
    })
  }
  return out
}

// 撤销栈，超出上限丢最旧
function createUndo(max) {
  const stack = []
  return {
    push: function (state) {
      if (stack.length >= (max || 5)) stack.shift()
      stack.push(JSON.parse(JSON.stringify(state)))
    },
    undo: function () { return stack.length ? stack.pop() : null },
    size: function () { return stack.length },
  }
}

module.exports = {
  decodeBlocks: decodeBlocks,
  gapsFromBlocks: gapsFromBlocks,
  clampCut: clampCut,
  inGap: inGap,
  boundsFor: boundsFor,
  snap: snap,
  landDrag: landDrag,
  step: step,
  jump: jump,
  pagesFromCuts: pagesFromCuts,
  contentIn: contentIn,
  bandLayout: bandLayout,
  createUndo: createUndo,
}
