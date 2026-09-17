// scripts/fetch.js
// 逆向工程动向雷达 · 抓取引擎（零依赖 Node.js，跑在 GitHub Actions 上）
//
// 产出：
//   docs/data/latest.json            看板直接读的主数据
//   docs/data/snapshot/<date>.json   每日极简 Star 快照（算增速用）
//
// 为什么必须有快照：GitHub Search API 只返回「当前」star 数，不返回历史。
// 没有历史就永远算不出「涨了多少」——而「涨了多少」才是雷达的全部意义。

import { run as runInsight } from './insight.js';
import {
  search,
  formatRepo,
  buildFilters,
  readJson,
  writeJson,
  todayISO,
  daysAgoISO,
  TEST_DATE,
} from './lib.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'docs', 'data');
const SNAPSHOT = path.join(DATA, 'snapshot');

async function loadKeywords() {
  return JSON.parse(await fs.readFile(path.join(HERE, 'keywords.json'), 'utf8'));
}

// 抓一个查询的全部页。maxPages 保证单查询最多 6 页（600 条）。
// 注：GitHub 单查询最多翻 1000 条（10 页）。对本雷达「只关心头部」的用途，
// 600 条余量充足，无需再做 stars 区间切片——那是给「要全量」的场景准备的复杂度。
async function fetchQuery(q, cfg) {
  const pageSize = cfg.pageSize ?? 100;
  const maxPages = cfg.maxPagesPerQuery ?? 6;
  const collected = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await search(q, { sort: 'stars', order: 'desc', page, perPage: pageSize });
    const items = data.items || [];
    collected.push(...items);
    if (items.length < pageSize) break;
    if (collected.length >= (data.total_count || 0)) break;
  }
  return collected;
}

// 一个「腿」= 一组查询的并集。用 Map 按 repo id 去重。
//
// 分组存放两次遍历：只有「纯 topic 查询」需要再过一道语义校验，
// 先按查询分组累积，最后合并时才能知道每个仓库来自哪类查询。
async function fetchLeg(leg, cfg, log) {
  const seen = new Map();
  const relevanceQueries = new Set(cfg.relevance?.appliesToQueries || []);
  const allQueries = [...(leg.queries || []), ...(leg.topics || [])];
  let droppedByRelevance = 0;

  for (const q of allQueries) {
    const needsRelevance = relevanceQueries.has(q);
    try {
      const raw = await fetchQuery(q, cfg);
      let added = 0;
      for (const item of raw) {
        const existing = seen.get(item.id);
        // 已经通过「in:name,description」类查询进来的，直接保住，不被语义校验淘汰
        if (existing) {
          if (!needsRelevance) existing._verified = true;
          continue;
        }
        const repo = formatRepo(item);
        if (needsRelevance && !leg._relevanceTest(repo)) {
          droppedByRelevance++;
          continue;
        }
        repo._verified = !needsRelevance;
        seen.set(item.id, repo);
        added++;
      }
      log(`   · ${added} 条新增  ← ${q}${needsRelevance ? '  [topic-only · 已过语义校验]' : ''}`);
    } catch (err) {
      // 单条查询失败不拖垮整条腿——但必须显式记录，绝不静默吞掉
      log(`   ⚠️  查询失败: ${q}`);
      log(`      原因: ${err.message}`);
    }
  }
  if (droppedByRelevance) log(`   🧹 语义校验淘汰 ${droppedByRelevance} 条（挂错 topic 的噪音）`);
  return [...seen.values()];
}

// 「本周期新面孔」是独立的发现腿：只看近 N 天新建的仓库
async function fetchDiscovery(discovery, cfg, log) {
  const createdCut = daysAgoISO(45);
  const seen = new Map();
  for (const tpl of discovery.queries || []) {
    const q = tpl.replace('__CREATED__', createdCut);
    try {
      const raw = await fetchQuery(q, cfg);
      let added = 0;
      for (const item of raw) {
        if (!seen.has(item.id)) {
          seen.set(item.id, formatRepo(item));
          added++;
        }
      }
      log(`   · ${added} 条新增  ← ${q}`);
    } catch (err) {
      log(`   ⚠️  查询失败: ${q} — ${err.message}`);
    }
  }
  return [...seen.values()];
}

function sortByStars(list) {
  return [...list].sort((a, b) => b.stars - a.stars);
}

