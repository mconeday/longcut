/* 分页任务管线：读尺寸 → 拼虚拟长图 → 分块绘制解码 → 扫描 → 规划页边界
 * 失败就整组压一档重跑，压到下限仍失败才报错
 */
const { createScan, scanFeed, plan, evenSplit } = require('./paginate.js')
const paper = require('./paper.js')
const capacity = require('./capacity.js')

const BAND_ROWS = 2048      // 每次读像素的默认行数
const MIN_BAND_ROWS = 256   // 块高下限

// 重试缩放比例（累计 0.75 / 0.41 / 0.165）
const RETRY_SCALES = [0.75, 0.55, 0.4]
const MIN_OUT_W = 700                    // 虚拟宽下限，约 90dpi
const MIN_TOTAL_K = 0.4                  // 累计缩放下限
const RETRY_CODES = { MEMORY: 1, DRAW_FAILED: 1, DECODE_FAILED: 1, TOO_WIDE: 1 }

// 整组按同一比例压缩
function prescaleSources(canvas, list, k) {
  let chain = Promise.resolve()
  for (let i = 0; i < list.length; i++) {
    (function (s, index) {
      chain = chain.then(function () {
        return compressTo(canvas, s.path, s.h * k).then(function (c) {
          s.path = c.path
          s.w = c.w
          s.h = c.h
        }, function (e) {
          if (e && !e.index) e.index = index + 1
          throw e
        })
      })
    })(list[i], i)
  }
  return chain.then(function () { return list })
}

const MAX_WIDTH = 4096      // iOS 单画布上限
const BUDGET_HIGH_MB = 512  // iOS / 高配 Android
const BUDGET_LOW_MB = 256   // 低配 Android

function bitmapMB(w, h) { return (w * h * 4) / (1024 * 1024) }

// 同时在场位图的峰值（最大两张之和）
function peakBitmapMB(list) {
  const mbs = list.map(function (x) { return bitmapMB(x.w, x.h) })
    .sort(function (a, b) { return b - a })
  let mb = mbs[0] || 0
  if (list.length > 1) mb += mbs[1] || 0
  return Math.round(mb)
}

// 机型猜测预算
function guessBudgetMB() {
  try {
    const s = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()
    const lv = s && s.benchmarkLevel
    const android = s && String(s.platform || '').toLowerCase() === 'android'
    if (android && typeof lv === 'number' && lv >= 0 && lv < 10) return BUDGET_LOW_MB
  } catch (raw) {}
  return BUDGET_HIGH_MB
}

// 本机预算 = min(机型猜测, 实测上限)
function budgetMB() {
  const guess = guessBudgetMB()
  const cap = capacity.judgedCapMB()
  return cap > 0 && cap < guess ? cap : guess
}

// 预算与来源
function budgetInfo() {
  const guess = guessBudgetMB()
  const info = capacity.capInfo(guess)
  const cap = info.cap
  const useCap = cap > 0 && cap < guess
  return {
    mb: useCap ? cap : guess,
    guess: guess,
    cap: cap,
    source: useCap ? info.source : (info.source === 'measured' || info.source === 'ok' ? 'guess' : info.source),
    measured: info.measured,
    okMB: info.ok,
    fails: info.fails,
  }
}

function fail(code, msg, extra) {
  const e = new Error(msg || code)
  e.code = code
  if (extra) Object.assign(e, extra)
  return e
}

// 色差预检阈值：blankRatio 过高说明气泡被判成了空白
const CONTRAST_RATIO = 0.30

function suspectLowContrast(stats, pageCount) {
  if (!stats || !pageCount || pageCount < 2) return false
  const r = stats.blankRatio
  if (typeof r !== 'number') return false
  return r >= CONTRAST_RATIO && r <= 0.85
}

function getImageInfo(src) {
  return new Promise(function (resolve, reject) {
    wx.getImageInfo({
      src: src,
      success: resolve,
      fail: function (raw) { reject(fail('READ_FAILED', '图片没能读进来', { raw: raw })) },
    })
  })
}

