// scripts/lib.js
// 共享工具：GitHub API 客户端、查询限流、数据整形。
// 零依赖 Node.js（>=18，内置 fetch）。

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const API = 'https://api.github.com';
export const TOKEN =
  process.env.GITHUB_TOKEN || process.env.RADAR_TOKEN || process.env.PATROL_TOKEN || '';

export function headers() {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'reverse-radar-bot',
  };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

// 认证后 Search API 限 30 次/分钟。留出余量，按 32 次/分钟节流。
const SEARCH_INTERVAL_MS = Math.ceil(60000 / 32);
let lastSearchAt = 0;

export async function gh(pathname, { retries = 4, method = 'GET', body } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${API}${pathname}`, { method, headers: headers(), body });

    if (res.status === 403 || res.status === 429) {
      // 限流：优先按 Retry-After，其次按 X-RateLimit-Reset
      const retryAfter = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      let waitMs = 5000 * (attempt + 1);
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = retryAfter * 1000 + 1000;
      else if (Number.isFinite(reset) && reset > 0) waitMs = Math.max(0, reset * 1000 - Date.now()) + 1000;
      console.warn(`⏳ 触发限流(${res.status})，等待 ${Math.round(waitMs / 1000)}s 后重试…`);
      await sleep(Math.min(waitMs, 120000));
      continue;
    }

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      // 422 基本都是查询语法错，不该盲目重试
      if (res.status === 422) {
        throw new Error(`GitHub 422 查询语法错误: ${body}`);
      }
      if (attempt === retries) throw new Error(`GitHub API ${res.status}: ${body}`);
      await sleep(3000 * (attempt + 1));
      continue;
    }

    return res.json();
  }
  throw new Error('GitHub API 重试耗尽');
}

export async function search(q, { sort = 'stars', order = 'desc', page = 1, perPage = 100 } = {}) {
  const since = Date.now() - lastSearchAt;
  if (since < SEARCH_INTERVAL_MS) await sleep(SEARCH_INTERVAL_MS - since);
  lastSearchAt = Date.now();

  const qs = new URLSearchParams({ q, sort, order, page: String(page), per_page: String(perPage) });
  return gh(`/search/repositories?${qs}`);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 统一裁剪成看板需要的形状。字段与 trending-radar 对齐，便于两站复用视觉。
export function formatRepo(item) {
  return {
    id: item.id,
    name: item.name,
    fullName: item.full_name,
    url: item.html_url,
    description: item.description || '暂无描述',
    stars: item.stargazers_count,
    forks: item.forks_count,
    openIssues: item.open_issues_count,
    language: item.language || 'Other',
    owner: {
      login: item.owner.login,
      avatarUrl: item.owner.avatar_url,
      url: item.owner.html_url,
    },
    topics: item.topics || [],
    createdAt: item.created_at,
    pushedAt: item.pushed_at,
    updatedAt: item.updated_at,
    license: item.license ? item.license.spdx_id || item.license.name : null,
    archived: !!item.archived,
  };
}

// ── 噪音 / 黑名单过滤 ────────────────────────────────────────────────
//
// 本函数是整个雷达的「信噪比阀门」。两个实测教训：
//   1. awesome-list 类仓库 star 天然偏高（reverse-engineering topic 的全站 top1
//      就是 Awesome-Hacking 的 120606 星），不隔离会系统性挤掉真工具。
//   2. 前端生态把 "hooks" 当包名用，(hooking OR mitmproxy) stars:>100 的
//      top1 是 react-use(44076 星)，必须硬拦。

export function buildFilters(keywords) {
  const awesome = (keywords.noise?.awesomePatterns || []).map((p) => new RegExp(p, 'i'));
  const noiseKw = (keywords.noise?.keywords || []).map((s) => s.toLowerCase());
  const blacklist = (keywords.blacklist?.ownerOrNamePatterns || []).map((p) => new RegExp(p, 'i'));
  const relevance = new RegExp(keywords.relevance?.pattern || '$^', 'i');

  const haystack = (r) =>
    `${r.fullName} ${r.name} ${r.description} ${(r.topics || []).join(' ')}`.toLowerCase();

  return {
    // true = 资源清单（awesome / 教程 / roadmap），单列分区而不丢弃
    isResourceList(r) {
      const h = haystack(r);
      if (noiseKw.some((k) => h.includes(k))) return true;
      if (awesome.some((re) => re.test(r.name) || re.test(r.description))) return true;
      return (r.topics || []).some((t) => /^awesome/i.test(t));
    },
    // true = 与主题无关（前端 hooks 生态等），直接丢弃
    isOffTopic(r) {
      return blacklist.some((re) => re.test(r.fullName) || re.test(r.name));
    },
    // 语义校验：仅对「只靠 topic 命中」的条目生效。
    //
    // 为什么需要：topic 是作者自己打的，乱打现象严重。实测 topic:reverse-engineering
    // 捞到 Tyrrrz/YoutubeDownloader（下载器）、librepods-org/librepods（AirPods 工具）、
    // JCodesMore/ai-website-cloner-template（34k 星的网站克隆模板）——全都挂着这个
    // topic 但不是逆向工具。而 in:name,description 类查询本身就要求关键词出现在
    // 名称/简介里，天然已经过了一道校验，不重复卡。
    passesRelevance(r) {
      return relevance.test(`${r.name} ${r.description}`);
    },
  };
}

export async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
}

export function daysAgoISO(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// 测试锚点：仅供本地自检使用，让引擎可以为「过去某一天」生成数据，
// 从而在只有一份快照的情况下验证增量链路。生产环境（Actions）必须留空。
//   例：TEST_DATE=2026-09-09 RADAR_FAKE_BASELINE=1 node scripts/fetch.js
export const TEST_DATE = process.env.TEST_DATE || null;

export function todayISO() {
  return TEST_DATE || new Date().toISOString().slice(0, 10);
}
