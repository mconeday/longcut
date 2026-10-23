// 本地 storage 封装：历史记录、纸张设置、当前草稿
const files = require('./files.js')

const KEY_HISTORY = 'history';
const KEY_SETTING = 'paperSetting';
const KEY_JOB = 'currentJob';
const KEEP_MS = 7 * 24 * 3600 * 1000;      // 历史保留 7 天

function get(key, fallback) {
  try { return wx.getStorageSync(key) || fallback; } catch (e) { return fallback; }
}
function set(key, val) { try { wx.setStorageSync(key, val); } catch (e) {} }

// 读历史：清掉过期条目，条目和磁盘文件一起删
function loadHistory() {
  const now = Date.now();
  const all = get(KEY_HISTORY, []);
  const alive = [];
  const dead = [];
  for (let i = 0; i < all.length; i++) {
    const it = all[i] || {};
    if (now - (it.ts || 0) < KEEP_MS) alive.push(it);
    else dead.push(it);
  }
  if (dead.length) {
    for (let i = 0; i < dead.length; i++) {
      files.unlink(dead[i].path);
      if (dead[i].cover) files.unlink(dead[i].cover);
    }
    set(KEY_HISTORY, alive);
  }
  return alive;
}

// 新增一条历史，返回其时间戳（作为条目主键）
function addHistory(item) {
  const list = loadHistory();
  const ts = Date.now();
  list.unshift(Object.assign({ ts: ts }, item));
  set(KEY_HISTORY, list.slice(0, 50));
  return ts;
}

// 删除单条：先删文件再删条目
function removeHistory(ts) {
  const list = get(KEY_HISTORY, []);
  const keep = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i] || {};
    if (it.ts === ts) {
      files.unlink(it.path);
      if (it.cover) files.unlink(it.cover);
    }
    else keep.push(it);
  }
  set(KEY_HISTORY, keep);
  return keep;
}

// 清空历史：条目和文件一起删
function clearHistory() {
  const list = get(KEY_HISTORY, []);
  for (let i = 0; i < list.length; i++) {
    files.unlink(list[i] && list[i].path);
    if (list[i] && list[i].cover) files.unlink(list[i].cover);
  }
  set(KEY_HISTORY, []);
}

// 按时间戳更新历史条目的文件名、路径、封面
function renameHistory(ts, patch) {
  const list = get(KEY_HISTORY, []);
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].ts === ts) {
      list[i] = Object.assign({}, list[i], patch);
      break;
    }
  }
  set(KEY_HISTORY, list);
}

// 清空当前草稿，不影响历史
function resetJob() {
  set(KEY_JOB, {});
}

module.exports = {
  get: get,
  set: set,
  loadHistory: loadHistory,
  addHistory: addHistory,
  removeHistory: removeHistory,
  renameHistory: renameHistory,
  clearHistory: clearHistory,
  resetJob: resetJob,
  KEY_HISTORY: KEY_HISTORY,
  KEY_SETTING: KEY_SETTING,
  KEY_JOB: KEY_JOB,
}