// 取画布：优先离屏，失败退回页面隐藏节点
function acquireCanvas(page, width, height) {
  const offscreen = new Promise(function (resolve, reject) {
    if (!wx.createOffscreenCanvas) return reject(fail('NO_OFFSCREEN', '没有离屏画布'))
    let c = null
    try {
      c = wx.createOffscreenCanvas({ type: '2d', width: width, height: height })
    } catch (raw) {
      return reject(fail('NO_OFFSCREEN', '离屏画布创建失败', { raw: raw }))
    }
    if (!c || typeof c.getContext !== 'function') return reject(fail('NO_OFFSCREEN', '离屏画布不可用'))
    if (typeof c.createImage !== 'function') return reject(fail('NO_OFFSCREEN', '离屏画布不能创建图片'))
    resolve(c)
  })

  return offscreen.catch(function () {
    return new Promise(function (resolve, reject) {
      if (!page || !wx.createSelectorQuery) return reject(fail('NO_CANVAS', '没有可用画布'))
      wx.createSelectorQuery()
        .in(page)
        .select('#scan-canvas')
        .fields({ node: true, size: true })
        .exec(function (res) {
          const node = res && res[0] && res[0].node
          if (!node) return reject(fail('NO_CANVAS', '没有可用画布'))
          node.width = width
          node.height = height
          resolve(node)
        })
    })
  })
}

function loadImage(canvas, src) {
  return new Promise(function (resolve, reject) {
    let img = null
    try {
      img = canvas.createImage()
    } catch (raw) {
      return reject(fail('NO_CANVAS', '画布不能创建图片', { raw: raw }))
    }
    if (!img) return reject(fail('NO_CANVAS', '画布不能创建图片'))
    img.onload = function () { resolve(img) }
    img.onerror = function (raw) { reject(fail('DECODE_FAILED', '图片没能解码', { raw: raw })) }
    img.src = src
  })
}

/* 解码图片，逐层兜底：
 *   create → getImageInfo 重取路径 → 拷进用户目录 → compressImage 重编码
 * forcedH > 0 时改走压缩路径，并按 1 / 0.75 / 0.5 / 0.34 逐级降高
 */
function loadImageSmart(canvas, src, forcedH) {
  if (forcedH) {
    const LADDER = [1, 0.75, 0.5, 0.34]
    let chain = Promise.reject(fail('DECODE_FAILED', '压不动'))
    for (let i = 0; i < LADDER.length; i++) {
      (function (f) {
        chain = chain.then(null, function () {
          return decodeAtHeight(canvas, src, Math.max(512, Math.round(forcedH * f)))
            .then(null, function (e) {
              e.stage = 'forced-' + Math.round(forcedH * f)
              throw e
            })
        })
      })(LADDER[i])
    }
    return chain
  }
  const first = loadImage(canvas, src).then(null, function (raw) {
    raw.stage = 'create'
    return getImageInfo(src).then(function (info) {
      const p = (info && info.path) || src
      if (p === src) throw raw
      return loadImage(canvas, p).then(null, function (e2) {
        e2.stage = 'converted'
        throw e2
      })
    }, function (g) {
      if (g && g.errMsg && raw && !raw.errMsg) raw.errMsg = g.errMsg
      throw raw
    })
  })
  return first.then(null, function (e) {
    if (!wx.env || !wx.env.USER_DATA_PATH) throw e
    const dest = wx.env.USER_DATA_PATH + '/ls_fb_copy.jpg'
    return new Promise(function (resolve, reject) {
      wx.getFileSystemManager().copyFile({
        srcPath: src,
        destPath: dest,
        success: function () { resolve(dest) },
        fail: function () { reject(e) },
      })
    }).then(function (p) {
      return loadImage(canvas, p).then(null, function (e3) {
        e3.stage = 'copied'
        // 再走一次原生重编码
        if (!wx.compressImage) throw e3
        return new Promise(function (resolve, reject) {
          wx.compressImage({
            src: p,
            quality: 80,
            success: (r) => resolve(r.tempFilePath),
            fail: function (c) {
              if (c && c.errMsg && e3 && !e3.errMsg) e3.errMsg = c.errMsg
              reject(e3)
            },
          })
        }).then(function (re) {
          return loadImage(canvas, re).then(null, function (e4) {
            e4.stage = 'recompressed'
            throw e4
          })
        }, function () { throw e3 })
      })
    }, function () { throw e })
  })
}

