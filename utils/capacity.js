/* 本机实测档位：记录失败与通过的峰值内存，供诊断与上限估算使用
 * 单位均为 MB；失败档位需同档 ≥2 次才采信
 */
const KEY = 'deviceCapacity'
const KEY_VER = 'deviceCapacityV2'
const KEEP_FAIL = 6        // 最多保留 6 档失败
const MIN_TRIES = 2        // 同档失败采信次数
const MARGIN = 0.85        // 采信上限 = 失败峰值 × 余量

const VER = 2

function mb(p) { return Math.round(Math.max(0, p) * 10) / 10 }

// 读档位，兼容旧键（只迁移 ok）
function load() {
  try {
    let v = wx.getStorageSync(KEY_VER) || null
    if (!v || typeof v !== 'object') {
      const old = wx.getStorageSync(KEY) || null
      v = { fail: [], ok: (old && typeof old.ok === 'number') ? old.ok : 0, ver: VER }
      save(v)
    }
    return {
      fail: Array.isArray(v.fail) ? v.fail.filter(function (x) { return x && x.mb > 0 }) : [],
      ok: typeof v.ok === 'number' ? v.ok : 0,
      ver: VER,
    }
  } catch (raw) {
    return { fail: [], ok: 0, ver: VER }
  }
}

// 写档位并清掉旧键
function save(v) {
  v.ver = VER
  try {
    wx.setStorageSync(KEY_VER, v)
    try { wx.removeStorageSync(KEY) } catch (e) {}
  } catch (raw) {}
}

// 两档是否同一档（±6%）
function near(a, b) {
  if (!(a > 0) || !(b > 0)) return false
  return Math.abs(Number(a) - Number(b)) <= Math.max(1, b * 0.06)
}

// 记录一次实测结果；budget 为当次猜测预算
function record(mbUsed, ok, budget) {
  const peak = mb(mbUsed)
  const base = Number(budget) > 0 ? Number(budget) : 0
  const v = load()
  if (ok) {
    if (peak > v.ok) { v.ok = peak; save(v) }
    dropOutdated(v)
    return v
  }
  for (let i = 0; i < v.fail.length; i++) {
    if (near(v.fail[i].mb, peak)) {
      v.fail[i].tries = (v.fail[i].tries || 1) + 1
      v.fail[i].mb = peak
      if (base > 0) v.fail[i].base = base
      v.fail[i].ts = Date.now()
      sort(v)
      save(v)
      return v
    }
  }
  v.fail.push({ mb: peak, tries: 1, base: base, ts: Date.now() })
  sort(v)
  if (v.fail.length > KEEP_FAIL) v.fail = v.fail.slice(v.fail.length - KEEP_FAIL)
  save(v)
  return v
}

// 失败档位按峰值升序
function sort(v) {
  v.fail.sort(function (a, b) { return a.mb - b.mb })
}

// 跑通的峰值超过某失败档位时，作废该档位
function dropOutdated(v) {
  if (!(v.ok > 0) || !v.fail.length) return
  const keep = v.fail.filter(function (x) { return x.mb > v.ok })
  if (keep.length !== v.fail.length) {
    v.fail = keep
    save(v)
  }
}

// 已采信的失败档位
function trusted(v) {
  return v.fail.filter(function (x) { return (x.tries || 1) >= MIN_TRIES })
}

// 估算本机可用上限（MB），不低于已跑通的峰值
function judgedCapMB() {
  const v = load()
  let cap = 0
  const list = trusted(v)
  for (let i = 0; i < list.length; i++) {
    const peak = list[i].mb
    if (peak > 0) cap = Math.max(cap, Math.round(peak * MARGIN))
  }
  if (v.ok > 0) {
    cap = Math.max(cap, Math.round(v.ok))
  }
  return cap
}

// 上限来源与明细，用于诊断文本
function capInfo(budget) {
  const v = load()
  const list = trusted(v)
  const guess = Number(budget) > 0 ? Number(budget) : 0
  let measured = 0
  for (let i = 0; i < list.length; i++) {
    if (list[i].mb > 0) measured = Math.max(measured, Math.round(list[i].mb * MARGIN))
  }
  const used = judgedCapMB()
  let source = 'guess'
  if (list.length && measured > 0) source = guess > 0 && guess < measured ? 'guess' : 'measured'
  else if (v.ok > 0) source = 'ok'
  return {
    cap: used || guess,
    source: source,
    measured: measured,
    ok: v.ok,
    fails: list.map(function (x) { return x.mb + '×' + (x.tries || 1) }).join(','),
  }
}

// 按实测上限判断某峰值能否处理；无实测数据时按猜测预算
function check(peakMB, budget) {
  const cap = judgedCapMB()
  const used = mb(peakMB)
  if (!cap) return { ok: used <= budget, known: false, cap: budget, mb: used }
  return { ok: used < cap, known: true, cap: cap, mb: used }
}

module.exports = {
  record: record,
  load: load,
  check: check,
  judgedCapMB: judgedCapMB,
  capInfo: capInfo,
  KEY: KEY,
  KEY_VER: KEY_VER,
}
