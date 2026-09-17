// scripts/insight.js
// 快照对比：把「当前 star 数」变成「涨了多少」。
//
// GitHub Search API 不返回历史 star。所以雷达的增量能力完全依赖
// docs/data/snapshot/ 下我们自己积累的每日快照——这也是为什么
// 快照必须在每天固定时刻拍摄：时刻不固定，差值就没有意义。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readJson } from './lib.js';

const SNAPSHOT_DIRNAME = 'snapshot';

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// 找到「最接近 N 天前」的那份快照。
// 窗口放宽到 [N, N+4] 天：Actions 偶发延迟会让某天缺拍，硬卡死会直接算不出来。
async function pickBaseline(snapshotDir, today, targetDays) {
  let files;
  try {
    files = (await fs.readdir(snapshotDir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return null;
  }
  const candidates = files
    .map((f) => f.replace('.json', ''))
    .filter((d) => d < today)
    .map((d) => ({ date: d, age: daysBetween(d, today) }))
    .filter((x) => x.age >= targetDays && x.age <= targetDays + 4)
    .sort((a, b) => a.age - b.age);

  if (!candidates.length) return null;
  const chosen = candidates[0];
  const snap = await readJson(path.join(snapshotDir, `${chosen.date}.json`));
  return snap ? { ...snap, age: chosen.age } : null;
}

export async function run(dataset, { dataDir, log = console.log, tracked } = {}) {
  const snapshotDir = path.join(dataDir, SNAPSHOT_DIRNAME);
  const today = dataset.date;

  // 增速必须在「全部入库仓库」上计算，而不是看板展示用的 top-60 切片 ——
  // 否则一个排在第 61 位正在起量的仓库永远不会被发现。
  const current = new Map();
  if (tracked) {
    for (const [fullName, { repo, buckets }] of tracked.entries()) {
      current.set(fullName, { repo, buckets: new Set(buckets) });
    }
  } else {
    const push = (r, bucket) => {
      if (!current.has(r.fullName)) current.set(r.fullName, { repo: r, buckets: new Set() });
      current.get(r.fullName).buckets.add(bucket);
    };
    dataset.discovery.repos.forEach((r) => push(r, 'discovery'));
    Object.values(dataset.legs).forEach((leg) => leg.repos.forEach((r) => push(r, leg.key)));
  }

  const baseline7 = await pickBaseline(snapshotDir, today, 7);
  const baseline1 = await pickBaseline(snapshotDir, today, 1);

  if (!baseline7 && !baseline1) {
    log('📊 尚无可比快照（首跑）。本次只记录基线，明日起开始产出增量。');
    return {
      generatedAt: new Date().toISOString(),
      date: today,
      baseline: null,
      note: '首跑：已写入今日基线快照，7 日内开始产出增量榜单。',
      rising7d: [],
      newEntries: [],
      surges: [],
    };
  }

  const compute = (baseline) => {
    if (!baseline) return [];
    return [...current.entries()]
      .map(([fullName, { repo, buckets }]) => {
        const before = baseline.stars[fullName];
        if (typeof before !== 'number') return null; // 基线里没有 = 新面孔，交给 newEntries
        const delta = repo.stars - before;
        if (delta <= 0) return null;
        return {
          fullName,
          name: repo.name,
          url: repo.url,
          description: repo.description,
          owner: repo.owner,
          stars: repo.stars,
          language: repo.language,
          delta,
          days: baseline.age,
          perDay: Math.round((delta / baseline.age) * 10) / 10,
          buckets: [...buckets],
        };
      })
      .filter(Boolean);
  };

  const rising7d = compute(baseline7).sort((a, b) => b.delta - a.delta).slice(0, 30);
  const rising24h = compute(baseline1).sort((a, b) => b.delta - a.delta).slice(0, 20);

  // 新面孔 = 距今 7 天前的基线里完全没有的仓库，且本身是新建不久的
  const newEntries = baseline7
    ? [...current.entries()]
        .filter(([fullName]) => !(fullName in baseline7.stars))
        .map(([, { repo, buckets }]) => ({
          fullName: repo.fullName,
          name: repo.name,
          url: repo.url,
          description: repo.description,
          owner: repo.owner,
          stars: repo.stars,
          language: repo.language,
          createdAt: repo.createdAt,
          buckets: [...buckets],
        }))
        .sort((a, b) => b.stars - a.stars)
        .slice(0, 25)
    : [];

  // 异常信号：7 天涨破阈值 → 单独开 issue 告警
  const surgeThreshold = dataset.alertThreshold ?? 1000;
  const surges = rising7d.filter((r) => r.delta >= surgeThreshold);

  log(`📈 7 日涨星榜 ${rising7d.length} 条（基线 ${baseline7?.date ?? '无'}）`);
  log(`🌱 本周新面孔 ${newEntries.length} 条`);
  if (surges.length) log(`🚨 异常飙升告警 ${surges.length} 条`);

  return {
    generatedAt: new Date().toISOString(),
    date: today,
    baseline: baseline7 ? { date: baseline7.date, age: baseline7.age } : null,
    baseline24h: baseline1 ? { date: baseline1.date, age: baseline1.age } : null,
    rising7d,
    rising24h,
    newEntries,
    surges,
  };
}
