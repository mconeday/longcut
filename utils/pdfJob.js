/* PDF 导出管线：解码原图 → 逐页绘制 → 导出 JPEG → 拼 PDF → 超限降质重来
 * 降质阶梯：0.88@300 → 0.78@300 → 0.70@300 → 0.70@200，每轮整份重做
 */
const paper = require('./paper.js')
const pdf = require('./pdf.js')
const src = require('./sources.js')
const jpeg = require('./jpeg.js')

const TARGET_BYTES = 10 * 1024 * 1024      // 微信转发上限
const LADDER = [
  { q: 0.88, dpi: 300 },
  { q: 0.78, dpi: 300 },
  { q: 0.70, dpi: 300 },
  { q: 0.70, dpi: 200 },
]
const CANVAS_MAX = 3800                    // 画布单边留余量

function fail(code, msg, extra) {
  const e = new Error(msg || code)
  e.code = code
  if (extra) Object.assign(e, extra)
  return e
}

function fs() { return wx.getFileSystemManager() }

// 取页面上的画布节点
function acquireCanvas(page, selector) {
  return new Promise(function (resolve, reject) {
    if (!page || !wx.createSelectorQuery) return reject(fail('NO_CANVAS', '没有可用画布'))
    wx.createSelectorQuery()
      .in(page)
      .select(selector || '#export-canvas')
      .fields({ node: true, size: true })
      .exec(function (res) {
        const node = res && res[0] && res[0].node
        if (!node) return reject(fail('NO_CANVAS', '没有可用画布'))
        resolve(node)
      })
  })
}

// 在画布上解码图片
function loadImage(canvas, src) {
  return new Promise(function (resolve, reject) {
    let img = null
    try {
      img = canvas.createImage()
    } catch (raw) {
      return reject(fail('DECODE_FAILED', '画布不能创建图片', { raw: raw }))
    }
    if (!img) return reject(fail('DECODE_FAILED', '画布不能创建图片'))
    img.onload = function () { resolve(img) }
    img.onerror = function (raw) { reject(fail('DECODE_FAILED', '图片没能解码', { raw: raw })) }
    img.src = src
  })
}

// 解码失败时换 getImageInfo 给的路径再试一次
function loadImageSmart(canvas, src) {
  return loadImage(canvas, src).then(null, function (raw) {
    return new Promise(function (resolve, reject) {
      wx.getImageInfo({
        src: src,
        success: function (info) {
          const p = (info && info.path) || src
          if (p === src) return reject(raw)
          loadImage(canvas, p).then(resolve, reject)
        },
        fail: function () { reject(raw) },
      })
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
      success: function (r) { resolve(r.tempFilePath) },
      fail: function (c) { reject(fail('DECODE_FAILED', '压不动', { raw: c })) },
    })
  }).then(function (p) { return loadImage(canvas, p) })
}

function exportJpg(node, quality) {
  return new Promise(function (resolve, reject) {
    wx.canvasToTempFilePath({
      canvas: node,
      fileType: 'jpg',
      quality: quality,
      destWidth: node.width,
      destHeight: node.height,
      success: function (res) { resolve(res.tempFilePath) },
      fail: function (raw) { reject(fail('EXPORT_FAILED', '这一页没能导出', { raw: raw })) },
    })
  })
}

function readBytes(filePath) {
  return new Promise(function (resolve, reject) {
    fs().readFile({
      filePath: filePath,
      success: function (res) { resolve(new Uint8Array(res.data)) },
      fail: function (raw) { reject(fail('READ_FAILED', '导出的图读不回来', { raw: raw })) },
    })
  })
}

function unlinkQuiet(filePath) {
  try { fs().unlinkSync(filePath) } catch (raw) {}
}

// 文件名时间戳 YYYYMMDDHHmm
function stampText(now) {
  const d = now || new Date()
  const p = (v) => (v < 10 ? '0' + v : '' + v)
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + p(d.getHours()) + p(d.getMinutes())
}
// 文件名：时间戳_页数_纸张.pdf
function buildFilename(pageCount, paperName, now) {
  return stampText(now) + '_' + pageCount + '页_' + paperName + '.pdf'
}