// 压到指定高度并读回尺寸
function compressTo(canvas, path, h) {
  return new Promise(function (resolve, reject) {
    wx.compressImage({
      src: path,
      quality: 90,
      compressedHeight: Math.max(1, Math.round(h)),
      success: (r) => resolve(r.tempFilePath),
      fail: (c) => reject(fail('DECODE_FAILED', '压不动', { raw: c, stage: 'compress-' + h })),
    })
  }).then(function (p) {
    return loadImage(canvas, p).then(function (im) {
      return { path: p, w: im.width, h: im.height }
    })
  })
}

// 压到指定高度再解码
function decodeAtHeight(canvas, src, h) {
  return new Promise(function (resolve, reject) {
    wx.compressImage({
      src: src,
      quality: 90,
      compressedHeight: h,
      success: (r) => resolve(r.tempFilePath),
      fail: (c) => reject(fail('DECODE_FAILED', '压不动', { raw: c, stage: 'compress-' + h })),
    })
  }).then(function (p) { return loadImage(canvas, p) })
}

// 抽样检查画布是否全空（部分机型画长图不报错但画不出）
function looksEmpty(data, width, height) {
  const rows = Math.min(8, height)
  let checked = 0
  for (let r = 0; r < rows; r++) {
    const y = Math.floor(r * (height - 1) / Math.max(1, rows - 1))
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 32))) {
      const i = (y * width + x) * 4
      if (data[i] || data[i + 1] || data[i + 2] || data[i + 3]) return false
      checked++
    }
  }
  return checked > 0
}

// 归一入参：images 优先，imgPath 兼容单图
function normalizeSources(opt) {
  if (opt && opt.images && opt.images.length) {
    return opt.images.map(function (it) {
      return {
        path: it.path || it.tempFilePath || it.imgPath,
        w: it.width || it.w || 0,
        h: it.height || it.h || 0,
        size: it.size || 0,
      }
    })
  }
  if (opt && opt.imgPath) return [{ path: opt.imgPath, w: 0, h: 0, size: 0 }]
  return []
}

// 排虚拟长图：统一宽度，算 top / 缩放高 / 拼接缝
function layoutSources(list) {
  let W = 0
  for (let i = 0; i < list.length; i++) W = Math.max(W, list[i].w)
  let top = 0
  for (let j = 0; j < list.length; j++) {
    const s = list[j]
    s.scale = W / s.w
    s.sh = Math.max(1, Math.round(s.h * s.scale))
    s.top = top
    top += s.sh
  }
  const breaks = []
  for (let k = 1; k < list.length; k++) breaks.push(list[k].top)
  return { width: W, height: top, breaks: breaks }
}

// 补齐缺失的宽高
function resolveSizes(list) {
  let chain = Promise.resolve()
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    if (s.w && s.h) continue
    chain = chain.then(function () {
      return getImageInfo(s.path).then(function (info) {
        s.w = info.width
        s.h = info.height
        if (info.path) s.path = info.path
        if (!s.w || !s.h) throw fail('NO_SIZE', '读不到这张图的尺寸', { index: i + 1 })
      }).catch(function (e) {
        if (e && !e.index) e.index = i + 1
        if (e && e.raw && e.raw.errMsg) e.errMsg = e.raw.errMsg
        throw e
      })
    })
  }
  return chain.then(function () { return list })
}

