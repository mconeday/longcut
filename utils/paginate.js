/* 长截图分页算法（纯 JS，无 DOM / wx 依赖）
 *
 * 切页规则：
 *   R1 切点落在空白带内，不切穿一行字
 *   R2 不切穿内容块（气泡、图片、卡片）
 *   R3 整块高于一页时才切进块内，挑最空的一行
 *   R4 聊天日期行不留页底，推到下一页首行
 *
 * 三段式：
 *   createScan / scanFeed(y0, band)  逐块喂像素，产出三个逐行数组
 *   plan(scan, h, cap, options)      纯数组运算，产出页边界，可重放
 *   paginate(img, cap, options)      便捷入口 = 前两步
 *
 * band: { width, height, data: RGBA }
 * plan: { pages, cuts, blocks, gaps, stamps, blank, stats }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Paginate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var D = {
    gutter: 6,        // 两侧取背景样本的条宽
    xStep: 2,         // 行扫描横向采样步长
    bgTol: 15,        // 与背景色的容差（RGB 距离）
    badRatio: 0.004,  // 行内允许的非背景像素比例
    mergeGap: 3,      // 小于此值的块间空白并入块
    minBand: 4,       // 可作切点的空白带最小高度
    minFill: 0.55,    // 一页最少装满容量的比例
    // R4 日期行判据
    stampMin: 5,      // 居中小黑条总宽下限
    stampEdge: 0.24,  // 居中小黑条两端须落在中段范围内
    stampRun: 4,      // 连续高度下限
    stampTail: 12,    // 页底到日期下沿的空隙阈值
    stampTiny: 0.01,  // 段内小空隙阈值（占宽比例）
    inkQuant: 1       // R3 选行的量化粒度
  };

  function dist(r1, g1, b1, r2, g2, b2) {
    var dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  function resolveOpt(options) {
    var opt = {};
    for (var k in D) opt[k] = (options && options[k] != null) ? options[k] : D[k];
    return opt;
  }

  // 该行背景色：左右 gutter 像素的中位色
  function rowBackground(data, w, y, gutter) {
    var rs = [], gs = [], bs = [], x, i, step = Math.max(1, Math.floor(gutter / 3));
    for (x = 0; x < gutter; x += step) {
      i = (y * w + x) * 4; rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
    for (x = Math.max(0, w - gutter); x < w; x += step) {
      i = (y * w + x) * 4; rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
    var med = function (a) { a.sort(function (p, q) { return p - q; }); return a[a.length >> 1]; };
    return [med(rs), med(gs), med(bs)];
  }

  // 该行颜色种类数（3bit 量化，超过 3 截断为 4）
  var seenGen = new Uint32Array(512), genTag = 0;
  function distinctColors(data, w, y, step) {
    var n = 0;
    if (++genTag > 0xfffffffe) { seenGen.fill(0); genTag = 1; }
    for (var x = 0; x < w; x += step) {
      var i = (y * w + x) * 4;
      var key = ((data[i] >> 5) << 6) | ((data[i + 1] >> 5) << 3) | (data[i + 2] >> 5);
      if (seenGen[key] !== genTag) { seenGen[key] = genTag; n++; if (n > 3) break; }
    }
    return n;
  }

  // 扫描结果容器，按需翻倍扩容
  function createScan(width, hintHeight) {
    var n = Math.max(1024, hintHeight || 0);
    var sc = {
      width: width,
      height: 0,
      capacity: n,
      blank: new Uint8Array(n),     // 1 = 整行背景
      worst: new Float32Array(n),   // 行内最大色差
      colorN: new Uint8Array(n),    // 行内颜色种类数 1~4
      inkL: new Uint16Array(n),     // 最左非背景像素 x，无内容为 width
      inkR: new Int16Array(n)       // 最右非背景像素 x，无内容为 -1
    };
    sc.inkL.fill(width);
    sc.inkR.fill(-1);
    return sc;
  }

  function ensureCapacity(scan, need) {
    if (need <= scan.capacity) return;
    var n = scan.capacity;
    while (n < need) n *= 2;
    var b = new Uint8Array(n); b.set(scan.blank); scan.blank = b;
    var w = new Float32Array(n); w.set(scan.worst); scan.worst = w;
    var c = new Uint8Array(n); c.set(scan.colorN); scan.colorN = c;
    var l = new Uint16Array(n); l.fill(scan.width); l.set(scan.inkL); scan.inkL = l;
    var r = new Int16Array(n); r.fill(-1); r.set(scan.inkR); scan.inkR = r;
    scan.capacity = n;
  }

  // 扫描一块像素，y0 为该块起始行；结果与分块方式无关
  function scanFeed(scan, y0, band, options) {
    var opt = resolveOpt(options);
    var w = band.width, h = band.height, data = band.data;
    if (w !== scan.width) throw new Error('scanFeed: 宽不一致 ' + w + ' vs ' + scan.width);
    if (!data || data.length < w * h * 4) throw new Error('scanFeed: 像素数据长度不足');
    if (y0 < 0 || h < 0) throw new Error('scanFeed: 非法区间');

    ensureCapacity(scan, y0 + h);
    var step = opt.xStep, gutter = opt.gutter;
    var maxBad = Math.max(2, Math.floor((w / step) * opt.badRatio));

    for (var y = 0; y < h; y++) {
      var bg = rowBackground(data, w, y, gutter);
      var bad = 0, worst = 0;
      var il = w, ir = -1;
      var lck = 0, rck = -1;
      for (var x = 0; x < w; x += step) {
        var i = (y * w + x) * 4;
        var d = dist(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2]);
        if (d > worst) worst = d;
        if (d > opt.bgTol) {
          bad++;
          if (lck === 0) il = x;
          rck = x;
          lck++;
        }
      }
      if (il > 0 && il < w) il = Math.max(0, il - step + 1);
      if (rck >= 0) ir = Math.min(w - 1, rck + step - 1);
      var gy = y0 + y;
      scan.blank[gy] = bad <= maxBad ? 1 : 0;
      scan.worst[gy] = worst;
      scan.colorN[gy] = distinctColors(data, w, y, step);
      scan.inkL[gy] = il;
      scan.inkR[gy] = ir;
    }
    if (y0 + h > scan.height) scan.height = y0 + h;
    return scan;
  }

  // 空白行反推内容块，合并小空隙
  function buildBlocks(blank, h, opt) {
    var blocks = [], runStart = -1;
    for (var y = 0; y <= h; y++) {
      var isContent = y < h ? !blank[y] : false;
      if (isContent && runStart < 0) runStart = y;
      else if (!isContent && runStart >= 0) { blocks.push({ top: runStart, bottom: y }); runStart = -1; }
    }
    var merged = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (merged.length && b.top - merged[merged.length - 1].bottom < opt.mergeGap) {
        merged[merged.length - 1].bottom = b.bottom;
      } else merged.push({ top: b.top, bottom: b.bottom });
    }
    return merged;
  }

  // 块间空白带，高度需 ≥ minBand
  function buildGaps(blocks, h, opt) {
    var gaps = [], prev = 0;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].top - prev >= opt.minBand) gaps.push({ top: prev, bottom: blocks[i].top });
      prev = Math.max(prev, blocks[i].bottom);
    }
    if (h - prev >= opt.minBand) gaps.push({ top: prev, bottom: h });
    return gaps;
  }

  // 拼接缝归一：排序去重取整，无有效缝返回 null
  function normalSeams(breaks, h) {
    if (!breaks || !breaks.length) return null;
    var out = [];
    for (var i = 0; i < breaks.length; i++) {
      var b = Math.round(breaks[i]);
      if (b > 0 && b < h && out.indexOf(b) < 0) out.push(b);
    }
    if (!out.length) return null;
    out.sort(function (p, q) { return p - q; });
    return out;
  }

  // 跨缝的块从缝处劈开
  function splitAtSeams(blocks, seams, h) {
    if (!seams) return blocks;
    var mask = new Uint8Array(h + 1);
    for (var s = 0; s < seams.length; s++) mask[seams[s]] = 1;
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i], lo = b.top;
      for (var y = b.top + 1; y < b.bottom; y++) {
        if (mask[y]) { out.push({ top: lo, bottom: y }); lo = y; }
      }
      out.push({ top: lo, bottom: b.bottom });
    }
    return out;
  }

  // cur 之后最近的缝，没有返回 -1
  function seamAfter(seams, cur) {
    if (!seams) return -1;
    for (var i = 0; i < seams.length; i++) if (seams[i] > cur) return seams[i];
    return -1;
  }

  // R3 选行：颜色种类最少优先，并列取偏差更小、偏下
  function quietestRow(scan, from, to) {
    var best = to, bestN = 99, bestWorst = Infinity;
    for (var y = to; y >= from; y--) {
      var n = scan.colorN[y];
      if (n < bestN || (n === bestN && scan.worst[y] < bestWorst)) {
        bestN = n; bestWorst = scan.worst[y]; best = y;
      }
      if (bestN === 1) break;
    }
    return best;
  }

  // R4 识别居中的窄小段落（聊天日期、系统提示），返回 [{top, bottom, runAt}]
  function detectStamps(scan, h, opt) {
    var out = [];
    var w = scan.width;
    var tiny = Math.max(2, Math.round(w * opt.stampTiny));
    var midTol = w * 0.06;
    var maxW = w * 2 * opt.stampEdge;

    var y = 0;
    while (y < h) {
      if (scan.blank[y]) { y++; continue; }
      var runTop = y, runBottom = y + 1, gap = 0;
      var lo = w, hi = -1;
      while (y < h) {
        if (scan.blank[y]) {
          gap++;
          if (gap > tiny) break;
        } else {
          gap = 0;
          runBottom = y + 1;
          if (scan.inkL[y] < lo) lo = scan.inkL[y];
          if (scan.inkR[y] > hi) hi = scan.inkR[y];
        }
        y++;
      }
      if (runBottom - runTop < opt.stampRun) continue;
      if (hi < 0) continue;
      var ww = hi - lo + 1;
      if (ww < opt.stampMin || ww > maxW) continue;
      if (Math.abs((lo + hi + 1) / 2 - w / 2) > midTol) continue;
      out.push({ top: runTop, bottom: runBottom, runAt: runBottom });
    }
    return out;
  }

  // R4：本页末尾是否压着一条日期，是则返回该日期
  function stampPressed(stamps, limit, h, tail, scan) {
    if (!stamps) return null;
    for (var i = 0; i < stamps.length; i++) {
      var s = stamps[i];
      if (s.top > limit) return null;
      var bot = Math.min(h, s.bottom);
      if (bot > limit) return s;                   // 日期被切开
      if (limit - bot <= tail) return s;           // 日期贴页底
      if (scan && blankBetween(scan, bot, limit)) return s;  // 日期下方全是空白
    }
    return null;
  }

  // [from,to) 是否全为空白行
  function blankBetween(scan, from, to) {
    for (var y = Math.max(0, from); y < to; y++) {
      if (!scan.blank[y]) return false;
    }
    return true;
  }

  // 日期上沿的切点：优先上一条空白带中点
  function stampCutAt(stamp, cur, gaps) {
    var best = -1;
    for (var k = 0; k < gaps.length; k++) {
      var g = gaps[k];
      if (g.bottom > stamp.top) break;
      if (g.top < cur) continue;
      var mid = Math.floor((g.top + g.bottom) / 2);
      if (mid > best) best = mid;
    }
    if (best > cur && best < stamp.top) return best;
    return Math.max(cur + 1, stamp.top - 1);
  }

  // 切点劈在日期里时退到日期上方一行
  function backOffFromStamp(stamps, cur, cut) {
    if (!stamps) return cut;
    for (var i = 0; i < stamps.length; i++) {
      var s = stamps[i];
      if (s.top > cut) break;
      if (cut >= s.top && cut < s.bottom && s.top > cur + 1) return s.top - 1;
    }
    return cut;
  }

  // 规划页边界：只用扫描数组，可按不同容量重放
  function plan(scan, totalHeight, pageContentHeight, options) {
    var opt = resolveOpt(options);
    var h = totalHeight != null ? totalHeight : scan.height;
    if (h > scan.height) throw new Error('plan: 扫描高度只有 ' + scan.height + '，不足 ' + h);

    var blank = scan.blank.subarray(0, h);
    var seams = normalSeams(options && options.breaks, h);
    var onePerPage = !!(options && options.onePerPage);
    var blocks = splitAtSeams(buildBlocks(blank, h, opt), seams, h);
    var gaps = buildGaps(blocks, h, opt);
    var stamps = (options && options.stamps === false) ? [] : detectStamps(scan, h, opt);

    var cap = Math.max(1, Math.floor(pageContentHeight));
    var pages = [], cuts = [];
    var cur = 0, guard = 0, maxPages = Math.ceil(h / Math.max(1, cap * opt.minFill)) + 8;

    while (cur < h && guard++ < maxPages) {
      var limit = Math.min(cur + cap, h);
      var minContent = Math.max(1, Math.floor(cap * opt.minFill));
      var cut = -1, forced = false, chosen = null;

      // 拼接缝优先切
      var seam = seamAfter(seams, cur);
      if (seam > 0 && seam <= limit && (onePerPage || seam >= cur + minContent)) {
        cut = seam;
      }
      // 末页直接收尾
      if (cut < 0 && limit >= h && !stampPressed(stamps, limit, h, opt.stampTail, scan)) {
        pages.push({ from: cur, to: h }); break;
      }
      // 日期压页底则让位
      if (cut < 0) {
        var sp = stampPressed(stamps, limit, h, opt.stampTail, scan);
        if (sp) {
          var st = stampCutAt(sp, cur, gaps);
          if (st >= cur + minContent) cut = st;
        }
      }
      // 容量边界落在空白带内，直接切边界
      if (cut < 0) {
        for (var i = 0; i < gaps.length; i++) {
          if (gaps[i].top < limit && limit < gaps[i].bottom && gaps[i].top >= cur + minContent) {
            cut = limit; chosen = gaps[i]; break;
          }
        }
      }
      // 否则退到边界前最后一条完整空白带中点
      if (cut < 0) {
        for (var j = gaps.length - 1; j >= 0; j--) {
          var g = gaps[j];
          if (g.bottom <= limit && g.top >= cur + minContent) {
            cut = Math.floor((g.top + g.bottom) / 2);
            chosen = g; break;
          }
        }
      }
      // 块内切：挑颜色最单一的一行
      if (cut < 0) {
        var lo = Math.min(h - 1, cur + minContent);
        var hi = Math.min(h - 1, limit);
        if (lo > hi) { lo = hi; }
        var win = Math.min(240, Math.max(40, Math.round(cap * 0.15)));
        var from = Math.max(lo, hi - win);
        cut = quietestRow(scan, from, hi);
        forced = true;
      }
      // 切点劈在日期里则退到日期上方
      if (cut > 0 && stamps.length) {
        var backed = backOffFromStamp(stamps, cur, cut);
        if (backed !== cut) { cut = backed; forced = true; chosen = null; }
      }
      // 切完复查：日期落在页尾则改切到日期上沿
      if (!forced && !(onePerPage && cut === seamAfter(seams, cur))) {
        for (var qi = 0; qi < stamps.length; qi++) {
          var s2 = stamps[qi];
          if (s2.bottom + opt.stampTail < cut && !blankBetween(scan, s2.bottom, cut)) continue;
          if (s2.bottom < cur) continue;
          if (s2.top <= cur) break;
          if (s2.top > cut) break;
          var st2 = stampCutAt(s2, cur, gaps);
          if (st2 >= cur + minContent && st2 < cut) {
            cut = st2; forced = false; chosen = null;
          }
          break;
        }
      }
      if (cut <= cur) cut = Math.min(h, cur + minContent);

      pages.push({ from: cur, to: cut });
      cuts.push({ y: cut, forced: forced, band: chosen });
      cur = cut;
    }

    var used = 0;
    for (var p = 0; p < pages.length; p++) used += pages[p].to - pages[p].from;

    // 末页残页并入上一页；onePerPage 时保留每图一页
    while (pages.length > 1 && !onePerPage) {
      var last = pages[pages.length - 1];
      var prev = pages[pages.length - 2];
      if (last.to - last.from >= cap * 0.5) break;
      if (last.to - prev.from > cap) break;
      prev.to = last.to;
      pages.pop();
      cuts.pop();
    }

    var full = pages.length * cap;

    return {
      pages: pages,
      cuts: cuts,
      blocks: blocks,
      gaps: gaps,
      stamps: stamps,
      blank: blank,
      stats: {
        height: h,
        pageCount: pages.length,
        capacity: cap,
        forcedCuts: cuts.filter(function (c) { return c.forced; }).length,
        blockCount: blocks.length,
        gapCount: gaps.length,
        seamCount: seams ? seams.length : 0,
        stampCount: stamps.length,
        utilization: full ? +(used / full).toFixed(4) : 0,
        blankRatio: +(countOnes(blank) / h).toFixed(4)
      }
    };
  }

  // 便捷入口：整图一次进内存，仅供测试 / 小图
  function paginate(img, pageContentHeight, options) {
    var scan = createScan(img.width, img.height);
    scanFeed(scan, 0, img, options);
    return plan(scan, img.height, pageContentHeight, options);
  }

  // 兜底：按容量均分，保证内容不丢
  function evenSplit(h, pageContentHeight) {
    var cap = Math.max(1, Math.floor(pageContentHeight));
    var n = Math.max(1, Math.ceil(h / cap));
    var step = h / n;
    var pages = [];
    for (var i = 0; i < n; i++) {
      pages.push({ from: Math.round(i * step), to: Math.round((i + 1) * step) });
    }
    return {
      pages: pages,
      cuts: pages.slice(0, -1).map(function (p) { return { y: p.to, forced: true, band: null }; }),
      blocks: [], gaps: [], stamps: [], blank: new Uint8Array(h), degraded: true,
      stats: { height: h, pageCount: pages.length, capacity: cap, forcedCuts: n - 1, blockCount: 0, gapCount: 0, stampCount: 0, utilization: 1, blankRatio: 0 }
    };
  }

  function countOnes(a) { var n = 0; for (var i = 0; i < a.length; i++) n += a[i]; return n; }

  return {
    paginate: paginate,
    createScan: createScan,
    scanFeed: scanFeed,
    plan: plan,
    evenSplit: evenSplit
  };
});