// 渲染宽度：DPI 为上限，不放大原图
function renderWidth(imgW, contentWmm, dpi) {
  const need = Math.round(contentWmm / 25.4 * dpi)
  return Math.max(1, Math.min(imgW, need))
}

// 画布尺寸，两边不超过 CANVAS_MAX
function canvasSize(w, pageRatio) {
  let cw = w
  let ch = Math.round(w * pageRatio)
  if (ch > CANVAS_MAX) {
    ch = CANVAS_MAX
    cw = Math.round(ch / pageRatio)
  }
  if (cw > CANVAS_MAX) {
    cw = CANVAS_MAX
    ch = Math.round(cw * pageRatio)
  }
  return { w: Math.max(1, cw), h: Math.max(1, ch) }
}

function dirOf(path) {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i) : path
}

function writeFile(filePath, bytes) {
  return new Promise(function (resolve, reject) {
    const fsm = fs()
    try {
      fsm.mkdirSync(dirOf(filePath), true)
    } catch (raw) {}
    fsm.writeFile({
      filePath: filePath,
      data: bytes.buffer,
      success: function () { resolve(filePath) },
      fail: function (raw) { reject(fail('NOSPACE', '文件没能写到本机', { raw: raw })) },
    })
  })
}

/* 原图直嵌：不解码像素，按页裁切；不适用时返回 { skip } 交给重绘
 * 失败原因：read / jpeg / comps / orientation / dim / tall / size
 */
const DIRECT_MAX_PT = 30000          // 整图高度上限
const DIRECT_MAX_BYTES = 80 * 1024 * 1024

function directPdf(opt, sources, pages, geo) {
  const k = Number(opt.scaledK || 1)
  if (!(k > 0 && k < 1)) return Promise.resolve(null)
  if (!sources || !sources.length) return Promise.resolve(null)
  if (!pages.length) return Promise.resolve(null)
  const W = Number(opt.imgW) || 0
  if (!W) return Promise.resolve(null)

  const metas = []
  let totalBytes = 0
  let chain = Promise.resolve()
  for (let i = 0; i < sources.length; i++) {
    (function (s) {
      chain = chain.then(function (bad) {
        if (bad) return bad
        return readBytes(s.path).then(function (bytes) {
          totalBytes += bytes.length
          if (totalBytes > DIRECT_MAX_BYTES) return { skip: 'size' }
          const info = jpeg.info(bytes)
          if (!info) return { skip: 'jpeg' }
          if (info.comps !== 3) return { skip: 'comps' }
          if (info.orientation !== 1) return { skip: 'orientation' }
          // 文件尺寸须与虚拟尺寸一致
          if (Math.abs(info.w * k - s.w) > Math.max(2, s.w * 0.01)) return { skip: 'dim' }
          if (Math.abs(info.h * k - s.h) > Math.max(2, s.h * 0.01)) return { skip: 'dim' }
          metas.push({ bytes: bytes, info: info, s: s })
          return null
        }, function () { return { skip: 'read' } })
      })
    })(sources[i])
  }

  return chain.then(function (bad) {
    if (bad) return bad
    let maxW = 0
    for (let j = 0; j < metas.length; j++) {
      const m = metas[j]
      if (m.info.h * (geo.box.wPt / m.info.w) > DIRECT_MAX_PT) return { skip: 'tall' }
      if (m.info.w > maxW) maxW = m.info.w
    }

    const byPath = {}
    const images = metas.map(function (m, j) {
      byPath[m.s.path] = j
      return { jpeg: m.bytes, pxW: m.info.w, pxH: m.info.h }
    })

    const shots = []
    for (let i = 0; i < pages.length; i++) {
      const segs = src.pageSegments(sources, pages[i].from, pages[i].to)
      if (!segs.length) return { skip: 'dim' }
      const out = []
      for (let g = 0; g < segs.length; g++) {
        const seg = segs[g]
        const j = byPath[seg.src.path]
        const m = metas[j]
        const s = m.s
        // 虚拟行 → 原图行
        const y0 = Math.max(0, (seg.vTop - s.top) * m.info.h / s.sh)
        const y1 = Math.min(m.info.h, (seg.vTop + seg.vH - s.top) * m.info.h / s.sh)
        if (!(y1 - y0 >= 1)) return { skip: 'dim' }
        out.push({ im: j, y0: y0, y1: y1, vH: seg.vH })
      }
      shots.push({ segs: out, footer: (i + 1) + ' / ' + pages.length })
    }

    return {
      bytes: pdf.buildSliced({
        images: images,
        pages: shots,
        virtualW: W,
        media: geo.media,
        box: geo.box,
      }),
      quality: 1,
      dpi: Math.round(maxW / (geo.box.wPt / pdf.PT_PER_MM / 25.4)),
      attempts: 0,
      direct: true,
    }
  })
}