// 逐张、逐块扫描像素
function scanAll(job) {
  const { ctx, sources, width, height, control, hooks, mem } = job
  const band = Math.max(MIN_BAND_ROWS, Math.min(job.bandRows || BAND_ROWS, BAND_ROWS))
  const scan = job.scan || createScan(width, Math.min(height || 0, 4096))
  let totalBands = 0
  for (let i = 0; i < sources.length; i++) {
    totalBands += Math.max(1, Math.ceil(sources[i].sh / band))
  }
  let doneBands = 0
  let scanned = 0
  let si = 0
  let rel = 0
  let img = null

  // 断点续扫：把已扫行数换算回「第几张 + 图内偏移」
  if (job.startAt) {
    scanned = Math.min(job.startAt, height || job.startAt)
    si = sources.length
    for (let i = 0; i < sources.length; i++) {
      if (scanned >= sources[i].top && scanned < sources[i].top + sources[i].sh) {
        si = i
        rel = scanned - sources[i].top
        break
      }
      if (sources[i].top === scanned) { si = i; rel = 0; break }
    }
    doneBands = Math.round(scanned / band)
  }

  function frame() { return new Promise(function (r) { setTimeout(r, 0) }) }

  // 中断时把已扫结果交给调用方
  function bail(code, msg, extra) {
    if (control) {
      control.partial = {
        scan: scan,
        sources: sources.map(function (s) {
          return { path: s.path, w: s.w, h: s.h, top: s.top, sh: s.sh, scale: s.scale }
        }),
        breaks: (job.breaks || []).slice(),
        width: width,
        height: height,
        scaledK: job.scaledK || 1,
        bandRows: job.bandRows || BAND_ROWS,
        scanned: Math.max(0, scanned),
      }
    }
    return fail(code, msg, extra)
  }

  function next() {
    if (control.cancelled) return Promise.reject(bail('CANCELLED', '已停止'))
    // level 15 才停，level 10 只记下
    if (mem && mem.warned) {
      return Promise.reject(bail('MEMORY', '本机内存吃紧', { at: scanned, level: mem.warned }))
    }
    if (si >= sources.length) return Promise.resolve(scan)
    const src = sources[si]

    if (!img) {
      // 上游已解码好的第一张直接复用
      if (src._img) {
        img = src._img
        src._img = null
        return next()
      }
      return loadImageSmart(job.canvas, src.path, job.forcedH ? Math.round(src.h) : 0).then(function (im) {
        img = im
        return next()
      }, function (e) {
        if (e && !e.index) e.index = si + 1
        throw e
      })
    }
    if (rel >= src.sh) {
      img = null
      si++
      rel = 0
      return frame().then(next)
    }

    const bh = Math.min(band, src.sh - rel)
    const srcY = Math.floor(rel / src.scale)
    let srcH = Math.ceil(bh / src.scale)
    if (srcY + srcH > src.h) srcH = Math.max(1, src.h - srcY)

    let data = null
    let drawErr = null
    try {
      ctx.clearRect(0, 0, width, bh)
      try {
        ctx.drawImage(img, 0, srcY, src.w, srcH, 0, 0, width, bh)
      } catch (raw) {
        // 兜底：整图位移 + 横向缩放
        ctx.clearRect(0, 0, width, bh)
        ctx.save()
        ctx.translate(0, -srcY)
        ctx.scale(width / src.w, 1)
        ctx.drawImage(img, 0, 0, src.w, src.h)
        ctx.restore()
      }
      const imageData = ctx.getImageData(0, 0, width, bh)
      data = imageData && imageData.data
    } catch (raw) {
      drawErr = fail('DRAW_FAILED', '这一段没画出来', {
        raw: raw, at: src.top + rel, bandRows: band, canvasW: width,
      })
    }
    if (!drawErr && (!data || data.length < width * bh * 4)) {
      drawErr = fail('DRAW_FAILED', '这一段没画出来', {
        at: src.top + rel, bandRows: band, canvasW: width, level: 'getImageData',
      })
    }
    if (!drawErr && looksEmpty(data, width, bh)) {
      drawErr = fail('DRAW_FAILED', '这一段是空白', {
        at: src.top + rel, bandRows: band, canvasW: width, level: 'empty',
      })
    }

    // 画不出来：块高未降到下限时交给外层降块高，否则单张降采样再试
    if (drawErr) {
      if (band > MIN_BAND_ROWS) return Promise.reject(drawErr)
      if (src.shrunk) {
        if (!drawErr.index) drawErr.index = si + 1
        drawErr.shrunk = true
        return Promise.reject(drawErr)
      }
      const nextH = Math.max(512, Math.round(src.h * 0.7))
      return decodeAtHeight(job.canvas, src.path, nextH).then(function (im) {
        src.h = im.height
        src.w = im.width
        src.shrunk = true
        src.scale = width / src.w
        src.sh = Math.max(1, Math.round(src.h * src.scale))
        img = im
        rel = Math.min(rel, src.sh)
        return frame().then(next)
      }, function (e) {
        if (!drawErr.index) drawErr.index = si + 1
        drawErr.shrinkFailed = (e && e.stage) || 'compress'
        return Promise.reject(drawErr)
      })
    }

    scanFeed(scan, src.top + rel, { width: width, height: bh, data: data })
    doneBands++
    rel += bh
    scanned = src.top + rel
    if (hooks.onProgress) {
      hooks.onProgress(1, 0.10 + 0.78 * (scanned / height), {
        rows: scanned,
        height: height,
        bands: doneBands,
        totalBands: totalBands,
      })
    }

    return frame().then(next)
  }

  return next()
}

