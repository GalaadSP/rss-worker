// LarryFeed — Worker v2.0
// - Articles complets générés par IA (HTML) + attribution source en pied
// - Cache KV durable par article (post:v1:<hash>)
// - Endpoints:  /posts  (liste)  ·  /post/:slug  (HTML)
// - Cron: pré-génération régulière
// - Tags auto + priorityScore
// - CORS via env.CORS_ORIGIN

import { XMLParser } from "fast-xml-parser";

type Env = {
  FEED_CACHE: KVNamespace;      // KV unique pour items/etags/posts
  OPENAI_API_KEY?: string;
  CORS_ORIGIN?: string;
};

// ---------- FEEDS (IA / Tech / Philo / News / Crypto) ----------
const FEEDS = [
  // IA / ML
  { url: "https://openai.com/blog/rss",                    topic: "IA",    source: "OpenAI Blog" },
  { url: "https://www.anthropic.com/index.xml",            topic: "IA",    source: "Anthropic" },
  { url: "https://deepmind.google/discover/blog/feed.xml", topic: "IA",    source: "Google DeepMind" },
  { url: "https://feeds.feedburner.com/TheGradient",       topic: "IA",    source: "The Gradient" },

  // Tech
  { url: "https://www.theverge.com/rss/index.xml",         topic: "Tech",  source: "The Verge" },
  { url: "https://techcrunch.com/feed/",                   topic: "Tech",  source: "TechCrunch" },
  { url: "https://news.ycombinator.com/rss",               topic: "Tech",  source: "Hacker News" },

  // Philo / idées
  { url: "https://www.lesswrong.com/feed.xml",             topic: "Philo", source: "LessWrong" },
  { url: "https://aeon.co/feed.rss",                       topic: "Philo", source: "Aeon" },

  // News (général / éco)
  { url: "https://www.reuters.com/world/rss",              topic: "News",  source: "Reuters" },
  { url: "http://feeds.bbci.co.uk/news/rss.xml",           topic: "News",  source: "BBC News" },

  // Crypto (tu peux en ajouter)
  { url: "https://bitcoinmagazine.com/.rss",               topic: "Crypto", source: "Bitcoin Magazine" },
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml", topic: "Crypto", source: "CoinDesk" },
];

const MAX_ITEMS_PER_FEED = 25;
const GLOBAL_LIMIT = 100;
const CACHE_TTL_SECONDS = 60 * 30;   // 30 min pour XML/items
const SUM_TTL_SECONDS   = 60 * 60 * 12; // 12 h (si tu réutilises les résumés)
const POST_VER = "v1";               // bump => purge logique des anciens posts

// ---------- TYPES ----------
type Item = {
  id: string;
  title: string;
  url: string;
  date: string;
  topic: string;
  source: string;
  summary: string;
  tags: string[];
  priorityScore?: number;
};

type Post = { html: string; meta: PostMeta };
type PostMeta = {
  id: string;
  slug: string;
  title: string;
  date: string;
  topic: string;
  source: string;
  url: string;
  tags: string[];
};

// ---------- XML PARSER ----------
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

// ---------- HELPERS ----------
function resolveLink(raw: any): string {
  if (typeof raw?.link === "string") return raw.link.trim();
  if (Array.isArray(raw?.link)) {
    const alt = raw.link.find((l: any) => l?.["@_rel"] === "alternate" && l?.["@_href"]);
    if (alt?.["@_href"]) return String(alt["@_href"]).trim();
    const first = raw.link.find((l: any) => l?.["@_href"]);
    if (first?.["@_href"]) return String(first["@_href"]).trim();
  }
  if (raw?.link?.["@_href"]) return String(raw.link["@_href"]).trim();
  if (raw?.["atom:link"]?.["@_href"]) return String(raw["atom:link"]["@_href"]).trim();
  if (Array.isArray(raw?.["atom:link"])) {
    const alt = raw["atom:link"].find((l: any) => l?.["@_rel"] === "alternate" && l?.["@_href"]);
    if (alt?.["@_href"]) return String(alt["@_href"]).trim();
    const first = raw["atom:link"].find((l: any) => l?.["@_href"]);
    if (first?.["@_href"]) return String(first["@_href"]).trim();
  }
  if (raw?.content?.["@_src"]) return String(raw.content["@_src"]).trim();
  return "";
}

