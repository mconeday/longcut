/* 虚拟长图坐标换算：虚拟坐标 ↔ 源图局部坐标
 * sources 结构：{ path, w, h, top, sh, scale }
 */
// 虚拟 y 落在哪张源图上，越界按最后一张
function sourceAt(sources, y) {
  if (!sources || !sources.length) return null
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]
    if (y >= s.top && y < s.top + s.sh) return s
  }
  return sources[sources.length - 1]
}

// 虚拟区间 [from,to) 按源图拆成若干段
function pageSegments(sources, from, to) {
  const segs = []
  if (!sources || !sources.length) return segs
  const a0 = Math.max(0, from)
  const b0 = Math.max(a0, to)
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]
    const a = Math.max(a0, s.top)
    const b = Math.min(b0, s.top + s.sh)
    if (b <= a) continue
    const rel = a - s.top
    segs.push({
      src: s,
      vTop: a,                 // 段的虚拟起点
      vH: b - a,               // 段的虚拟高度
      sy: rel / s.scale,       // 源图上的起点
      sh: (b - a) / s.scale,   // 源图上裁切行数
    })
  }
  return segs
}

// 段的源图像素高
function localH(seg) { return seg.sh }

// 虚拟总高
function totalHeight(sources, fallback) {
  if (!sources || !sources.length) return fallback || 0
  const last = sources[sources.length - 1]
  return last.top + last.sh
}

// 取 job 的 sources，单图老数据补一条
function fromJob(job) {
  if (job && job.sources && job.sources.length) return job.sources
  if (!job) return []
  const w = job.imgW || job.width || 0
  const h = job.imgH || job.height || 0
  const p = job.img || job.imgPath
  if (!p || !w || !h) return []
  return [{ path: p, w: w, h: h, top: 0, sh: h, scale: 1 }]
}

module.exports = {
  sourceAt: sourceAt,
  pageSegments: pageSegments,
  localH: localH,
  totalHeight: totalHeight,
  fromJob: fromJob,
}