// 一轮渲染：逐页导出 JPEG 并收集成页数据
function renderOnce(job, quality, dpi) {
  const { node, imgW, pages, sources, control, hooks, total, scaledK } = job
  const w = renderWidth(imgW, job.contentWmm, dpi)
  const cache = {}
  let i = 0
  const shots = []

  function getImg(s) {
    if (cache[s.path]) return Promise.resolve(cache[s.path])
    return loadImageSmart(node, s.path).then(function (im) {
      cache[s.path] = im
      return im
    }, function (e) {
      // 解不动原图时压到该源高度再解
      if (!(Number(scaledK) < 1)) {
        if (e && !e.index) e.index = (s && s.index) || 0
        throw e
      }
      return decodeAtHeight(node, s.path, Math.max(1, Math.round(s.h))).then(function (im) {
        cache[s.path] = im
        return im
      }, function () {
        if (e && !e.index) e.index = (s && s.index) || 0
        throw e
      })
    })
  }

  // 丢掉已完全画过的源图
  function trimBefore(y) {
    for (const k in cache) {
      const s = sources.filter(function (x) { return x.path === k })[0]
      if (s && s.top + s.sh <= y) delete cache[k]
    }
  }

  function drawSegs(ctx, size, segs, imgs) {
    const k = size.w / imgW
    let dy = 0
    for (let n = 0; n < segs.length; n++) {
      const seg = segs[n]
      const dh = n === segs.length - 1 ? size.h - dy : Math.round(seg.vH * k)
      if (dh <= 0) continue
      ctx.drawImage(imgs[n], 0, seg.sy, seg.src.w, seg.sh, 0, dy, size.w, dh)
      dy += dh
    }
  }

  function next() {
    if (control.cancelled) return Promise.reject(fail('CANCELLED', '已停止'))
    if (i >= pages.length) return Promise.resolve(shots)

    const page = pages[i]
    const pageH = Math.max(1, page.h || (page.to - page.from))
    const size = canvasSize(w, pageH / imgW)
    const ctx = node.getContext('2d')
    const segs = src.pageSegments(sources, page.from, page.to)

    trimBefore(page.from)

    return Promise.all(segs.map(function (s) { return getImg(s.src) }))
      .then(function (imgs) {
        node.width = size.w
        node.height = size.h
        ctx.clearRect(0, 0, size.w, size.h)
        try {
          drawSegs(ctx, size, segs, imgs)
        } catch (raw) {
          return Promise.reject(fail('DRAW_FAILED', '这一页没画出来', { raw: raw, page: i + 1 }))
        }
        return exportJpg(node, quality)
      })
      .then(function (tmp) {
        // 第 1 页另存为封面
        if (shots.length === 0) job.coverTmp = tmp
        return readBytes(tmp).then(function (bytes) {
          if (shots.length !== 0) unlinkQuiet(tmp)
          return bytes
        })
      })
      .then(function (bytes) {
        shots.push({
          jpeg: bytes, pxW: size.w, pxH: size.h,
          footer: (shots.length + 1) + ' / ' + pages.length,
        })
        i++
        if (hooks.onPage) hooks.onPage(i, total)
        // 让出一帧，保持页面响应
        return new Promise(function (r) { setTimeout(r, 0) }).then(next)
      })
  }

  return next()
}

