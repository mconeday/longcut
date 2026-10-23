/* 最小 JPEG 头解析：读文件内像素尺寸、EXIF 朝向、颜色分量数 */
function u16be(u8, at) {
  return (u8[at] << 8) | u8[at + 1]
}

// 读 EXIF 的 Orientation（0x0112），返回 1~8，读不到返回 0
function exifOrientation(u8, at, end) {
  if (at + 14 > end) return 0
  if (u8[at] !== 0x45 || u8[at + 1] !== 0x78 || u8[at + 2] !== 0x69 || u8[at + 3] !== 0x66) return 0
  const t = at + 6
  const le = u8[t] === 0x49 && u8[t + 1] === 0x49     // 'II'
  const be = u8[t] === 0x4d && u8[t + 1] === 0x4d     // 'MM'
  if (!le && !be) return 0
  const rd16 = function (o) {
    return le ? (u8[o] | (u8[o + 1] << 8)) : ((u8[o] << 8) | u8[o + 1])
  }
  const rd32 = function (o) {
    return le
      ? ((u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0)
      : (((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0)
  }
  const ifd = t + rd32(t + 4)
  if (ifd + 2 > end) return 0
  const n = rd16(ifd)
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > end) return 0
    if (rd16(e) === 0x0112) {
      const v = rd16(e + 8)
      return v >= 1 && v <= 8 ? v : 0
    }
  }
  return 0
}

// 解析 JPEG 头，返回 { w, h, comps, progressive, orientation }，失败返回 null
function info(u8) {
  if (!u8 || u8.length < 4) return null
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return null
  const out = { jpeg: true, w: 0, h: 0, comps: 0, progressive: false, orientation: 1 }
  let p = 2
  while (p + 3 < u8.length) {
    if (u8[p] !== 0xff) { p++; continue }
    let m = u8[p + 1]
    while (m === 0xff && p + 2 < u8.length) { p++; m = u8[p + 1] }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue }
    if (m === 0xd9 || m === 0xda) break
    const len = u16be(u8, p + 2)
    if (len < 2) return null
    if (m === 0xe1) {
      const o = exifOrientation(u8, p + 4, Math.min(u8.length, p + 2 + len))
      if (o) out.orientation = o
    } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      // SOF：精度 1、高 2、宽 2、分量数 1
      out.h = u16be(u8, p + 5)
      out.w = u16be(u8, p + 7)
      out.comps = u8[p + 9]
      out.progressive = m === 0xc2
      break
    }
    p += 2 + len
  }
  if (!out.w || !out.h) return null
  return out
}

module.exports = { info: info }