function stripHtml(s: string | undefined | null, limit = 1500): string {
  if (!s) return "";
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function slugify(s: string) {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function json(data: unknown, status = 200, env?: Env) {
  const h: Record<string,string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "max-age=60, stale-while-revalidate=120",
  };
  if (env?.CORS_ORIGIN) {
    h["access-control-allow-origin"] = env.CORS_ORIGIN;
    h["access-control-allow-headers"] = "content-type, authorization";
  }
  return new Response(JSON.stringify(data), { status, headers: h });
}

// ---------- TAGGING & SCORING ----------
const TAG_KEYWORDS: Record<string, RegExp[]> = {
  IA:     [/(\bAI\b|\bIA\b|artificial intelligence|machine learning|\bLLM\b|GPT|Anthropic|DeepMind)/i],
  Crypto: [/\bbitcoin\b|\bethereum\b|\bBTC\b|\bETH\b|blockchain|on.?chain/i],
  Macro:  /inflation|interest rate|central bank|ECB\b|Fed\b|récession|GDP|PIB|growth/i.source ? [ /./ ] : [ /./ ], // placeholder to avoid TS empty
  Tech:   [/startup|software|hardware|semiconductor|nvidia|apple|google|microsoft|security|vulnerability/i],
  Philo:  [/ethic|épistémologie|philos|existential|rational/i],
};

function autoTags(it: Item): string[] {
  const hay = `${it.title}\n${it.summary}\n${it.source}`.toLowerCase();
  const out: string[] = [];
  for (const [tag, regs] of Object.entries(TAG_KEYWORDS)) {
    if (regs.some((r) => r.test(hay))) out.push(tag);
  }
  if (it.topic && !out.includes(it.topic)) out.push(it.topic);
  return Array.from(new Set(out)).slice(0, 6);
}

const SOURCE_WEIGHT: Record<string, number> = {
  "Reuters": 1.2,
  "BBC News": 1.1,
  "AP Top": 1.05,
  "OpenAI Blog": 1.15,
  "Anthropic": 1.1,
  "Google DeepMind": 1.1,
  "Hacker News": 1.0,
  "TechCrunch": 1.0,
  "The Verge": 1.0,
  "LessWrong": 1.0,
  "Aeon": 1.0,
};

function priorityScore(it: Item): number {
  const hours = Math.max(0, (Date.now() - new Date(it.date).getTime()) / 36e5);
  const recency = Math.max(0, Math.min(1, 1 - hours / 24));
  const hot = /breakthrough|exclusive|leak|security|vulnerability|ban|merger|acquisition|earnings/i
    .test(it.title + " " + it.summary) ? 0.2 : 0;
  const src = SOURCE_WEIGHT[it.source] ?? 1.0;
  const iaBonus = (it.tags || []).includes("IA") ? 0.1 : 0;
  return +((0.6 * recency + hot + iaBonus) * src).toFixed(3);
}

// ---------- NORMALISATION ----------
function normalizeItem(feedMeta: any, raw: any): Item {
  const title = String(raw?.title ?? "").trim();
  const url = resolveLink(raw);
  const pub = raw?.pubDate || raw?.published || raw?.updated || raw?.["dc:date"];
  const date = pub ? new Date(pub).toISOString() : new Date().toISOString();
  const guidRaw = raw?.guid?.["#text"] ?? raw?.guid ?? "";
  const guid = (typeof guidRaw === "string" ? guidRaw : String(guidRaw)).trim();

  const id = guid || url || (title + "|" + date);
  const description =
    stripHtml(raw?.description, 1400) ||
    stripHtml(raw?.content, 1400) ||
    stripHtml(raw?.summary, 1400) || "";

  const base: Item = {
    id, title, url, date,
    topic: feedMeta.topic, source: feedMeta.source,
    summary: description, tags: [],
  };
  base.tags = autoTags(base);
  base.priorityScore = priorityScore(base);
  return base;
}

// ---------- FETCH FEED + CACHE (XML -> Items) ----------
async function fetchFeed(env: Env, feedMeta: any): Promise<Item[]> {
  const etagKey = `etag:${feedMeta.url}`;
  const cachedEtag = await env.FEED_CACHE.get(etagKey);

  const res = await fetch(feedMeta.url, {
    headers: cachedEtag ? { "If-None-Match": cachedEtag } : {},
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (res.status === 304) {
    const cached = await env.FEED_CACHE.get(`items:${feedMeta.url}`, "json");
    if (Array.isArray(cached)) return cached as Item[];
  }

  const text = await res.text();
  const newEtag = res.headers.get("ETag");
  if (newEtag) await env.FEED_CACHE.put(etagKey, newEtag, { expirationTtl: CACHE_TTL_SECONDS });

  const xml = parser.parse(text);
  let items: any[] = [];
  if (xml?.rss?.channel?.item) items = xml.rss.channel.item;
  else if (xml?.feed?.entry)   items = xml.feed.entry;
  else if (xml?.channel?.item) items = xml.channel.item;

  const normalized = (Array.isArray(items) ? items : [items])
    .slice(0, MAX_ITEMS_PER_FEED)
    .map((it) => normalizeItem(feedMeta, it));

  await env.FEED_CACHE.put(`items:${feedMeta.url}`, JSON.stringify(normalized), {
    expirationTtl: CACHE_TTL_SECONDS,
  });

  return normalized;
}

// ---------- POSTS (IA) ----------
function postKey(it: { id?: string; url?: string; title?: string }) {
  const base = `${it.url || ""}|${it.id || ""}|${it.title || ""}`;
  try {
    // @ts-ignore
    return `post:${POST_VER}:` + btoa(base);
  } catch {
    return `post:${POST_VER}:` + base;
  }
}
async function getPost(env: Env, key: string) {
  const raw = await env.FEED_CACHE.get(key, "json");
  return raw as Post | null;
}
async function putPost(env: Env, key: string, post: Post) {
  await env.FEED_CACHE.put(key, JSON.stringify(post));
}

async function generateArticle(env: Env, it: Item): Promise<Post> {
  if (!env.OPENAI_API_KEY) {
    // fallback minimal si pas de clé
    const html = `<article><h1>${escapeHtml(it.title)}</h1><p>${escapeHtml(it.summary)}</p>${footer(it)}</article>`;
    return { html, meta: baseMeta(it) };
  }

  const prompt = [
    `Écris un article clair, concis et structuré en français (350–700 mots) à partir de ces éléments.`,
    `Public: génération X, ton direct (woke-free), pas de flafla.`,
    `Structure:`,
    `- Un titre percutant (H1).`,
    `- 2 à 4 intertitres (H2/H3) avec paragraphes courts.`,
    `- 1 encadré "À retenir" (liste à puces).`,
    `Contraintes: factuel, pas d’affirmations non sourcées, pas de jargon gratuit.`,
    `Termine par un pied d’article avec la source fournie (lien).`,
    ``,
    `TITRE ORIGINE: ${it.title}`,
    `LIEN: ${it.url}`,
    `EXTRAIT: ${it.summary?.slice(0, 1500) || ""}`,
  ].join("\n");

  const payload = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Tu écris des articles synthétiques, journalistiques, lisibles sur mobile." },
      { role: "user", content: prompt },
    ],
    temperature: 0.6,
    max_tokens: 1200,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) throw new Error(`OpenAI ${r.status} ${await r.text()}`);
  const j = await r.json();
  const body = (j.choices?.[0]?.message?.content || "").trim();

  const html = ensureHtml(body, it);
  return { html, meta: baseMeta(it) };
}

function ensureHtml(body: string, it: Item): string {
  const hasHtml = /<\/?[a-z][\s\S]*>/i.test(body);
  const core = hasHtml ? body : `<h1>${escapeHtml(it.title)}</h1>\n<p>${escapeHtml(body).replace(/\n/g, "</p><p>")}</p>`;
  return `<article>${core}${footer(it)}</article>`;
}
function footer(it: Item) {
  return `
  <hr/>
  <div style="opacity:.8;font-size:.9em;margin-top:12px">
    Article généré par IA à partir d’un flux RSS.
    Source : <a href="${it.url}" target="_blank" rel="nofollow">${escapeHtml(it.source)}</a>.
  </div>`;
}
function baseMeta(it: Item): PostMeta {
  return {
    id: it.id,
    slug: slugify(it.title),
    title: it.title,
    date: it.date,
    topic: it.topic,
    source: it.source,
    url: it.url,
    tags: it.tags || [],
  };
}
function escapeHtml(s: string) {
  return (s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function ensurePosts(env: Env, items: Item[], limit = 6): Promise<Post[]> {
  const out: Post[] = [];
  let created = 0;
  for (const it of items) {
    const key = postKey(it);
    const cached = await getPost(env, key);
    if (cached) { out.push(cached); continue; }

    if (created >= limit) continue; // quota
    try {
      const post = await generateArticle(env, it);
      await putPost(env, key, post);
      out.push(post);
      created++;
    } catch (e) {
      console.error("generateArticle failed:", it.title, e);
    }
  }
  return out;
}

// ---------- HANDLERS ----------
export default {
  async scheduled(_evt: ScheduledEvent, env: Env) {
    try {
      const all = (await Promise.all(FEEDS.map((f) => fetchFeed(env, f)))).flat()
        .sort((a,b)=>new Date(b.date).getTime()-new Date(a.date).getTime());
      await ensurePosts(env, all, 4); // pré-génère 4 posts par run
    } catch (e) { console.error("cron error", e); }
  },

  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS" && env.CORS_ORIGIN) {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": env.CORS_ORIGIN,
          "access-control-allow-headers": "content-type, authorization",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "86400",
        },
      });
    }

    // --- /posts : liste (meta + excerpt) ---
    if (url.pathname === "/posts") {
      const all = (await Promise.all(FEEDS.map((f) => fetchFeed(env, f)))).flat();
      // dédup par URL (fallback id)
      const uniqMap = new Map<string, Item>();
      for (const it of all) uniqMap.set(it.url || it.id, it);
      let items = Array.from(uniqMap.values());

      // tri par priorityScore (déjà calculée dans normalizeItem)
      items.sort((a,b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
      items = items.slice(0, GLOBAL_LIMIT);

      // garantit la présence d'articles en cache (génère au besoin)
      const posts = await ensurePosts(env, items, 6);

      // renvoie meta + extrait (pas le HTML complet)
      const list = posts.map(p => ({
        ...p.meta,
        excerpt: (p.html.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()).slice(0, 220) + "…",
      }));
      return json(list, 200, env);
    }

    // --- /post/:slug : HTML complet ---
    if (url.pathname.startsWith("/post/")) {
      const slug = url.pathname.slice("/post/".length);
      if (!slug) return json({ error: "missing slug" }, 400, env);

      // retrouver l'item (scan léger)
      const all = (await Promise.all(FEEDS.map((f) => fetchFeed(env, f)))).flat();
      const hit = all.find(x => slugify(x.title) === slug || x.id === slug || x.url.endsWith(slug));
      if (!hit) return json({ error: "not found" }, 404, env);

      const key = postKey(hit);
      const post = await getPost(env, key);
      if (!post) return json({ error: "post not generated yet" }, 404, env);

      const headers: Record<string,string> = { "content-type": "text/html; charset=utf-8" };
      if (env.CORS_ORIGIN) headers["access-control-allow-origin"] = env.CORS_ORIGIN;
      return new Response(post.html, { status: 200, headers });
    }

    if (url.pathname === "/") return new Response("LarryFeed v2.0 OK", { status: 200 });

    return new Response("Not found", { status: 404 });
  },
};
