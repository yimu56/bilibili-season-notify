// ==UserScript==
// @name         B站合集更新监控 · 云湖机器人推送
// @namespace    https://github.com/yimu56/bilibili-season-notify
// @version      1.1.0
// @description  定时检测 B 站若干合集是否发布新视频，可按标题关键字过滤，命中后把标题、链接与简介推送到云湖机器人
// @author       yimu56
// @license      MIT
// @homepageURL  https://github.com/yimu56/bilibili-season-notify
// @supportURL   https://github.com/yimu56/bilibili-season-notify/issues
// @downloadURL  https://raw.githubusercontent.com/yimu56/bilibili-season-notify/main/bilibili-season-notify.user.js
// @updateURL    https://raw.githubusercontent.com/yimu56/bilibili-season-notify/main/bilibili-season-notify.user.js
// @crontab      * 8-23 once * *
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_log
// @connect      api.bilibili.com
// @connect      chat-go.jwzhd.com
// ==/UserScript==

/*
 * 工作原理
 *   1. 依次遍历 WATCH_LIST 中的每个合集，调用 seasons_archives_list 按发布时间倒序取最近 N 个视频；
 *   2. 与本地存储的「上次已处理时间」比对，找出新发布的视频；
 *   3. 若该合集配置了 keywords，则只保留标题命中关键字的新视频，未命中的视为已处理并跳过；
 *   4. 逐个取视频详情拿到简介，拼接消息推送到云湖机器人；
 *   5. 推送成功后更新本地基线，避免重复推送。
 *
 * 多目标监控
 *   WATCH_LIST 中每一项对应一个合集，各自维护独立基线（键名 bh_watch_<mid>_<seasonId>），互不影响。
 *   keywords 为空数组表示该合集内任意新视频都推送；配置多个关键字时命中任意一个即推送。
 *
 * 定时策略
 *   @crontab * 8-23 once * *
 *   含义：每天 08:00-23:59 之间首次触发时执行一次，当天只执行一次。
 *   浏览器关闭期间不会执行，once 写法可以保证当天只要开机就会补上这一次。
 *   如需固定时间执行，改成 0 9 * * *（每天 09:00），代价是错过该时刻当天不再执行。
 *
 * 注意事项
 *   - B 站合集接口对请求头有校验，缺少浏览器 User-Agent 会返回 -352 风控错误；
 *   - 云湖图片消息只能使用「图片上传」接口返回的 imageKey，无法直接引用外链，
 *     因此默认只推送文字，封面图仅在 CONTENT_TYPE 为 html 且 PUSH_COVER 为 true 时使用外链展示；
 *   - 云湖发送接口限制 10 次/秒，批量推送时已内置间隔。
 */

/* ==================== 配置区 ==================== */

// 监控目标列表，可配置多个合集，脚本每次执行会依次检查
const WATCH_LIST = [
  {
    // 合集地址：https://space.bilibili.com/105493566/lists/75265?type=season
    //                                  └── mid ────┘        └ seasonId ┘
    name: 'Epic免费游戏合集',
    mid: 105493566,
    seasonId: 75265,
    // 关键字为空数组：合集内任意新视频都会推送
    keywords: [],
  },
  {
    // 合集地址：https://space.bilibili.com/105493566/lists/94093?type=season
    name: '游戏资讯',
    mid: 105493566,
    seasonId: 94093,
    // 仅当新视频标题包含下列关键字之一时才推送，多个关键字为「或」的关系
    keywords: ['神秘游戏'],
  },
];

const CONFIG = {
  // ── 云湖机器人 ────────────────────────────────────────────
  // YUNHU_TOKEN    ：云湖控制台中「机器人发送消息链接」的 token 参数
  // YUNHU_RECV_ID  ：接收者 ID，群聊填群号，私聊填用户 ID
  // YUNHU_RECV_TYPE：接收者类型，群聊填 group，私聊填 user
  YUNHU_TOKEN: '',
  YUNHU_RECV_ID: '',
  YUNHU_RECV_TYPE: 'group',

  // ── 消息行为 ──────────────────────────────────────────────
  // CONTENT_TYPE：markdown（默认，自动适配深浅色）或 html（支持封面图）
  CONTENT_TYPE: 'markdown',
  // 仅在 CONTENT_TYPE 为 html 时生效，是否输出封面图外链
  PUSH_COVER: false,
  // 单次执行最多推送几条，超出时只推最新的若干条并提示剩余数量
  MAX_PUSH_PER_RUN: 3,
  // 简介截断长度
  DESC_MAX_LEN: 500,
  // 首次运行（无历史基线）是否推送当前最新视频，false 表示只记录基线不推送
  FIRST_RUN_PUSH: false,
  // 倒序拉取条数，用于覆盖多天未执行的情况
  SCAN_SIZE: 20,
};

