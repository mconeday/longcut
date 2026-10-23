/* 最小 PDF 写出器：JPEG 直嵌（/DCTDecode），纯字节输入输出
 * 单位 pt（1/72 英寸），坐标原点在左下角
 */
const PT_PER_MM = 72 / 25.4

// PDF 数字：最多 4 位小数，去掉尾随 0
function num(v) {
  const s = (Math.round(v * 10000) / 10000).toFixed(4)
  if (s.indexOf('.') < 0) return s
  return s.replace(/0+$/, '').replace(/\.$/, '')
}

// 字符串转 ASCII 字节
function ascii(str) {
  const out = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff
  return out
}

function toBytes(x) {
  if (x instanceof Uint8Array) return x
  if (x && x.byteLength !== undefined) return new Uint8Array(x)
  throw new Error('jpeg 必须是 ArrayBuffer 或 Uint8Array')
}

// 转义 PDF 字符串中的反斜杠与括号
function escapeText(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/* 每页一张 JPEG 全幅摆放
 * doc = {
 *   pages: [{ jpeg, pxW, pxH, footer? }],
 *   media: { wPt, hPt },
 *   box:   { xPt, yPt, wPt, hPt },
 *   footerSizePt?
 * }
 */
function build(doc) {
  const pages = (doc && doc.pages) || []
  if (!pages.length) throw new Error('没有页可写')
  if (!doc.media || !doc.box) throw new Error('缺少纸张/内容区尺寸')

  const chunks = []
  let size = 0
  function put(b) { chunks.push(b); size += b.length }
  function putStr(s) { put(ascii(s)) }

  const n = pages.length
  const idCatalog = 1
  const idPages = 2
  const idFont = 3
  const idPage = (i) => 4 + i * 3
  const idContent = (i) => 5 + i * 3
  const idImage = (i) => 6 + i * 3
  const count = 4 + n * 3               // 对象数 + 1
  const offsets = new Array(count)

  function obj(id, dict, stream) {
    offsets[id] = size
    putStr(id + ' 0 obj\n')
    putStr(dict)
    if (stream) {
      putStr('\nstream\n')
      put(stream)
      putStr('\nendstream')
    }
    putStr('\nendobj\n')
  }

  putStr('%PDF-1.4\n')
  put(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]))

  obj(idCatalog, '<< /Type /Catalog /Pages ' + idPages + ' 0 R >>')

  let kids = ''
  for (let i = 0; i < n; i++) kids += idPage(i) + ' 0 R '
  obj(idPages, '<< /Type /Pages /Kids [' + kids.trim() + '] /Count ' + n + ' >>')

  obj(idFont, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  const media = doc.media
  const box = doc.box
  const footerSize = doc.footerSizePt || 8

  for (let i = 0; i < n; i++) {
    const p = pages[i]
    const jpeg = toBytes(p.jpeg)
    const pxW = p.pxW
    const pxH = p.pxH

    // 等比缩放并居中
    const scale = Math.min(box.wPt / pxW, box.hPt / pxH)
    const w = pxW * scale
    const h = pxH * scale
    const x = box.xPt + (box.wPt - w) / 2
    const y = box.yPt + (box.hPt - h) / 2

    obj(
      idPage(i),
      '<< /Type /Page /Parent ' + idPages + ' 0 R /MediaBox [0 0 '
        + num(media.wPt) + ' ' + num(media.hPt) + ']'
        + ' /Resources << /XObject << /Im0 ' + idImage(i) + ' 0 R >>'
        + ' /Font << /F1 ' + idFont + ' 0 R >> >>'
        + ' /Contents ' + idContent(i) + ' 0 R >>'
    )

    let content = 'q\n' + num(w) + ' 0 0 ' + num(h) + ' ' + num(x) + ' ' + num(y)
      + ' cm\n/Im0 Do\nQ'

    // 页码画在纸张下边距内，水平居中
    if (p.footer) {
      const label = String(p.footer)
      const textW = 0.52 * footerSize * label.length
      const cx = Math.max(0, (media.wPt - textW) / 2)
      const cy = Math.max(6, box.yPt / 2 - footerSize / 2)
      content += '\n0.45 g\nBT\n/F1 ' + num(footerSize) + ' Tf\n'
        + num(cx) + ' ' + num(cy) + ' Td\n(' + escapeText(label) + ') Tj\nET'
    }

    obj(
      idContent(i),
      '<< /Length ' + ascii(content).length + ' >>',
      ascii(content)
    )

    obj(
      idImage(i),
      '<< /Type /XObject /Subtype /Image'
        + ' /Width ' + pxW + ' /Height ' + pxH
        + ' /ColorSpace /DeviceRGB /BitsPerComponent 8'
        + ' /Filter /DCTDecode /Length ' + jpeg.length + ' >>',
      jpeg
    )
  }

  const xrefAt = size
  putStr('xref\n0 ' + count + '\n')
  putStr('0000000000 65535 f \n')
  for (let id = 1; id < count; id++) {
    const off = offsets[id]
    putStr(('0000000000' + off).slice(-10) + ' 00000 n \n')
  }
  putStr('trailer\n<< /Size ' + count + ' /Root ' + idCatalog + ' 0 R >>\n')
  putStr('startxref\n' + xrefAt + '\n%%EOF\n')

  const out = new Uint8Array(size)
  let at = 0
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], at)
    at += chunks[i].length
  }
  return out
}