const MEM_HARD = 15
const MEM_SOFT = 10

// 内存告警监听：level 15 记为硬告警，10 记为软告警
function attachMemWatch() {
  const mem = { warned: 0, soft: 0 }
  const onMemWarn = function (res) {
    const lv = (res && res.level) || 0
    if (lv >= MEM_HARD) mem.warned = lv
    else if (lv >= MEM_SOFT && !mem.soft) mem.soft = lv
  }
  if (wx.onMemoryWarning) {
    try { wx.onMemoryWarning(onMemWarn) } catch (raw) {}
  }
  function release() {
    if (wx.offMemoryWarning) {
      try { wx.offMemoryWarning(onMemWarn) } catch (raw) {}
    }
  }
  return { mem: mem, release: release }
}

/* 主入口
 * opt: { images, imgPath, setting, page, onePerPage, resume }
 * hooks: { onProgress(stage, pct, extra), onStage(stage) }
 * control: { cancelled, partial }
 */
function run(opt, hooks, control) {
  hooks = hooks || {}
  control = control || {}
  const resume = (opt && opt.resume && opt.resume.scan) ? opt.resume : null
  if (resume) return runAttempt(opt, hooks, control, 1, resume)

  let idx = -1        // -1 = 原图那一轮
  let tried = []      // 已压过的比例
  const origW = (opt.images && opt.images.length)
    ? Math.max.apply(null, opt.images.map(function (x) { return x.width || 0 }))
    : 0

  function go() {
    const k = idx < 0 ? 1 : RETRY_SCALES[idx]
    return runAttempt(opt, hooks, control, k, null, idx < 0 ? 0 : idx + 1).then(null, function (e) {
      if (control.cancelled) throw e
      if (!e || !RETRY_CODES[e.code]) throw e
      const nextIdx = idx + 1
      if (nextIdx >= RETRY_SCALES.length) {
        e.tried = tried
        throw e
      }
      // 压到下限就停
      const nextK = RETRY_SCALES[nextIdx]
      const totalK = k * nextK
      const estW = origW ? Math.round(origW * totalK) : 0
      if (totalK < MIN_TOTAL_K || (estW && estW < MIN_OUT_W)) {
        e.tried = tried
        throw e
      }
      tried = tried.concat([Math.round(k * nextK * 100) / 100])
      idx = nextIdx
      control.partial = null
      if (hooks.onProgress) {
        hooks.onProgress(0, 0.02, { rows: 0, height: 0, width: 0, retry: idx + 1 })
      }
      return go()
    })
  }
  return go()
}

