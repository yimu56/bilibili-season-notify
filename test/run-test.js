/**
 * bilibili-season-notify.user.js 的离线测试台
 *
 * 做法：读取用户脚本源码，注入一套 mock 的 GM_* 接口后在 Node 中执行。
 *   - api.bilibili.com 的请求走真实网络，验证请求头与解析逻辑确实可用；
 *   - chat-go.jwzhd.com 的请求被拦截，只记录 payload 并回放成功响应，避免污染真实群聊。
 *
 * 运行：node test/run-test.js
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, '..', 'bilibili-season-notify.user.js');

let passCount = 0;
let failCount = 0;
const logs = [];

function check(name, ok, extra) {
  if (ok) {
    passCount++;
    console.log('  \u2713 ' + name);
  } else {
    failCount++;
    console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : ''));
  }
}

function realRequest(opt) {
  return new Promise((resolve, reject) => {
    const u = new URL(opt.url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: opt.method || 'GET',
        headers: opt.headers || {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, responseText: body }));
      }
    );
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    if (opt.data) req.write(opt.data);
    req.end();
  });
}

// 覆盖脚本源码里的 CONFIG 字段
function patchConfig(code, patches) {
  let out = code;
  for (const key of Object.keys(patches)) {
    const value = patches[key];
    const literal = typeof value === 'string' ? "'" + value + "'" : String(value);
    const re = new RegExp('(' + key + ':\\s*)(\'[^\']*\'|\\d+|true|false)');
    if (!re.test(out)) throw new Error('配置字段未找到：' + key);
    out = out.replace(re, '$1' + literal);
  }
  return out;
}

function run(store, pushCapture, patches) {
  const code = patchConfig(fs.readFileSync(SCRIPT_PATH, 'utf8'), patches);
  const requestLog = [];

  const GM_xmlhttpRequest = (opt) => {
    requestLog.push({ url: opt.url, method: opt.method || 'GET', headers: opt.headers || {} });
    if (opt.url.indexOf('https://chat-go.jwzhd.com') === 0) {
      pushCapture.push(JSON.parse(opt.data));
      setTimeout(
        () => opt.onload({ status: 200, responseText: JSON.stringify({ code: 1, data: {}, msg: 'success' }) }),
        0
      );
      return;
    }
    realRequest(opt).then(
      (r) => opt.onload(r),
      (e) => opt.onerror({ error: e.message })
    );
  };

  const GM_getValue = (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d);
  const GM_setValue = (k, v) => {
    store[k] = v;
  };
  const GM_notification = (o) => logs.push('[通知] ' + o.title + '：' + o.text);
  const GM_log = (t) => logs.push(t);

  const fn = new Function(
    'GM_xmlhttpRequest',
    'GM_getValue',
    'GM_setValue',
    'GM_notification',
    'GM_log',
    code
  );

  return Promise.resolve(
    fn(GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_notification, GM_log)
  ).then((result) => ({ result, requestLog }));
}

(async function main() {
  const store = {};
  const pushes = [];
  const PATCH = { YUNHU_TOKEN: 'test-token-abcdef', YUNHU_RECV_ID: '10000001' };

  console.log('\n[场景 1] 首次运行：无历史基线，只记录不推送');
  const r1 = await run(store, pushes, PATCH);
  console.log('  返回：' + r1.result);
  check('返回首次运行提示', /首次运行/.test(r1.result), r1.result);
  check('未产生推送', pushes.length === 0, '推送数=' + pushes.length);
  const stateKey = 'bh_watch_105493566_75265';
  check('已写入本地基线', !!store[stateKey] && !!store[stateKey].pubdate, JSON.stringify(store));
  check('列表请求携带 User-Agent', !!r1.requestLog[0].headers['User-Agent'], JSON.stringify(r1.requestLog[0].headers));
  check('列表请求 URL 正确', /seasons_archives_list\?mid=105493566&season_id=75265&sort_reverse=true/.test(r1.requestLog[0].url), r1.requestLog[0].url);
  const newest = store[stateKey];

  console.log('\n[场景 2] 基线等于最新发布时间：应判定为无更新');
  const r2 = await run(store, pushes, PATCH);
  console.log('  返回：' + r2.result);
  check('返回暂无更新', /暂无更新/.test(r2.result), r2.result);
  check('未产生推送', pushes.length === 0, '推送数=' + pushes.length);

  console.log('\n[场景 3] 基线落后 1 秒：应检测到新视频并推送');
  store[stateKey] = Object.assign({}, newest, { pubdate: newest.pubdate - 1 });
  const r3 = await run(store, pushes, PATCH);
  console.log('  返回：' + r3.result);
  check('已产生推送', pushes.length === 1, '推送数=' + pushes.length);
  check('请求链路完整（列表+详情+推送）', r3.requestLog.length === 3, '请求数=' + r3.requestLog.length);

  if (pushes.length) {
    const p = pushes[0];
    console.log('\n  ── 推送到云湖的请求体 ──');
    console.log('  ' + JSON.stringify(p, null, 2).split('\n').join('\n  '));

    check('recvId 正确', p.recvId === '10000001', String(p.recvId));
    check('recvType 正确', p.recvType === 'group', String(p.recvType));
    check('contentType 为 markdown', p.contentType === 'markdown', String(p.contentType));
    check('content.text 为非空字符串', typeof p.content.text === 'string' && p.content.text.length > 20);
    check('正文包含视频标题', p.content.text.indexOf('Epic') >= 0);
    check('正文包含合集名', p.content.text.indexOf('Epic免费游戏合集') >= 0);
    check('正文包含视频链接', /https:\/\/www\.bilibili\.com\/video\/BV/.test(p.content.text));
    check('正文包含简介段落', p.content.text.indexOf('简介') >= 0);

    const detailReq = r3.requestLog.find((x) => x.url.indexOf('x/web-interface/view') >= 0);
    check('已请求视频详情接口取简介', !!detailReq, JSON.stringify(r3.requestLog.map((x) => x.url)));

    const pushReq = r3.requestLog.find((x) => x.url.indexOf('chat-go.jwzhd.com') >= 0);
    check('推送 URL 携带 token', /[?&]token=test-token-abcdef/.test(pushReq.url), pushReq.url);
  }

  console.log('\n[场景 3b] 基线落后 30 天：应触发单次条数上限并提示剩余数量');
  const before3b = pushes.length;
  store[stateKey] = Object.assign({}, newest, { pubdate: newest.pubdate - 30 * 86400 });
  const r3b = await run(store, pushes, PATCH);
  console.log('  返回：' + r3b.result);
  const batch = pushes.slice(before3b);
  check('单次推送不超过 3 条', batch.length === 3, '推送数=' + batch.length);
  check('返回文案说明有剩余未推送', /另有 \d+ 条未推送/.test(r3b.result), r3b.result);
  check('首条消息带剩余数量提示', /另有 \d+ 条更早的更新未推送/.test(batch[0].content.text));
  check(
    '最后一条为最新的视频',
    batch[batch.length - 1].content.text.indexOf('BV1eBH96aEW4') >= 0,
    batch[batch.length - 1].content.text.split('\n')[2]
  );

  console.log('\n[场景 4] 基线推进：下次执行应判定无更新（防重复推送）');
  const skipped = pushes.length;
  const r4 = await run(store, pushes, PATCH);
  console.log('  返回：' + r4.result);
  check('未重复推送', pushes.length === skipped, '推送数=' + pushes.length);
  check('返回暂无更新', /暂无更新/.test(r4.result), r4.result);

  console.log('\n[场景 5] 云湖参数缺失：应跳过执行且不发请求');
  const r5 = await run({}, [], { YUNHU_TOKEN: '', YUNHU_RECV_ID: '' });
  console.log('  返回：' + r5.result);
  check('提示配置缺失', /配置区未填写/.test(r5.result), r5.result);
  check('未发起任何网络请求', r5.requestLog.length === 0, '请求数=' + r5.requestLog.length);

  console.log('\n[场景 6] 接口返回风控码 -352：应重试后抛错并给出通知');
  const failStore = {};
  const failPushes = [];
  const code = patchConfig(fs.readFileSync(SCRIPT_PATH, 'utf8'), PATCH);
  const gm352 = (opt) => {
    if (opt.url.indexOf('chat-go.jwzhd.com') === 0) return opt.onload({ status: 200, responseText: '{"code":1}' });
    opt.onload({ status: 200, responseText: '{"code":-352,"message":"-352","ttl":1}' });
  };
  const fn352 = new Function('GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_notification', 'GM_log', code);
  const r6 = await Promise.resolve(
    fn352(gm352, (k, d) => (k in failStore ? failStore[k] : d), (k, v) => (failStore[k] = v), () => {}, logs.push)
  );
  console.log('  返回：' + r6);
  check('返回执行失败信息', /执行失败/.test(r6), r6);
  check('错误信息点明风控', /352/.test(r6), r6);

  console.log('\n──────────────────────────────');
  console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
  console.log('──────────────────────────────\n');
  process.exit(failCount === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试台异常：', e);
  process.exit(1);
});