/* 原图直嵌 + 逐页裁剪：每张原图只嵌一次，每页用裁切区显示自己那一段
 * doc = {
 *   images: [{ jpeg, pxW, pxH }],
 *   pages: [{ segs: [{ im, y0, y1, vH }], footer? }],
 *   virtualW,
 *   media: { wPt, hPt },
 *   box:   { xPt, yPt, wPt, hPt },
 *   footerSizePt?
 * }
 */
function buildSliced(doc) {
  const pagesIn = (doc && doc.pages) || []
  const images = (doc && doc.images) || (doc && doc.image ? [doc.image] : [])
  if (!pagesIn.length) throw new Error('没有页可写')
  if (!images.length) throw new Error('缺少原图')
  for (let j = 0; j < images.length; j++) {
    if (!images[j].jpeg || !images[j].pxW || !images[j].pxH) throw new Error('缺少原图')
  }
  if (!doc.media || !doc.box) throw new Error('缺少纸张/内容区尺寸')

  // 页上直接给 y0/y1 的旧入参归一成一段
  const pages = pagesIn.map(function (p) {
    if (p.segs && p.segs.length) return p
    return { footer: p.footer, segs: [{ im: 0, y0: p.y0, y1: p.y1, vH: p.y1 - p.y0 }] }
  })
  const virtualW = doc.virtualW || images[0].pxW

  const chunks = []
  let size = 0
  function put(b) { chunks.push(b); size += b.length }
  function putStr(s) { put(ascii(s)) }

  const n = pages.length
  const M = images.length
  const idCatalog = 1
  const idPages = 2
  const idFont = 3
  const idImage = (j) => 4 + j
  const idPage = (i) => 4 + M + i * 2
  const idContent = (i) => 5 + M + i * 2
  const count = 4 + M + n * 2           // 对象数 + 1
  const offsets = new Array(count)

  function obj(id, dict, stream) {
    offsets[id] = size
    putStr(id + ' 0 obj\n')
    putStr(dict)
    if (stream) {
      putStr('\nstream\n')
      put(stream)
      putStr('\nendstream')
    }
    putStr('\nendobj\n')
  }

  putStr('%PDF-1.4\n')
  put(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]))

  obj(idCatalog, '<< /Type /Catalog /Pages ' + idPages + ' 0 R >>')
  let kids = ''
  for (let i = 0; i < n; i++) kids += idPage(i) + ' 0 R '
  obj(idPages, '<< /Type /Pages /Kids [' + kids.trim() + '] /Count ' + n + ' >>')
  obj(idFont, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  const media = doc.media
  const box = doc.box
  const footerSize = doc.footerSizePt || 8

  // 每张原图各嵌一份，多页共用
  const jpegBytes = images.map(function (im) { return toBytes(im.jpeg) })
  for (let j = 0; j < M; j++) {
    obj(
      idImage(j),
      '<< /Type /XObject /Subtype /Image'
        + ' /Width ' + images[j].pxW + ' /Height ' + images[j].pxH
        + ' /ColorSpace /DeviceRGB /BitsPerComponent 8'
        + ' /Filter /DCTDecode /Length ' + jpegBytes[j].length + ' >>',
      jpegBytes[j]
    )
  }

  let xdict = ''
  for (let j = 0; j < M; j++) xdict += '/Im' + j + ' ' + idImage(j) + ' 0 R '

  for (let i = 0; i < n; i++) {
    const p = pages[i]
    let totalVH = 0
    for (let g = 0; g < p.segs.length; g++) totalVH += p.segs[g].vH
    if (!(totalVH > 0)) throw new Error('第 ' + (i + 1) + ' 页没有内容')
    // q = 每虚拟行对应的 pt 数
    const q = Math.min(box.wPt / virtualW, box.hPt / totalVH)
    const drawW = virtualW * q
    const x = box.xPt + (box.wPt - drawW) / 2
    const yTop = box.yPt + (box.hPt + totalVH * q) / 2   // 页内容上边缘

    obj(
      idPage(i),
      '<< /Type /Page /Parent ' + idPages + ' 0 R /MediaBox [0 0 '
        + num(media.wPt) + ' ' + num(media.hPt) + ']'
        + ' /Resources << /XObject << ' + xdict.trim() + ' >>'
        + ' /Font << /F1 ' + idFont + ' 0 R >> >>'
        + ' /Contents ' + idContent(i) + ' 0 R >>'
    )

    // 各段自上而下：先裁出本条，再平移整图
    let content = ''
    let cum = 0
    for (let g = 0; g < p.segs.length; g++) {
      const seg = p.segs[g]
      const im = images[seg.im]
      const s = drawW / im.pxW                     // 每原图像素的 pt 数
      const h = seg.vH * q
      const top = yTop - cum                       // 段上边缘
      const full = im.pxH * s                      // 整图高度
      const imgY = top + seg.y0 * s - full
      content += (content ? '\n' : '')
        + 'q\n' + num(x) + ' ' + num(top - h) + ' ' + num(drawW) + ' ' + num(h) + ' re W n\n'
        + num(drawW) + ' 0 0 ' + num(full) + ' ' + num(x) + ' ' + num(imgY) + ' cm\n/Im' + seg.im + ' Do\nQ'
      cum += h
    }

    if (p.footer) {
      const label = String(p.footer)
      const textW = 0.52 * footerSize * label.length
      const cx = Math.max(0, (media.wPt - textW) / 2)
      const cy = Math.max(6, box.yPt / 2 - footerSize / 2)
      content += '\n0.45 g\nBT\n/F1 ' + num(footerSize) + ' Tf\n'
        + num(cx) + ' ' + num(cy) + ' Td\n(' + escapeText(label) + ') Tj\nET'
    }

    obj(idContent(i), '<< /Length ' + ascii(content).length + ' >>', ascii(content))
  }

  const xrefAt = size
  putStr('xref\n0 ' + count + '\n')
  putStr('0000000000 65535 f \n')
  for (let id = 1; id < count; id++) {
    putStr(('0000000000' + offsets[id]).slice(-10) + ' 00000 n \n')
  }
  putStr('trailer\n<< /Size ' + count + ' /Root ' + idCatalog + ' 0 R >>\n')
  putStr('startxref\n' + xrefAt + '\n%%EOF\n')

  const out = new Uint8Array(size)
  let at = 0
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], at)
    at += chunks[i].length
  }
  return out
}

// 纸张设置 → PDF 几何（mm 转 pt 只在这里）
function geometry(resolvedPaper) {
  const p = resolvedPaper
  return {
    media: { wPt: p.mmW * PT_PER_MM, hPt: p.mmH * PT_PER_MM },
    box: {
      xPt: p.margin * PT_PER_MM,
      yPt: p.margin * PT_PER_MM,
      wPt: p.contentWmm * PT_PER_MM,
      hPt: p.contentHmm * PT_PER_MM,
    },
  }
}

module.exports = { build, buildSliced, geometry, num, PT_PER_MM }
