# B站合集更新监控 · 云湖机器人推送

基于 ScriptCat（脚本猫）的定时脚本：定时检测 B 站指定合集是否发布新视频，
发现更新后自动把视频标题、链接与简介推送到云湖机器人。

## 特性

- **定时检测**：浏览器启动后按 cron 周期自动执行，无需人工干预
- **精确去重**：以视频发布时间为基线，同一视频只推送一次
- **多天补推**：单次执行可覆盖多天未运行的情况，超出条数上限时给出剩余数量提示
- **简介优先**：推送正文包含视频简介全文，截断长度可配置
- **自包含**：单文件脚本，零第三方依赖，不使用 `@require` 加载外部库
- **失败不丢消息**：仅在推送成功后推进基线，网络异常时下次执行会重新尝试

## 快速开始

### 1. 安装

在 ScriptCat 中新建脚本并粘贴脚本内容，或把下面的地址加入脚本猫的「导入脚本」：

```
https://raw.githubusercontent.com/yimu56/bilibili-season-notify/main/bilibili-season-notify.user.js
```

### 2. 配置

打开脚本，修改文件顶部的配置区：

```js
const CONFIG = {
  MID: 105493566,          // UP 主 UID
  SEASON_ID: 75265,        // 合集 ID

  YUNHU_TOKEN: '',         // 云湖机器人 token
  YUNHU_RECV_ID: '',       // 接收者 ID
  YUNHU_RECV_TYPE: 'group',
  // ...
};
```

**B 站参数**：打开合集地址
`https://space.bilibili.com/105493566/lists/75265?type=season`，
路径中的 `105493566` 即 `MID`，`lists/` 之后的 `75265` 即 `SEASON_ID`。

**云湖参数**：在云湖控制台创建机器人后，控制台会给出「机器人发送消息链接」，
形如 `https://chat-go.jwzhd.com/open-apis/v1/bot/send?token=xxxxxxxx`，
其中 `token=` 之后的内容即 `YUNHU_TOKEN`。接收者 ID 填群号
（`YUNHU_RECV_TYPE` 为 `group`）或用户 ID（`YUNHU_RECV_TYPE` 为 `user`）。

### 3. 验证

脚本开启后等待 cron 触发，或在脚本猫面板上点击「运行一次」手动执行。

## 配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `MID` | `105493566` | 目标 UP 主 UID |
| `SEASON_ID` | `75265` | 目标合集 ID |
| `YUNHU_TOKEN` | 空 | 云湖机器人 token，必填 |
| `YUNHU_RECV_ID` | 空 | 云湖接收者 ID，必填 |
| `YUNHU_RECV_TYPE` | `group` | `group` 为群聊，`user` 为私聊 |
| `CONTENT_TYPE` | `markdown` | `markdown` 自动适配深浅色；`html` 支持封面图 |
| `PUSH_COVER` | `false` | 是否输出封面图，仅 `CONTENT_TYPE` 为 `html` 时生效 |
| `MAX_PUSH_PER_RUN` | `3` | 单次执行最多推送条数 |
| `DESC_MAX_LEN` | `500` | 简介截断长度 |
| `FIRST_RUN_PUSH` | `false` | 首次运行是否推送当前最新视频 |
| `SCAN_SIZE` | `20` | 单次拉取的视频条数 |

## 推送效果

```
**Epic游戏资讯官 · 合集《Epic免费游戏合集》有新视频**

**Epic每周免费游戏《熊视眈眈》《愿景之城》**
https://www.bilibili.com/video/BV1eBH96aEW4
发布 2026-10-08 23:00 ｜ 时长 04:01 ｜ 播放 2.9万

**简介**
《愿景之城》
(TerraScape)
领取地址：
https://store.epicgames.com/p/terrascape-2b12b1
```

## 工作原理

1. 调用 B 站合集接口 `seasons_archives_list`，按发布时间倒序取最近 `SCAN_SIZE` 个视频
2. 与本地存储的基线时间比对，筛选出发布时间晚于基线的视频
3. 逐个调用视频详情接口 `web-interface/view` 取得简介
4. 拼接消息并推送到云湖机器人
5. 全部推送成功后更新基线

基线保存在脚本猫的脚本存储中，键名为 `bh_watch_<MID>_<SEASON_ID>`，删除该键即可重置。

## 定时策略

元数据中的 `@crontab * 8-23 once * *` 表示：每天 08:00-23:59 之间首次触发时执行一次，当天只执行一次。

浏览器关闭期间定时脚本不会执行，`once` 写法可以保证当天只要开机就会补上这一次。
如需固定时间执行，改成 `0 9 * * *`（每天 09:00），代价是错过该时刻当天不再执行。

## 已知限制

- **B 站接口要求浏览器 User-Agent**：合集接口缺少浏览器 UA 会返回 `-352` 风控错误，
  仅带 Referer 不带 UA 同样会被拒绝。脚本已固定携带浏览器 UA，并内置三次重试。
- **云湖图片消息不支持外链**：图片消息只能使用云湖「图片上传」接口返回的 `imageKey`，
  无法直接引用外部图片地址。因此默认只推送文字，封面图仅在 `CONTENT_TYPE` 为 `html`
  时以外链形式展示。
- **云湖成功码为 1**：云湖接口正常返回 `{"code": 1}`，而非常见的 `0`。
- **依赖浏览器常驻**：ScriptCat 定时脚本需要浏览器运行期间才会触发；
  若需 7×24 执行，可考虑用 CloudCat 将脚本部署到服务器。

## 项目结构

```
bilibili-season-notify/
├── bilibili-season-notify.user.js   # 用户脚本主体
├── test/
│   └── run-test.js                  # 离线测试台
├── LICENSE
└── README.md
```

## 测试

`test/run-test.js` 通过注入模拟的 GM 接口，在 Node 中执行脚本源码：

- 对 B 站的请求走真实网络，验证请求头与解析逻辑确实可用
- 对云湖的请求被拦截，仅记录请求体并回放成功响应，不会发送到真实群聊

```bash
node test/run-test.js
```

覆盖场景：首次运行记录基线、无更新、检测到更新并推送、单次条数上限与剩余数量提示、
基线推进防重复推送、配置缺失跳过执行、风控码重试失败。

## 更新日志

### 1.0.0

- 首个版本

## 免责声明

本项目仅供学习与研究使用，与哔哩哔哩、云湖官方无任何关联。

使用过程需遵守目标站点的服务条款与相关法律法规，因使用本项目产生的一切后果由使用者自行承担。
相关接口可能随时变更，脚本不保证长期可用。

## 许可证

[MIT](./LICENSE)