export async function run({ log = console.log } = {}) {
  const cfg = await loadKeywords();
  const filters = buildFilters(cfg);
  const date = todayISO();

  log(`📡 逆向工程动向雷达 · ${date} 开始抓取`);

  const legs = {};
  const overflow = []; // 资源清单分区（awesome / 教程类）
  const offTopic = []; // 被黑名单丢弃的，仅计数用于自检

  // 全量追踪表：只存 id→stars 的快照覆盖面必须覆盖「所有入库仓库」，
  // 不能只覆盖展示用的 top-60 —— 否则一个排在第 61 位正在起量的仓库
  // 永远不会被增速榜发现，而这恰恰是雷达存在的理由。
  const tracked = new Map(); // fullName -> { repo, buckets:Set }

  const track = (repo, bucket) => {
    if (!tracked.has(repo.fullName)) tracked.set(repo.fullName, { repo, buckets: new Set() });
    tracked.get(repo.fullName).buckets.add(bucket);
  };

  for (const leg of cfg.legs) {
    log(`\n【${leg.icon} ${leg.name}】`);
    leg._relevanceTest = (r) => filters.passesRelevance(r);
    const raw = await fetchLeg(leg, cfg, log);

    const keep = [];
    for (const r of raw) {
      if (filters.isOffTopic(r)) {
        offTopic.push(r.fullName);
        continue;
      }
      if (filters.isResourceList(r)) {
        overflow.push({ ...r, leg: leg.key });
        continue;
      }
      if (r.archived) continue;
      if (r.stars < (leg.minStarsFloor ?? cfg.minStars)) continue;
      keep.push(r);
      track(r, leg.key);
    }
    legs[leg.key] = {
      key: leg.key,
      name: leg.name,
      icon: leg.icon,
      desc: leg.desc,
      repos: sortByStars(keep).slice(0, 60),
      total: keep.length,
    };
    log(`   ✅ ${leg.name}: 抓取 ${raw.length} → 入库 ${keep.length} 条`);
  }

  log(`\n【${cfg.discovery.icon} ${cfg.discovery.name}】`);
  const discRaw = await fetchDiscovery(cfg.discovery, cfg, log);
  const discKeep = discRaw.filter(
    (r) => !filters.isOffTopic(r) && !filters.isResourceList(r) && !r.archived,
  );
  discKeep.forEach((r) => track(r, 'discovery'));
  const discovery = sortByStars(discKeep).slice(0, 40);
  log(`   ✅ 新面孔: 抓取 ${discRaw.length} → 入库 ${discKeep.length} 条`);

  // 去重后的资源清单（可能被多条腿重复捞到）
  const resourceMap = new Map();
  for (const r of overflow) if (!resourceMap.has(r.id)) resourceMap.set(r.id, r);
  const resources = sortByStars([...resourceMap.values()]).slice(0, 30);
  log(`\n📚 资源清单分区: ${resources.length} 条（已从主榜隔离）`);

  if (offTopic.length) {
    log(`🚫 黑名单拦截: ${offTopic.length} 条 —— ${offTopic.slice(0, 5).join(', ')}${offTopic.length > 5 ? ' …' : ''}`);
  }

  // 语言分布
  const langCount = {};
  const allRepos = [...discovery, ...Object.values(legs).flatMap((l) => l.repos)];
  for (const r of allRepos) langCount[r.language] = (langCount[r.language] || 0) + 1;

  const dataset = {
    updatedAt: new Date().toISOString(),
    date,
    legs,
    discovery: {
      key: 'discovery',
      name: cfg.discovery.name,
      icon: cfg.discovery.icon,
      desc: cfg.discovery.desc,
      repos: discovery,
      total: discovery.length,
    },
    resources,
    languages: Object.entries(langCount)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    stats: {
      uniqueRepos: tracked.size,
      shownRepos: new Set(allRepos.map((r) => r.id)).size,
      resourceLists: resources.length,
      blockedOffTopic: offTopic.length,
    },
    alertThreshold: cfg.alert?.surge7dStars ?? 1000,
  };

  // ── 写快照（极简 id→stars，覆盖全部入库仓库，用于次日算增速）──
  await fs.mkdir(SNAPSHOT, { recursive: true });
  const snapshot = {
    date,
    takenAt: new Date().toISOString(),
    stars: Object.fromEntries([...tracked.entries()].map(([fullName, v]) => [fullName, v.repo.stars])),
  };
  await writeJson(path.join(SNAPSHOT, `${date}.json`), snapshot);
  log(`\n💾 快照已写入 snapshot/${date}.json（${Object.keys(snapshot.stars).length} 条 · 全量追踪）`);

  // ── 快照保留 90 天 ──
  const files = (await fs.readdir(SNAPSHOT)).filter((f) => f.endsWith('.json')).sort();
  const stale = files.slice(0, Math.max(0, files.length - 90));
  for (const f of stale) await fs.rm(path.join(SNAPSHOT, f));
  if (stale.length) log(`🧹 清理 ${stale.length} 份过期快照（保留 90 天）`);

  // ── 对比历史快照算增速（传入全量追踪表，而非仅展示用切片）──
  const insight = await runInsight(dataset, { dataDir: DATA, log, tracked });
  dataset.insight = insight;

  await writeJson(path.join(DATA, 'latest.json'), dataset);
  log(`💾 主数据已写入 docs/data/latest.json`);

  return dataset;
}

// 直接执行时（本地调试 / Actions）
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((err) => {
    console.error('❌ 抓取失败:', err);
    process.exit(1);
  });
}
