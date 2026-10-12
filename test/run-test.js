/**
 * bilibili-season-notify.user.js 的离线测试台
 *
 * 做法：读取用户脚本源码，注入一套 mock 的 GM_* 接口后在 Node 中执行。
 *   - 未提供 fixture 的请求走真实网络，验证请求头与接口解析确实可用；
 *   - 提供 fixture 的请求回放合成数据，用于精确构造关键字命中 / 未命中的分支；
 *   - 对 chat-go.jwzhd.com 的请求一律拦截，只记录 payload 并回放成功响应，避免污染真实群聊。
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

/* ---------------- 合成数据 ---------------- */

const V = (bvid, pubdate, title) => ({
  aid: parseInt(bvid.replace(/\D/g, ''), 10) || 1,
  bvid,
  ctime: pubdate,
  pubdate,
  duration: 200,
  title,
  pic: 'http://i0.hdslb.com/bfs/archive/demo.jpg',
  stat: { view: 12345, danmaku: 12 },
});

const fixSeason = (seasonId, archives, title) => ({
  match: 'season_id=' + seasonId,
  body: {
    code: 0,
    message: 'OK',
    ttl: 1,
    data: {
      archives,
      meta: { title: title || '合成合集', mid: 105493566, season_id: seasonId },
      page: { page_num: 1, page_size: archives.length, total: archives.length },
    },
  },
});

// 视频详情接口按 bvid 动态生成简介
const FIX_DETAIL = {
  match: 'x/web-interface/view',
  body: (url) => {
    const m = url.match(/bvid=([A-Za-z0-9]+)/);
    const bvid = m ? m[1] : 'BVUNKNOWN';
    return {
      code: 0,
      message: 'OK',
      ttl: 1,
      data: {
        bvid,
        desc: '合成简介：' + bvid + '\n领取地址：https://example.com/demo',
        owner: { name: 'Epic游戏资讯官' },
        pic: 'http://i0.hdslb.com/bfs/archive/demo.jpg',
      },
    };
  },
};

function matchFixture(url, fixtures) {
  for (const f of fixtures || []) {
    if (url.indexOf(f.match) >= 0) return f.body;
  }
  return null;
}

/* ---------------- 执行器 ---------------- */