// 单轮：preScale < 1 时先把整组压到该比例
function runAttempt(opt, hooks, control, preScale, forcedResume, retryNo) {
  const resume = forcedResume || ((opt && opt.resume && opt.resume.scan) ? opt.resume : null)
  const t0 = Date.now()
  const sources = resume ? resume.sources : normalizeSources(opt)
  if (!sources.length) return Promise.reject(fail('READ_FAILED', '没有可处理的图片'))

  let knownW = resume ? resume.width : 0
  let knownH = resume ? resume.height : 0
  let scaledK = resume ? (resume.scaledK || 1) : 1
  let bandRows = resume ? (resume.bandRows || BAND_ROWS) : BAND_ROWS
  let layout = resume
    ? { width: resume.width, height: resume.height, breaks: resume.breaks || [] }
    : null
  function progress(stage, pct, extra) {
    if (!hooks.onProgress) return
    const e = { rows: 0, height: knownH, width: knownW }
    if (extra) for (const k in extra) e[k] = extra[k]
    hooks.onProgress(stage, Math.max(0, Math.min(1, pct)), e)
  }

  if (hooks.onStage) hooks.onStage(0)
  const watch = attachMemWatch()
  const mem = watch.mem
  const releaseMemHook = watch.release
  const head = resume
    ? Promise.resolve(null)
    : resolveSizes(sources).then(function (list) {
      for (let i = 0; i < list.length; i++) {
        if (!list[i].w || !list[i].h) throw fail('NO_SIZE', '读不到这张图的尺寸')
        if (list[i].w > MAX_WIDTH) {
          throw fail('TOO_WIDE', '这张图有 ' + list[i].w + 'px 宽', { width: list[i].w, index: i + 1 })
        }
      }
      if (!(preScale > 0) || preScale >= 1) {
        layout = layoutSources(list)
        knownW = layout.width
        knownH = layout.height
        return null
      }
      return acquireCanvas(opt.page, 1, 1).then(function (tiny) {
        return prescaleSources(tiny, list, preScale)
      }).then(function (small) {
        layout = layoutSources(small)
        knownW = layout.width
        knownH = layout.height
        scaledK = preScale
        return null
      })
    })

  const task = head
    .then(function () {
      progress(0, resume ? 0.06 : 0.02)
      return acquireCanvas(opt.page, layout.width, Math.min(BAND_ROWS, layout.height))
    })
    .then(function (canvas) {
      const ctx = canvas.getContext('2d')
      if (!ctx) throw fail('NO_CANVAS', '画布不可用')
      const base = {
        canvas: canvas,
        ctx: ctx,
        width: layout.width,
        height: layout.height,
        breaks: layout.breaks || [],
        control: control,
        hooks: hooks,
        mem: mem,
        scaledK: scaledK,
      }
      // 画布撑不住时降块高重扫
      function scanWithLadder(rows) {
        base.canvas.width = layout.width
        base.canvas.height = Math.min(rows, layout.height)
        base.bandRows = rows
        bandRows = rows
        return scanAll(base).then(null, function (e) {
          if (!e || e.code !== 'DRAW_FAILED') throw e
          const half = Math.floor(rows / 2)
          if (half < MIN_BAND_ROWS) {
            e.bandRows = rows
            e.triedBands = true
            throw e
          }
          delete base.scan
          base.startAt = 0
          progress(0, 0.10)
          return scanWithLadder(half)
        })
      }

      if (resume) {
        base.scan = resume.scan
        base.startAt = resume.scanned
        base.sources = sources
        base.forcedH = !!(resume.scaledK && resume.scaledK < 1)
        base.bandRows = resume.bandRows || BAND_ROWS
        if (hooks.onStage) hooks.onStage(1)
        return scanWithLadder(base.bandRows)
      }
      progress(0, 0.05)
      // 第一张解码失败时整组等比降采样
      return loadImageSmart(canvas, sources[0].path).then(function (first) {
        progress(0, 0.10)
        if (hooks.onStage) hooks.onStage(1)
        base.sources = sources.map(function (s, i) {
          return { path: s.path, w: s.w, h: s.h, top: s.top, sh: s.sh, scale: s.scale, _img: i === 0 ? first : null }
        })
        return scanWithLadder(BAND_ROWS)
      }, function (e1) {
        if (e1 && !e1.index) e1.index = 1
        const TRY = [8192, 4096, 2048]
        let chain = Promise.reject(e1)
        for (let i = 0; i < TRY.length; i++) {
          (function (h) {
            chain = chain.then(null, function () {
              return decodeAtHeight(canvas, sources[0].path, h).then(null, function (e) {
                e.stage = 'scaled-' + h
                throw e
              })
            })
          })(TRY[i])
        }
        return chain.then(function (first) {
          const k = first.height / sources[0].h
          if (!(k > 0 && k < 1)) throw e1
          for (let j = 0; j < sources.length; j++) {
            sources[j].w = Math.max(1, Math.round(sources[j].w * k))
            sources[j].h = Math.max(1, Math.round(sources[j].h * k))
          }
          layout = layoutSources(sources)
          knownW = layout.width
          knownH = layout.height
          scaledK = k
          progress(0, 0.10)
          if (hooks.onStage) hooks.onStage(1)
          base.forcedH = true
          // 回写降采样系数与尺寸，供续扫沿用
          base.scaledK = k
          base.width = layout.width
          base.height = layout.height
          base.sources = sources.map(function (s, i) {
            return { path: s.path, w: s.w, h: s.h, top: s.top, sh: s.sh, scale: s.scale, _img: i === 0 ? first : null }
          })
          return scanWithLadder(BAND_ROWS)
        }, function (e) {
          if (e && !e.index) e.index = 1
          throw e
        })
      })
    })
    .then(function (scan) {
      if (control.cancelled) throw fail('CANCELLED', '已停止')
      if (hooks.onStage) hooks.onStage(2)
      progress(2, 0.90)

      const W = layout.width
      const H = layout.height
      const cap = paper.capacity(W, opt.setting)

      let result = null
      let degraded = false
      try {
        result = plan(scan, H, cap, {
          breaks: layout.breaks,
          onePerPage: !!opt.onePerPage,
        })
      } catch (raw) {
        // 算法异常时降级均分
        result = evenSplit(H, cap)
        degraded = true
        result.error = raw && raw.message
      }
      progress(2, 0.97)

      const pages = result.pages.map(function (p, i) {
        return { index: i + 1, from: p.from, to: p.to, h: p.to - p.from }
      })

      // 内容块平铺成 [top,bottom,...]
      const blocks = []
      const bl = result.blocks || []
      for (let b = 0; b < bl.length; b++) {
        blocks.push(bl[b].top, bl[b].bottom)
      }

      return {
        imgPath: sources.length === 1 ? sources[0].path : '',
        sources: sources.map(function (s) {
          return { path: s.path, w: s.w, h: s.h, top: s.top, sh: s.sh, scale: s.scale }
        }),
        breaks: layout.breaks,
        width: W,
        height: H,
        cap: cap,
        pages: pages,
        cuts: (result.cuts || []).map(function (c) { return { y: c.y, forced: !!c.forced } }),
        blocks: blocks,
        stampCount: (result.stamps || []).length,
        stats: result.stats,
        degraded: degraded || !!result.degraded,
        lowContrast: suspectLowContrast(result.stats, pages.length),
        ms: Date.now() - t0,
        scaledK: scaledK,
        memWarn: mem.soft || 0,
        bandRows: bandRows,
        retryNo: retryNo || 0,
        shrunkCount: sources.filter(function (s) { return s.shrunk }).length,
        setting: Object.assign({}, opt.setting),
      }
    })

  // 只记录成功的实测档位
  function recordCapacity(ok, err) {
    if (!ok) return
    const peak = peakBitmapMB(sources.map(function (s) {
      return { w: s.w, h: s.h }
    }))
    if (peak > 0) capacity.record(peak, !!ok, guessBudgetMB())
  }

  return task.then(
    function (v) { releaseMemHook(); recordCapacity(true); return v },
    function (e) { releaseMemHook(); recordCapacity(false, e); throw e }
  )
}

// 续扫缓存：只留一格，5 分钟过期
let RESUME = null

function stashResume(token, partial) {
  if (!token || !partial) return null
  RESUME = { token: token, state: partial, at: Date.now() }
  return RESUME
}

function takeResume(token) {
  if (!RESUME) return null
  if (token && RESUME.token !== token) return null
  const fresh = Date.now() - RESUME.at < 5 * 60 * 1000
  const st = RESUME.state
  RESUME = null
  return fresh ? st : null
}

module.exports = {
  run: run,
  BAND_ROWS: BAND_ROWS,
  MAX_WIDTH: MAX_WIDTH,
  CONTRAST_RATIO: CONTRAST_RATIO,
  bitmapMB: bitmapMB,
  peakBitmapMB: peakBitmapMB,
  budgetMB: budgetMB,
  budgetInfo: budgetInfo,
  guessBudgetMB: guessBudgetMB,
  suspectLowContrast: suspectLowContrast,
  layoutSources: layoutSources,
  normalizeSources: normalizeSources,
  stashResume: stashResume,
  takeResume: takeResume,
}