/* ================================================ */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TAG = '[B站合集监控]';

/* ---------------- 基础工具 ---------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gmFetch(opt) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      url: opt.url,
      method: opt.method || 'GET',
      headers: opt.headers || {},
      data: opt.data,
      timeout: opt.timeout || 20000,
      onload: resolve,
      onerror: (e) => reject(new Error('网络错误：' + ((e && e.error) || 'unknown'))),
      ontimeout: () => reject(new Error('请求超时')),
    });
  });
}

// 兼容同步实现（Tampermonkey）与 Promise 实现（ScriptCat）
function gmGet(key, def) {
  return Promise.resolve(GM_getValue(key, def));
}

function gmSet(key, value) {
  return Promise.resolve(GM_setValue(key, value));
}

function log(text) {
  try {
    GM_log(TAG + ' ' + text);
  } catch (e) {
    /* 忽略日志异常 */
  }
}

function notify(title, text) {
  try {
    GM_notification({ title, text, timeout: 6000 });
  } catch (e) {
    /* 忽略通知异常 */
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtDate(ts) {
  const d = new Date(Number(ts) * 1000);
  return (
    d.getFullYear() +
    '-' + pad2(d.getMonth() + 1) +
    '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) +
    ':' + pad2(d.getMinutes())
  );
}

function fmtDuration(sec) {
  let s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  s = s % 60;
  return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s);
}

function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + '万';
  return String(v);
}

function truncate(text, max) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, max) + '……（简介过长，已截断）';
}