function run(store, pushCapture, patches, fixtures) {
  const code = patchConfig(fs.readFileSync(SCRIPT_PATH, 'utf8'), patches);
  const requestLog = [];

  const GM_xmlhttpRequest = (opt) => {
    requestLog.push({ url: opt.url, method: opt.method || 'GET', headers: opt.headers || {} });

    if (opt.url.indexOf('https://chat-go.jwzhd.com') === 0) {
      pushCapture.push(JSON.parse(opt.data));
      setTimeout(
        () =>
          opt.onload({
            status: 200,
            responseText: JSON.stringify({ code: 1, data: {}, msg: 'success' }),
          }),
        0
      );
      return;
    }

    const fixture = matchFixture(opt.url, fixtures);
    if (fixture) {
      const body = typeof fixture === 'function' ? fixture(opt.url) : fixture;
      setTimeout(() => opt.onload({ status: 200, responseText: JSON.stringify(body) }), 0);
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

  return Promise.resolve(fn(GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_notification, GM_log)).then(
    (result) => ({ result, requestLog })
  );
}

const KEY_75265 = 'bh_watch_105493566_75265';
const KEY_94093 = 'bh_watch_105493566_94093';

/* ---------------- 用例 ---------------- */

(async function main() {
  const PATCH = { YUNHU_TOKEN: 'test-token-abcdef', YUNHU_RECV_ID: '10000001' };

  // ── 场景 1：首次运行，走真实网络 ──
  console.log('\n[场景 1] 首次运行：两个合集都只记录基线，不推送');
  const store = {};
  const pushes = [];
  const r1 = await run(store, pushes, PATCH, []);
  console.log('  返回：' + r1.result);
  check('两个合集都已完成首次基线记录', /Epic免费游戏合集：首次运行/.test(r1.result) && /游戏资讯：首次运行/.test(r1.result), r1.result);
  check('两个合集分别维护独立基线', !!store[KEY_75265] && !!store[KEY_94093], Object.keys(store).join(','));
  check('未产生推送', pushes.length === 0, '推送数=' + pushes.length);
  const listReq = r1.requestLog[0];
  check('列表请求携带浏览器 User-Agent', !!listReq.headers['User-Agent'], JSON.stringify(listReq.headers));
  check('请求头不含 Referer 以外的多余字段', Object.keys(listReq.headers).sort().join(',') === 'Referer,User-Agent', Object.keys(listReq.headers).join(','));
  check('第一个目标 URL 使用 75265', /season_id=75265/.test(listReq.url), listReq.url);
  check('第二个目标 URL 使用 94093', r1.requestLog.some((x) => /season_id=94093/.test(x.url)), '未请求 94093');

  // ── 场景 2：无更新，走真实网络 ──
  console.log('\n[场景 2] 基线等于最新发布时间：两个合集都应判定无更新');
  const r2 = await run(store, pushes, PATCH, []);
  console.log('  返回：' + r2.result.split('\n').join('\n  '));
  check('两个合集均为暂无更新', (r2.result.match(/暂无更新/g) || []).length === 2, r2.result);
  check('未产生推送', pushes.length === 0, '推送数=' + pushes.length);

  // ── 场景 3：合集 1（无关键字配置）出现新视频 ──
  console.log('\n[场景 3] 合集 1 出现新视频（未配关键字）：应直接推送');
  const fixA = [
    fixSeason(75265, [V('BV75265003', 1792000000, 'Epic每周免费游戏《合成新作》'), V('BV75265002', 1791000000, 'Epic每周免费游戏《合成旧作》')], 'Epic免费游戏合集'),
    fixSeason(94093, [V('BV94093001', 1791000000, 'Epic喜加二预告；合成内容')], '游戏资讯'),
  ];
  store[KEY_75265] = { pubdate: 1791000000 };
  store[KEY_94093] = { pubdate: 1791000000 };
  const before3 = pushes.length;
  const r3 = await run(store, pushes, PATCH, [FIX_DETAIL].concat(fixA));
  console.log('  返回：' + r3.result.split('\n').join('\n  '));
  const batch3 = pushes.slice(before3);
  check('恰好推送 1 条', batch3.length === 1, '推送数=' + batch3.length);
  check('基线已推进到合成最新视频', store[KEY_75265].pubdate === 1792000000, String(store[KEY_75265].pubdate));

  if (batch3.length) {
    const p = batch3[0];
    console.log('\n  ── 推送到云湖的请求体 ──');
    console.log('  ' + JSON.stringify(p, null, 2).split('\n').join('\n  '));
    check('recvId 正确', p.recvId === '10000001', String(p.recvId));
    check('recvType 正确', p.recvType === 'group', String(p.recvType));
    check('contentType 为 markdown', p.contentType === 'markdown', String(p.contentType));
    check('正文包含标题', p.content.text.indexOf('合成新作') >= 0);
    check('正文包含视频链接', p.content.text.indexOf('https://www.bilibili.com/video/BV75265003') >= 0);
    check('正文包含简介', p.content.text.indexOf('合成简介：BV75265003') >= 0);
    check('正文包含合集名', p.content.text.indexOf('Epic免费游戏合集') >= 0);
    const pushReq = r3.requestLog.find((x) => x.url.indexOf('chat-go.jwzhd.com') >= 0);
    check('推送 URL 携带 token', /[?&]token=test-token-abcdef/.test(pushReq.url), pushReq.url);
    const detailReq = r3.requestLog.find((x) => x.url.indexOf('x/web-interface/view') >= 0);
    check('已请求视频详情接口取简介', !!detailReq, '未请求详情');
  }

  // ── 场景 4：合集 2 有新视频，但标题不含关键字 ──
  console.log('\n[场景 4] 合集 2 有新视频但标题不含「神秘游戏」：应跳过推送');
  const fixB = [
    fixSeason(75265, [V('BV75265003', 1792000000, 'Epic每周免费游戏《合成新作》')], 'Epic免费游戏合集'),
    fixSeason(94093, [
      V('BV94093003', 1793000000, 'Epic喜加二预告；某厂商新作公布'),
      V('BV94093002', 1792900000, 'Steam促销开始；某新游发售'),
      V('BV94093001', 1792800000, '显卡降价；行业资讯汇总'),
    ], '游戏资讯'),
  ];
  store[KEY_94093] = { pubdate: 1792700000 };
  const before4 = pushes.length;
  const r4 = await run(store, pushes, PATCH, [FIX_DETAIL].concat(fixB));
  console.log('  返回：' + r4.result.split('\n').join('\n  '));
  check('未产生推送', pushes.length === before4, '推送数=' + (pushes.length - before4));
  check('返回文案说明关键字未命中', /未命中关键字「神秘游戏」/.test(r4.result), r4.result);
  check('基线仍然推进到最新（避免反复扫描）', store[KEY_94093].pubdate === 1793000000, String(store[KEY_94093].pubdate));

  // ── 场景 5：合集 2 新视频标题命中关键字 ──
  console.log('\n[场景 5] 合集 2 三条新视频中仅一条含「神秘游戏」：应只推送该条');
  const fixC = [
    fixSeason(75265, [V('BV75265003', 1792000000, 'Epic每周免费游戏《合成新作》')], 'Epic免费游戏合集'),
    fixSeason(94093, [
      V('BV94093003', 1793300000, 'Epic喜加二预告；某厂商新作公布'),
      V('BV94093002', 1793200000, 'Epic今晚揭晓神秘游戏；某厂商新作公布'),
      V('BV94093001', 1793100000, 'Steam促销开始；某新游发售'),
    ], '游戏资讯'),
  ];
  store[KEY_94093] = { pubdate: 1793000000 };
  const before5 = pushes.length;
  const r5 = await run(store, pushes, PATCH, [FIX_DETAIL].concat(fixC));
  console.log('  返回：' + r5.result.split('\n').join('\n  '));
  const batch5 = pushes.slice(before5);
  check('只推送命中的 1 条', batch5.length === 1, '推送数=' + batch5.length);
  check(
    '推送内容为含关键字的视频',
    batch5.length === 1 && batch5[0].content.text.indexOf('BV94093002') >= 0,
    batch5.length ? batch5[0].content.text.slice(0, 120) : ''
  );
  check('正文含关键字标题', batch5.length === 1 && batch5[0].content.text.indexOf('神秘游戏') >= 0);
  check('基线推进到最新视频而非命中视频', store[KEY_94093].pubdate === 1793300000, String(store[KEY_94093].pubdate));

  // ── 场景 6：重复执行不得重复推送 ──
  console.log('\n[场景 6] 紧接着再执行一次：不应重复推送');
  const before6 = pushes.length;
  const r6 = await run(store, pushes, PATCH, [FIX_DETAIL].concat(fixC));
  console.log('  返回：' + r6.result.split('\n').join('\n  '));
  check('未重复推送', pushes.length === before6, '推送数=' + (pushes.length - before6));
  check('两个合集均为暂无更新', (r6.result.match(/暂无更新/g) || []).length === 2, r6.result);

  // ── 场景 7：配置缺失 ──
  console.log('\n[场景 7] 云湖参数缺失：应跳过执行且不发请求');
  const r7 = await run({}, [], { YUNHU_TOKEN: '', YUNHU_RECV_ID: '' }, []);
  console.log('  返回：' + r7.result);
  check('提示配置缺失', /配置区未填写/.test(r7.result), r7.result);
  check('未发起任何网络请求', r7.requestLog.length === 0, '请求数=' + r7.requestLog.length);

  // ── 场景 8：风控码 -352 ──
  console.log('\n[场景 8] 接口返回风控码 -352：应重试后失败并保留基线');
  const failStore = {};
  const code = patchConfig(fs.readFileSync(SCRIPT_PATH, 'utf8'), PATCH);
  const gm352 = (opt) => {
    if (opt.url.indexOf('chat-go.jwzhd.com') === 0) return opt.onload({ status: 200, responseText: '{"code":1}' });
    opt.onload({ status: 200, responseText: '{"code":-352,"message":"-352","ttl":1}' });
  };
  const fn352 = new Function('GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_notification', 'GM_log', code);
  const r8 = await Promise.resolve(
    fn352(gm352, (k, d) => (k in failStore ? failStore[k] : d), (k, v) => (failStore[k] = v), () => {}, logs.push)
  );
  console.log('  返回：' + r8.split('\n').join('\n  '));
  check('返回执行失败信息', /执行失败/.test(r8), r8);
  check('错误信息点明风控码', /352/.test(r8), r8);
  check('失败时未写入基线', Object.keys(failStore).length === 0, JSON.stringify(failStore));

  console.log('\n──────────────────────────────');
  console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
  console.log('──────────────────────────────\n');
  process.exit(failCount === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试台异常：', e);
  process.exit(1);
});
