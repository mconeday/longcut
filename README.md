# Longcut · 长图分割打印

> 聊天记录也想上纸？长截图自动分页成 A4/A5 打印 PDF，**全程本地处理，不联网、不上传**。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-mconeday/longcut-black.svg)](https://github.com/mconeday/longcut)
[![Gitee](https://img.shields.io/badge/Gitee-mc__oneday/short--cut-red.svg)](https://gitee.com/mc_oneday/short-cut)

---

## 这些烦恼，熟悉吗？

- **文字被拦腰截断** —— 长截图直接打印，一行字从中间劈开，上文接不上
- **分页不看内容** —— 固定高度硬切，不管这句话说到哪、这张图断在哪
- **好用的要掏钱** —— 能漂亮分页的工具，要么订阅、要么会员、要么给你加水印
- **截图得先上云** —— 把聊天记录传到陌生服务器才给处理，心里总归不踏实

这个项目一次解决：**在空白处下刀**（一行字都不截断）、**按内容自适应分页**、**MIT 开源免费**、**全程手机本地处理**——飞行模式下照样能用。

## 这是什么

把长截图交给它：先扫描每一行的内容、找出块与块之间的空白带，在最合适的位置下刀，把整张图切成若干页，再拼成一份可直接打印的 PDF。

- **全程本地**：不解码上传、不请求服务器，飞行模式下可用（`utils/net.js` 对全局网络调用做了计数，可自证）
- **智能切页**：按「内容块 + 空白带」找切口，日期行（聊天日期灰字）不会被留在页底
- **手动微调**：拖动分割线、按块步进、撤销，切口只存原图像素，缩放不跑位
- **超长图不炸内存**：分块扫描 + 能力探测降级（本机解不动就自动压一档再试），支持多图拼接成长图
- **PDF 自己拼**：自写 PDF 字节流，JPEG 直嵌零转码；解不动原图时走「原图直嵌 + 逐页裁剪」，一个像素都不解码

## 扫码体验

<p align="center">
  <img src="docs/qr.jpg" width="220" alt="小程序码：微信扫一扫直接使用">
</p>

<p align="center">微信扫一扫，直接使用小程序</p>

<!-- TODO: 放 3 张截图（建议宽 320 左右并排）
| 首页 | 分页预览 | 导出结果 |
| --- | --- | --- |
| <img src="docs/images/home.png" width="240"> | <img src="docs/images/preview.png" width="240"> | <img src="docs/images/result.png" width="240"> |
-->

## 功能

| 能力 | 说明 |
| --- | --- |
| 两种选图入口 | 相册 / 微信聊天记录；「＋」沿用上一张图的来源 |
| 纸张设置 | A4 / A5、边距档位，实时预估页数与成品尺寸 |
| 分页预览 | 逐页渲染，页边界来自真实算法结果（不是写死页数） |
| 微调分页 | 拖动 / 按块步进 / 撤销；末段空白自动收口，不出空白页 |
| 导出 PDF | 10MB 阶梯降质、超限仍允许导出、页码每页恒显 |
| 保存与转发 | 转发给微信好友 / 存到文件；失败自动降级（ASCII 文件名 → 打开文档菜单） |
| 历史记录 | 本地保留 7 天，条目与磁盘文件成对删除；支持重命名、查看详情 |

## 目录结构

```
pages/                  8 个页面：home(选图) paper(纸张) process(处理)
                        preview(预览) adjust(微调) result(导出结果)
                        history(历史) settings(设置与隐私)
utils/                  纯逻辑层（无 UI 依赖，可在 Node 里直接测）
  paginate.js           分页算法（六步分割 + R1/R2/R3 分级）
  imageJob.js           分块扫描 / 能力探测 / 分级降级
  pdfJob.js             导出编排（降质阶梯、封面、直嵌分支）
  pdf.js                自拼 PDF 字节流
  jpeg.js               JPEG 头解析（直嵌安全阀的读数处）
  cuts.js               切口几何 / 吸附 / 边界（纯函数）
  capacity.js           实测设备能力档位
  paper.js              纸张与每页容量
  sources.js            多图虚拟长图的坐标换算
  store.js / files.js   本地存储与文件（成对删）
  net.js                网络调用计数（「不联网」的自证）
components/navigation-bar/  WeUI navigation-bar（本地化，见第三方声明）
assets/                 图标与插画
```

## 快速开始

1. 装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 「导入项目」→ 目录选**本仓库根目录** → AppID 选「测试号」
3. 编译即可（无需 npm 构建，无第三方运行时依赖）

## 真机部署：先配「用户隐私保护指引」

开发者工具一切正常，真机上「图片没能读进来」、控制台见 `privacy fail ... errno:101`——这是 2023-09-15 起 `chooseMedia` / `getImageInfo` 等涉隐私接口受《用户隐私保护指引》管控：后台**未声明**或用户**未同意**时真机直接 fail，开发者工具不触发（以微信官方最新规则为准）。

配置步骤（mp.weixin.qq.com → 设置 → 基本设置 → 服务内容声明 → 用户隐私保护指引）：

1. 新增指引并**发布生效**，声明以下信息类型：
   - 「选中的照片或视频信息」— 用于读取截图、按纸张分页生成 PDF
   - 「相册（仅写入）」— 用于保存导出的 PDF/图片
2. 代码已做配套：`pages/home` 选图前先走 `wx.requirePrivacyAuthorize`（基础库 ≥2.32.3，以官方文档为准），官方弹窗同意一次后面全通；拒绝/未配置时 toast 直说原因。

## 技术要点（为什么这么做）

- **切页不用固定高度**：先扫描每行颜色数得到内容块，再在块间空白带里找最优点，兼顾利用率与"不切穿文字/图片"。
- **不预判，先跑再压**：解不动原图时按档位压缩重试（0.75 / 0.55 / 0.4），实测档位记录在 storage，不靠机型猜。
- **直嵌 PDF**：原图 JPEG 直接嵌一次 + 每页裁剪显示，20 页整份仅几百 KB；四道安全阀不满足才回退 canvas 重绘。
- **同层 canvas 的坑**：canvas 不能放进 scroll-view（滚动时位图层不跟随），预览页因此改成三段定高布局。

## 已知限制

- 极小内存机型上超长图仍可能降级失败，会明确报错并提示分段处理
- 页面渲染性能依赖机型，超大图预览翻页在低端机上有延迟
- 仅支持竖版长截图（横版/超宽图会提示 TOO_WIDE）

## 路线图

- [ ] 真机机型矩阵回归（分享/保存、超长图 drawImage、多图解码峰值）
- [ ] 自定义纸张尺寸
- [ ] 导出「分成 N 份」的完整 UI
- [ ] 更细的色差/打印预览校验

## 关键词

微信小程序 · 长截图 · 聊天记录打印 · 截图转 PDF · 长图分页 · 智能切页 · A4 / A5 打印 · 图片切分 · 不切穿文字 · PDF 导出 · 聊天记录导出打印 · 离线可用 · 本地处理 · 隐私保护 · canvas · chooseMedia · WeUI · 无服务器 · 免费打印工具

## 第三方声明

- 导航栏组件 [WeUI navigation-bar](https://github.com/wechat-miniprogram/weui-miniprogram)（Tencent，MIT License），源码本地化改造：`components/navigation-bar/`
- 其余代码无第三方运行时依赖；PDF 字节流、JPEG 解析均为自实现

## 许可证

[MIT](LICENSE) © 2026 Longcut authors

> 项目名称与 Logo 不在开源许可范围内（如后续注册商标/图形，另行声明）。