/* 主入口
 * opt: { imgPath, imgW, imgH, sources, pages, setting, page, selector, filename, scaledK }
 * hooks: { onAttempt(n), onPage(done,total) }
 * control: { cancelled }
 */
function run(opt, hooks, control) {
  hooks = hooks || {}
  control = control || {}
  const imgW = opt.imgW
  const pages = opt.pages || []
  if (!imgW) return Promise.reject(fail('NO_SIZE', '不知道原图有多宽'))
  if (!pages.length) return Promise.reject(fail('NO_PAGES', '没有页可以导出'))

  const sources = (opt.sources && opt.sources.length)
    ? opt.sources.map(function (s, i) { s.index = i + 1; return s })
    : (opt.imgPath ? [{
      path: opt.imgPath,
      w: imgW,
      h: opt.imgH || pages[pages.length - 1].to,
      top: 0,
      sh: opt.imgH || pages[pages.length - 1].to,
      scale: 1,
    }] : [])
  if (!sources.length) return Promise.reject(fail('NO_SOURCE', '不知道要导出哪张图'))

  const resolved = paper.resolve(opt.setting)
  const geo = pdf.geometry(resolved)
  const total = pages.length
  const filename = opt.filename || buildFilename(total, resolved.name)
  const dir = (wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '') + '/pdf'
  const filePath = dir + '/' + filename
  const t0 = Date.now()

  let node = null
  let renderJob = null
  let attempt = 0
  let last = null

  function renderAll() {
    return acquireCanvas(opt.page, opt.selector)
      .then(function (n) {
        node = n
        renderJob = {
          node: node, imgW: imgW, pages: pages, sources: sources,
          control: control, hooks: hooks, total: total,
          contentWmm: resolved.contentWmm,
          scaledK: Number(opt.scaledK) || 1,
        }

        function step() {
          const level = LADDER[Math.min(attempt, LADDER.length - 1)]
          attempt++
          if (hooks.onAttempt) hooks.onAttempt(attempt)
          return renderOnce(renderJob, level.q, level.dpi).then(function (shots) {
            const bytes = pdf.build({ pages: shots, media: geo.media, box: geo.box })
            last = {
              bytes: bytes,
              quality: level.q,
              dpi: level.dpi,
              attempts: attempt,
              overLimit: bytes.length > TARGET_BYTES,
            }
            // 达标即停；最后一档超限也导出
            if (!last.overLimit || attempt >= LADDER.length) return last
            return step()
          })
        }

        return step()
      })
  }

  return directPdf(opt, sources, pages, geo)
    .then(function (d) {
      if (!d || !d.bytes) return renderAll().then(function (res) {
        if (d && d.skip) res.directSkip = d.skip
        return res
      })
      if (hooks.onPage) hooks.onPage(total, total)
      last = d
      return d
    })
    .then(function (res) {
      return writeFile(filePath, res.bytes).then(function () {
        const finish = function (coverPath) {
          return {
            filePath: filePath,
            filename: filename,
            coverPath: coverPath || '',
            bytes: res.bytes,
            sizeBytes: res.bytes.length,
            sizeMB: res.bytes.length / (1024 * 1024),
            quality: res.quality,
            dpi: res.dpi,
            attempts: res.attempts,
            overLimit: res.overLimit,
            direct: !!res.direct,
            directSkip: res.directSkip || '',
            pages: total,
            paperName: resolved.name,
            ms: Date.now() - t0,
          }
        }
        if (!renderJob || !renderJob.coverTmp) return finish('')
        const coverPath = filePath.replace(/\.pdf$/, '.cover.jpg')
        return readBytes(renderJob.coverTmp)
          .then(function (bytes) {
            unlinkQuiet(renderJob.coverTmp)
            renderJob.coverTmp = ''
            return writeFile(coverPath, bytes)
          })
          .then(function () { return finish(coverPath) })
          .catch(function () { return finish('') })
      })
    })
}

module.exports = {
  run: run,
  buildFilename: buildFilename,
  stampText: stampText,
  renderWidth: renderWidth,
  canvasSize: canvasSize,
  LADDER: LADDER,
  TARGET_BYTES: TARGET_BYTES,
}
