// scripts/report-issue.js
// 把抓取结果投递到 GitHub Issue。
//
// 设计取舍：不每天新建 issue，而是维护「一个常驻滚动 issue」。
// 理由：实测本领域每天只有 1-2 条新料，若每天新开一条，三个月后会有
// 上百条 issue 要手动关闭，issue 列表会被自己的噪音淹没，最终没人看。
// 只有「异常飙升」（7 天涨破阈值）才单独开一条告警 issue。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gh, readJson, writeJson } from './lib.js';
import { TOKEN } from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'docs', 'data');
const STATE = path.join(DATA, 'issue-state.json');

const ISSUE_TITLE = '📡 逆向工程动向雷达 · 滚动周报';
const SITE = 'https://hedongli1.github.io/reverse-radar/';
const REPO = process.env.GITHUB_REPOSITORY || 'hedongli1/reverse-radar';

const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));

function repoLine(r, i, extra = '') {
  const desc = (r.description || '').replace(/\r?\n/g, ' ').slice(0, 90);
  return `${i}. **[${r.fullName}](${r.url})** · ⭐ ${fmt(r.stars)}${extra}\n   ${desc}`;
}

function compose(data) {
  const ins = data.insight || {};
  const L = [];

  L.push(`> 自动更新 · 最近一次抓取 **${data.date}**`);
  L.push(`> 在线看板：${SITE}`);
  L.push('');

  const rising = ins.rising7d || [];
  if (ins.baseline) {
    L.push(`## 📈 7 日涨星榜`);
    if (rising.length) {
      L.push(`<sub>对比 ${ins.baseline.date} 基线（${ins.baseline.age} 天前）</sub>`);
      L.push('');
      rising.slice(0, 15).forEach((r, i) => {
        L.push(repoLine(r, i + 1, ` · **+${fmt(r.delta)}** (${r.perDay}/天)`));
      });
    } else {
      L.push('本周期没有仓库录得增长。');
    }
    L.push('');
  } else {
    L.push('## 📈 7 日涨星榜');
    L.push(`_快照基线积累中。${ins.note || '雷达刚上线，7 日内开始产出增量。'}_`);
    L.push('');
  }

  const fresh = ins.newEntries || [];
  if (fresh.length) {
    L.push(`## 🌱 本周期新面孔`);
    L.push(`<sub>对比 ${ins.baseline?.date || '基线'} 未出现过、本次新进入视野的仓库</sub>`);
    L.push('');
    fresh.slice(0, 12).forEach((r, i) => L.push(repoLine(r, i + 1)));
    L.push('');
  }

  L.push(`## 🌱 最新发现`);
  L.push(`<sub>近 45 天内新建、已开始起量的项目</sub>`);
  L.push('');
  (data.discovery.repos || []).slice(0, 10).forEach((r, i) => {
    const days = Math.round((Date.now() - new Date(r.createdAt)) / 864e5);
    L.push(repoLine(r, i + 1, ` · 新建 ${days} 天`));
  });
  L.push('');

  for (const leg of Object.values(data.legs)) {
    L.push(`## ${leg.icon} ${leg.name}`);
    L.push(`<sub>${leg.desc} · 共 ${leg.total} 个仓库</sub>`);
    L.push('');
    (leg.repos || []).slice(0, 8).forEach((r, i) => L.push(repoLine(r, i + 1)));
    L.push('');
  }

  if ((data.resources || []).length) {
    L.push('<details><summary>📚 资源清单（awesome / 教程类，已隔离出主榜）</summary>');
    L.push('');
    data.resources.slice(0, 12).forEach((r, i) => L.push(repoLine(r, i + 1)));
    L.push('');
    L.push('</details>');
    L.push('');
  }

  L.push('---');
  L.push(`<sub>追踪 ${data.stats.uniqueRepos} 个仓库 · 拦截 ${data.stats.blockedOffTopic} 条无关命中 · 每日 UTC 02:07 更新</sub>`);

  return L.join('\n');
}

async function findExisting(number) {
  if (number) {
    try {
      return await gh(`/repos/${REPO}/issues/${number}`);
    } catch {
      /* 状态文件里的编号失效（issue 被删），回落到搜索 */
    }
  }
  const res = await gh(`/repos/${REPO}/issues?state=open&per_page=100`);
  return (Array.isArray(res) ? res : []).find(
    (i) => i.title === ISSUE_TITLE && !i.pull_request,
  );
}

export async function run({ log = console.log } = {}) {
  if (!TOKEN) {
    log('⚠️  无 GITHUB_TOKEN，跳过 issue 投递。');
    return;
  }
  const data = await readJson(path.join(DATA, 'latest.json'));
  if (!data) {
    log('⚠️  找不到 docs/data/latest.json，跳过 issue 投递。');
    return;
  }

  const state = (await readJson(STATE, {})) || {};
  const body = compose(data);
  const existing = await findExisting(state.rollingIssueNumber);

  if (existing) {
    await gh(`/repos/${REPO}/issues/${existing.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
    log(`📮 已更新滚动 issue #${existing.number}`);
    await writeJson(STATE, { ...state, rollingIssueNumber: existing.number });
  } else {
    const created = await gh(`/repos/${REPO}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: ISSUE_TITLE, body }),
    });
    log(`📮 已创建滚动 issue #${created.number}`);
    await writeJson(STATE, { ...state, rollingIssueNumber: created.number });
  }

  // ── 异常飙升：单独开告警 issue（同一仓库同一天只开一次）──
  const surges = data.insight?.surges || [];
  const alerted = new Set(state.alertedSurges || []);
  for (const s of surges) {
    const key = `${data.date}:${s.fullName}`;
    if (alerted.has(key)) continue;
    const created = await gh(`/repos/${REPO}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title: `🚨 异常飙升：${s.fullName} 7 天 +${fmt(s.delta)} ⭐`,
        body: [
          `**[${s.fullName}](${s.url})** 在 ${s.days} 天内涨了 **${s.delta}** star（${s.perDay}/天），突破告警阈值。`,
          '',
          `当前 ⭐ ${s.stars} · 语言 ${s.language}`,
          '',
          `> ${(s.description || '').slice(0, 300)}`,
          '',
          `在线看板：${SITE}`,
        ].join('\n'),
      }),
    });
    alerted.add(key);
    log(`🚨 已开告警 issue #${created.number} → ${s.fullName}`);
  }
  await writeJson(STATE, {
    ...state,
    alertedSurges: [...alerted].slice(-200),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((err) => {
    console.error('❌ issue 投递失败:', err);
    process.exit(1);
  });
}
