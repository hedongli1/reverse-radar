# 📡 逆向工程动向雷达 · Reverse Radar

每日追踪**逆向工程**领域的开源新晋与飙升项目。常驻 GitHub Actions，无需人工干预。

**在线看板 → https://hedongli1.github.io/reverse-radar/**

---

## 追踪范围

| 分区 | 内容 |
| :--- | :--- |
| 🔬 **二进制 / 安全逆向** | 反编译、反汇编、动态插桩、恶意样本与固件分析（Ghidra / IDA / radare2 / Frida / angr …） |
| 📡 **前端 / 协议逆向** | App 协议解析、抓包中间人、注入与 Hooking、爬虫反混淆（mitmproxy / Xposed / jadx / 微信抖音协议 …） |
| 🌱 **本周期新面孔** | 近 45 天内新建、已开始起量的项目 |
| 📈 **7 日涨星榜** | 对比历史快照算出的真实增速 —— 雷达的核心产出 |
| 📚 **资源清单** | awesome-list / 教程 / 学习路线（已隔离出主榜，见下文） |

> Agent / LLM 方向不在此雷达范围内，由姊妹项目 [aiscan](https://github.com/hedongli1/aiscan) 覆盖。

---

## 它和「热榜」有什么不同

**只追增量，不追存量。** 按总 star 数排序的榜单对逆向工程这个领域没有信息量：头部十年没变过（Ghidra、IDA、radare2），第一次跑完就再也不会打开。

所以本雷达的核心是 **7 日涨星榜**——它回答的是「这一周，这个领域里什么在动」。

---

## 运行机制

```
每日 UTC 02:07
    ↓
scripts/fetch.js      多词表 × 多查询抓取 → 去噪 → 入库
    ↓
docs/data/snapshot/   每日 Star 快照（算增速的唯一依据）
    ↓
scripts/insight.js    对比 7 天前基线 → 增量榜 / 新面孔 / 飙升告警
    ↓
docs/data/latest.json 看板数据
    ↓
scripts/report-issue.js  → 滚动周报 issue
    ↓
GitHub Pages 部署
```

**为什么必须有快照**：GitHub Search API 只返回*当前* star 数，不返回历史。没有自建的历史快照，就永远算不出「涨了多少」——而「涨了多少」才是雷达的全部意义。

**为什么快照必须同一时刻拍**：时刻漂移会让 7 天差值失真。这是本仓库定时任务不容改动的部分。

---

## 工程笔记：三个踩过的坑

这些是实测出来的、会直接让雷达跑歪的陷阱，记录下来避免以后重蹈。

### 1. GitHub 不允许同类型限定符做 OR

```
topic:proxy OR topic:mitmproxy     → 422 Validation Failed
```

报错信息是：

> The search contains only logical operators (AND / OR / NOT) without any search terms

裸词 OR 合法（`frida OR ghidra in:name,description`），**限定符 OR 不合法**。这条查询写错会让整个 workflow 变红，而不是静默跳过。

### 2. 括号会让 `in:` 限定符静默失效

```
(hooking OR mitmproxy) in:name,description   → 151987 条（混入 react-use、alibaba/hooks）
hooking OR mitmproxy in:name,description     →   1392 条（干净）
```

括号打断了限定符的作用域。**裸词 OR 时绝不能加括号。**

### 3. `topic:` 由作者自行填写，乱打严重

实测挂 `reverse-engineering` topic 的仓库里包含：

- `Tyrrrz/YoutubeDownloader`（YouTube 下载器）
- `librepods-org/librepods`（AirPods 工具）
- `JCodesMore/ai-website-cloner-template`（34k 星的网站克隆模板）

因此纯 topic 查询必须再过一道语义校验（见 `keywords.json` 的 `relevance` 段），实测淘汰 173 条挂错标签的噪音。

### 4. 前端生态会污染 "hooking"

`(hooking OR mitmproxy) stars:>100` 的 top1 是 `react-use`（44076 星），top3 是 `alibaba/hooks`（14972 星）。前端圈子把 "hooks" 当核心词用。必须靠黑名单硬拦。

---

## 维护

| 频率 | 事项 |
| :--- | :--- |
| 每周 | 看一眼 Actions 是否有红；三个 URL 刷一次确认非 404 |
| 每月 | 检查 `docs/data/snapshot/` 是否在稳步增长；看板「7 日涨星」是否有内容 |
| 每季度 | 复审 `scripts/keywords.json` 词表，剔除失效查询、补充新平台 |

**改词表不用改代码**：所有查询都在 `scripts/keywords.json`，新增一条查询 push 即可生效。

### 已知风险

- **公开仓库 60 天无活动 → GitHub 会自动禁用定时任务**。本仓库每日提交数据，不会触发；但如果雷达停摆超过 60 天，需要在 Actions 页面手动重新启用。
- 单条查询失败不会中断整个 workflow，只会在日志里记录 `⚠️ 查询失败`。定期检查日志，避免某条查询长期静默失效。

---

## 本地运行

```bash
GITHUB_TOKEN=<token> node scripts/fetch.js        # 抓取 + 算增量
GITHUB_TOKEN=<token> node scripts/report-issue.js # 投递 issue（可选）
```

零依赖，Node.js >= 18。

---

## 姊妹项目

- [trending-radar](https://github.com/hedongli1/trending-radar) — 全站开源趋势雷达
- [aiscan](https://github.com/hedongli1/aiscan) — AI 代码安全审计引擎
- [博客](https://hedongli1.github.io/)

---

MIT