function esc(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toHttps(url) {
  return String(url || '').replace(/^http:\/\//i, 'https://');
}

function videoUrl(bvid) {
  return 'https://www.bilibili.com/video/' + bvid;
}

/* ---------------- 网络请求 ---------------- */

function browserHeaders(watch) {
  const headers = { 'User-Agent': UA };
  if (watch) {
    headers.Referer =
      'https://space.bilibili.com/' + watch.mid + '/lists/' + watch.seasonId + '?type=season';
  }
  return headers;
}

// 带重试的 JSON 请求；-352 为 B 站风控码，同样进入重试
async function requestJson(url, opt) {
  const options = opt || {};
  const attempts = options.attempts || 3;
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1500 * i);
    try {
      const res = await gmFetch({
        url,
        method: options.method || 'GET',
        headers: options.headers,
        data: options.data,
      });
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      let json;
      try {
        json = JSON.parse(res.responseText);
      } catch (e) {
        throw new Error('响应内容不是合法 JSON');
      }
      if (json.code === -352) throw new Error('触发 B 站风控（-352）');
      return json;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchSeasonArchives(watch) {
  const url =
    'https://api.bilibili.com/x/polymer/web-space/seasons_archives_list' +
    '?mid=' + watch.mid +
    '&season_id=' + watch.seasonId +
    '&sort_reverse=true' +
    '&page_num=1' +
    '&page_size=' + CONFIG.SCAN_SIZE;

  const json = await requestJson(url, { headers: browserHeaders(watch) });
  if (json.code !== 0) {
    throw new Error('合集接口返回 code=' + json.code + (json.message ? ' ' + json.message : ''));
  }

  const data = json.data || {};
  const archives = data.archives || [];
  if (!archives.length) throw new Error('合集接口未返回任何视频');

  return {
    archives,
    meta: data.meta || {},
    total: (data.page && data.page.total) || archives.length,
  };
}

async function fetchVideoDetail(bvid) {
  const json = await requestJson('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
    headers: browserHeaders(),
  });
  if (json.code !== 0) {
    throw new Error('视频详情接口返回 code=' + json.code + (json.message ? ' ' + json.message : ''));
  }
  const d = json.data || {};
  return {
    desc: String(d.desc || '').trim(),
    ownerName: (d.owner && d.owner.name) || '',
    pic: d.pic || '',
  };
}

async function pushYunhu(text, contentType) {
  const url =
    'https://chat-go.jwzhd.com/open-apis/v1/bot/send?token=' + encodeURIComponent(CONFIG.YUNHU_TOKEN);

  const payload = JSON.stringify({
    recvId: String(CONFIG.YUNHU_RECV_ID),
    recvType: CONFIG.YUNHU_RECV_TYPE,
    contentType,
    content: { text },
  });

  const res = await gmFetch({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    data: payload,
  });

  if (res.status !== 200) throw new Error('云湖接口 HTTP ' + res.status);

  let json;
  try {
    json = JSON.parse(res.responseText);
  } catch (e) {
    throw new Error('云湖接口返回内容不是合法 JSON：' + String(res.responseText).slice(0, 200));
  }
  // 云湖的成功码为 1
  if (json.code !== 1) {
    throw new Error('云湖推送失败 code=' + json.code + (json.msg ? ' ' + json.msg : ''));
  }
  return json;
}

/* ---------------- 消息构造 ---------------- */

function buildMarkdown(video, detail, seasonTitle, overflow) {
  const owner = detail.ownerName || 'UP主';
  const lines = [];

  if (overflow > 0) {
    lines.push('（另有 ' + overflow + ' 条更早的更新未推送）');
    lines.push('');
  }
  lines.push('**' + owner + ' · 合集《' + seasonTitle + '》有新视频**');
  lines.push('');
  lines.push('**' + video.title + '**');
  lines.push(videoUrl(video.bvid));
  lines.push(
    '发布 ' + fmtDate(video.pubdate) +
    ' ｜ 时长 ' + fmtDuration(video.duration) +
    ' ｜ 播放 ' + fmtCount(video.stat && video.stat.view)
  );
  lines.push('');
  lines.push('**简介**');
  lines.push(truncate(detail.desc, CONFIG.DESC_MAX_LEN) || '（该视频未填写简介）');

  return lines.join('\n');
}

function buildHtml(video, detail, seasonTitle, overflow) {
  const owner = esc(detail.ownerName || 'UP主');
  const parts = [];

  if (overflow > 0) parts.push('<p>（另有 ' + overflow + ' 条更早的更新未推送）</p>');
  parts.push('<p><b>' + owner + ' · 合集《' + esc(seasonTitle) + '》有新视频</b></p>');
  if (CONFIG.PUSH_COVER && detail.pic) {
    parts.push('<p><img src="' + esc(toHttps(detail.pic)) + '" width="360"></p>');
  }
  parts.push('<p><a href="' + videoUrl(video.bvid) + '">' + esc(video.title) + '</a></p>');
  parts.push(
    '<p>发布 ' + fmtDate(video.pubdate) +
    ' ｜ 时长 ' + fmtDuration(video.duration) +
    ' ｜ 播放 ' + fmtCount(video.stat && video.stat.view) + '</p>'
  );
  parts.push('<p><b>简介</b></p>');
  parts.push('<p>' + esc(truncate(detail.desc, CONFIG.DESC_MAX_LEN)).replace(/\n/g, '<br>') + '</p>');

  return parts.join('');
}

/* ---------------- 关键字过滤 ---------------- */

function matchKeywords(title, keywords) {
  const text = String(title || '').toLowerCase();
  return keywords.some((k) => {
    const kw = String(k || '').toLowerCase();
    return !!kw && text.indexOf(kw) >= 0;
  });
}

/* ---------------- 主流程 ---------------- */

async function runWatcher(watch) {
  const label = watch.name || String(watch.seasonId);
  const stateKey = 'bh_watch_' + watch.mid + '_' + watch.seasonId;
  const season = await fetchSeasonArchives(watch);
  const seasonTitle = season.meta.title || label;
  const newest = season.archives[0];
  const baseline = await gmGet(stateKey, null);

  const saveBaseline = (video) =>
    gmSet(stateKey, {
      pubdate: video.pubdate,
      bvid: video.bvid,
      title: video.title,
      updatedAt: Date.now(),
    });

  let candidates = [];

  if (!baseline || !baseline.pubdate) {
    if (!CONFIG.FIRST_RUN_PUSH) {
      await saveBaseline(newest);
      return { label, status: 'init', message: '首次运行，已记录基线：' + newest.title };
    }
    candidates = [newest];
  } else {
    candidates = season.archives
      .filter((v) => v.pubdate > baseline.pubdate)
      .sort((a, b) => a.pubdate - b.pubdate);

    if (!candidates.length) {
      return { label, status: 'idle', message: '暂无更新，最新一条：' + newest.title };
    }
  }

  // 关键字过滤：命中任意一个关键字才推送；未配置关键字时全部推送
  const keywords = (watch.keywords || []).filter(Boolean);
  const matched = keywords.length
    ? candidates.filter((v) => matchKeywords(v.title, keywords))
    : candidates;

  if (!matched.length) {
    // 未命中的新视频同样视为已处理，基线推进到最新，避免反复扫描
    await saveBaseline(newest);
    return {
      label,
      status: 'filtered',
      message:
        '检测到 ' + candidates.length + ' 条新视频，标题均未命中关键字「' +
        keywords.join('、') + '」，已跳过',
    };
  }

  let overflow = 0;
  let toPush = matched;
  if (toPush.length > CONFIG.MAX_PUSH_PER_RUN) {
    overflow = toPush.length - CONFIG.MAX_PUSH_PER_RUN;
    toPush = toPush.slice(-CONFIG.MAX_PUSH_PER_RUN);
  }

  const pushed = [];
  for (const video of toPush) {
    const detail = await fetchVideoDetail(video.bvid);
    const contentType = CONFIG.CONTENT_TYPE === 'html' ? 'html' : 'markdown';
    const text =
      contentType === 'html'
        ? buildHtml(video, detail, seasonTitle, overflow)
        : buildMarkdown(video, detail, seasonTitle, overflow);

    await pushYunhu(text, contentType);
    pushed.push(video);
    log(label + ' 已推送：' + video.title);
    if (pushed.length < toPush.length) await sleep(800);
  }

  // 仅在推送全部成功后推进基线，推送失败时保留基线以便下次重试
  await saveBaseline(newest);

  return {
    label,
    status: 'pushed',
    message:
      '已推送 ' + pushed.length + ' 条' +
      (overflow > 0 ? '（另有 ' + overflow + ' 条未推送）' : '') +
      '：' + pushed.map((v) => v.title).join(' / '),
  };
}

async function main() {
  const missing = [];
  if (!CONFIG.YUNHU_TOKEN) missing.push('YUNHU_TOKEN');
  if (!CONFIG.YUNHU_RECV_ID) missing.push('YUNHU_RECV_ID');
  if (missing.length) {
    return '配置区未填写 ' + missing.join('、') + '，本次未执行';
  }
  if (!WATCH_LIST.length) {
    return '监控目标列表 WATCH_LIST 为空，本次未执行';
  }

  const results = [];
  for (let i = 0; i < WATCH_LIST.length; i++) {
    const watch = WATCH_LIST[i];
    if (i > 0) await sleep(1000);
    try {
      results.push(await runWatcher(watch));
    } catch (err) {
      results.push({
        label: watch.name || String(watch.seasonId),
        status: 'error',
        message: '执行失败：' + ((err && err.message) || String(err)),
      });
    }
  }

  const summary = results.map((r) => r.label + '：' + r.message).join('\n');
  log(summary);

  const pushed = results.filter((r) => r.status === 'pushed');
  const errors = results.filter((r) => r.status === 'error');

  if (pushed.length) {
    notify('B站合集监控', pushed.map((r) => r.label + '：' + r.message).join('\n').slice(0, 200));
  }
  if (errors.length) {
    notify(
      'B站合集监控执行异常',
      errors.map((r) => r.label + '：' + r.message).join('\n').slice(0, 200)
    );
  }

  return summary;
}

return (async function () {
  try {
    return await main();
  } catch (err) {
    const msg = '执行失败：' + ((err && err.message) || String(err));
    log(msg);
    notify('B站合集监控执行失败', msg);
    return msg;
  }
})();
