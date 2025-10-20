// LarryFeed — Worker v2.0
// - Articles complets générés par IA (HTML) + attribution source en pied
// - Cache KV durable par article (post:v1:<hash>)
// - Endpoints:  /posts  (liste)  ·  /post/:slug  (HTML)
// - Cron: pré-génération régulière
// - Tags auto + priorityScore
// - CORS via env.CORS_ORIGIN

import { XMLParser } from "fast-xml-parser";

/**
 * Environment bindings exposed by the Worker runtime.
 */
export type Env = {
  /** Shared cache used for raw feed items, etags and generated posts. */
  FEED_CACHE: KVNamespace;
  OPENAI_API_KEY?: string;
  CORS_ORIGIN?: string;
};

type FeedConfig = {
  url: string;
  topic: Item["topic"];
  source: Item["source"];
};

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

type RouteHandler = (request: Request, env: Env) => Promise<Response>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const FEEDS: FeedConfig[] = [
  { url: "https://openai.com/blog/rss", topic: "IA", source: "OpenAI Blog" },
  { url: "https://www.anthropic.com/index.xml", topic: "IA", source: "Anthropic" },
  { url: "https://deepmind.google/discover/blog/feed.xml", topic: "IA", source: "Google DeepMind" },
  { url: "https://feeds.feedburner.com/TheGradient", topic: "IA", source: "The Gradient" },
  { url: "https://www.theverge.com/rss/index.xml", topic: "Tech", source: "The Verge" },
  { url: "https://techcrunch.com/feed/", topic: "Tech", source: "TechCrunch" },
  { url: "https://news.ycombinator.com/rss", topic: "Tech", source: "Hacker News" },
  { url: "https://www.lesswrong.com/feed.xml", topic: "Philo", source: "LessWrong" },
  { url: "https://aeon.co/feed.rss", topic: "Philo", source: "Aeon" },
  { url: "https://www.reuters.com/world/rss", topic: "News", source: "Reuters" },
  { url: "http://feeds.bbci.co.uk/news/rss.xml", topic: "News", source: "BBC News" },
  { url: "https://bitcoinmagazine.com/.rss", topic: "Crypto", source: "Bitcoin Magazine" },
  {
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml",
    topic: "Crypto",
    source: "CoinDesk",
  },
];

const MAX_ITEMS_PER_FEED = 25;
const GLOBAL_LIMIT = 100;
const CACHE_TTL_SECONDS = 60 * 30; // 30 min pour XML/items
const SUM_TTL_SECONDS = 60 * 60 * 12; // 12 h (si tu réutilises les résumés)
const POST_VER = "v1";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function resolveLink(raw: any): string {
  if (typeof raw?.link === "string") return raw.link.trim();

  const fromAtomLinkArray = (links: any[]): string => {
    const alternate = links.find((l) => l?.["@_rel"] === "alternate" && l?.["@_href"]);
    if (alternate?.["@_href"]) return String(alternate["@_href"]).trim();
    const first = links.find((l) => l?.["@_href"]);
    if (first?.["@_href"]) return String(first["@_href"]).trim();
    return "";
  };

  if (Array.isArray(raw?.link)) {
    const candidate = fromAtomLinkArray(raw.link);
    if (candidate) return candidate;
  }

  if (raw?.link?.["@_href"]) return String(raw.link["@_href"]).trim();

  if (raw?.["atom:link"]) {
    const atomLink = raw["atom:link"];
    if (Array.isArray(atomLink)) {
      const candidate = fromAtomLinkArray(atomLink);
      if (candidate) return candidate;
    }
    if (atomLink?.["@_href"]) return String(atomLink["@_href"]).trim();
  }

  if (raw?.content?.["@_src"]) return String(raw.content["@_src"]).trim();
  return "";
}

function stripHtml(s: string | undefined | null, limit = 1500): string {
  if (!s) return "";
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function json(data: unknown, status = 200, env?: Env) {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "max-age=60, stale-while-revalidate=120",
  };
  applyCors(headers, env?.CORS_ORIGIN);
  return new Response(JSON.stringify(data), { status, headers });
}

function applyCors(headers: Record<string, string>, origin?: string) {
  if (!origin) return;
  headers["access-control-allow-origin"] = origin;
  headers["access-control-allow-headers"] = "content-type, authorization";
}

function escapeHtml(s: string) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function footer(it: Item) {
  return `
  <hr/>
  <div style="opacity:.8;font-size:.9em;margin-top:12px">
    Article généré par IA à partir d’un flux RSS.
    Source : <a href="${it.url}" target="_blank" rel="nofollow">${escapeHtml(it.source)}</a>.
  </div>`;
}

function ensureHtml(body: string, it: Item): string {
  const hasHtml = /<\/?[a-z][\s\S]*>/i.test(body);
  const core = hasHtml
    ? body
    : `<h1>${escapeHtml(it.title)}</h1>
<p>${escapeHtml(body).replace(/\n/g, "</p><p>")}</p>`;
  return `<article>${core}${footer(it)}</article>`;
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

function safeBase64(input: string): string {
  try {
    if (typeof btoa === "function") return btoa(input);
  } catch {
    // continue to Buffer fallback
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(input, "utf8").toString("base64");
  }
  return input;
}

function postKey(it: { id?: string; url?: string; title?: string }) {
  const base = `${it.url || ""}|${it.id || ""}|${it.title || ""}`;
  return `post:${POST_VER}:` + safeBase64(base);
}

async function getPost(env: Env, key: string) {
  try {
    const raw = await env.FEED_CACHE.get(key, "json");
    return raw as Post | null;
  } catch (error) {
    console.error("getPost failed", { key, error });
    return null;
  }
}

async function putPost(env: Env, key: string, post: Post) {
  try {
    await env.FEED_CACHE.put(key, JSON.stringify(post), {
      expirationTtl: SUM_TTL_SECONDS,
    });
  } catch (error) {
    console.error("putPost failed", { key, error });
  }
}

// ---------------------------------------------------------------------------
// Tagging & Scoring
// ---------------------------------------------------------------------------
const TAG_KEYWORDS: Record<string, RegExp[]> = {
  IA: [/(\bAI\b|\bIA\b|artificial intelligence|machine learning|\bLLM\b|GPT|Anthropic|DeepMind)/i],
  Crypto: [/\bbitcoin\b|\bethereum\b|\bBTC\b|\bETH\b|blockchain|on.?chain/i],
  Macro: [
    /\binflation\b/i,
    /\binterest rates?\b/i,
    /central bank/i,
    /\bECB\b|\bFed\b/i,
    /récession|recession/i,
    /\bGDP\b|\bPIB\b/i,
    /\bgrowth\b|croissance/i,
  ],
  Tech: [/startup|software|hardware|semiconductor|nvidia|apple|google|microsoft|security|vulnerability/i],
  Philo: [/ethic|épistémologie|philos|existential|rational/i],
};

const SOURCE_WEIGHT: Record<string, number> = {
  Reuters: 1.2,
  "BBC News": 1.1,
  "AP Top": 1.05,
  "OpenAI Blog": 1.15,
  Anthropic: 1.1,
  "Google DeepMind": 1.1,
  "Hacker News": 1.0,
  TechCrunch: 1.0,
  "The Verge": 1.0,
  LessWrong: 1.0,
  Aeon: 1.0,
};

function autoTags(it: Item): string[] {
  const hay = `${it.title}
${it.summary}
${it.source}`.toLowerCase();
  const out: string[] = [];
  for (const [tag, regs] of Object.entries(TAG_KEYWORDS)) {
    if (regs.some((r) => r.test(hay))) out.push(tag);
  }
  if (it.topic && !out.includes(it.topic)) out.push(it.topic);
  return Array.from(new Set(out)).slice(0, 6);
}

function priorityScore(it: Item): number {
  const parsedDate = new Date(it.date);
  const isValidDate = !Number.isNaN(parsedDate.valueOf());
  const hours = Math.max(0, (Date.now() - (isValidDate ? parsedDate.getTime() : Date.now())) / 36e5);
  const recency = Math.max(0, Math.min(1, 1 - hours / 24));
  const hot = /breakthrough|exclusive|leak|security|vulnerability|ban|merger|acquisition|earnings/i.test(
    `${it.title} ${it.summary}`,
  )
    ? 0.2
    : 0;
  const src = SOURCE_WEIGHT[it.source] ?? 1.0;
  const iaBonus = (it.tags || []).includes("IA") ? 0.1 : 0;
  return +((0.6 * recency + hot + iaBonus) * src).toFixed(3);
}

// ---------------------------------------------------------------------------
// Feed normalisation
// ---------------------------------------------------------------------------
function normalizeItem(feedMeta: FeedConfig, raw: any): Item {
  const title = String(raw?.title ?? "").trim();
  const url = resolveLink(raw);
  const pub = raw?.pubDate || raw?.published || raw?.updated || raw?.["dc:date"];
  const date = ensureDate(pub);
  const guidRaw = raw?.guid?.["#text"] ?? raw?.guid ?? "";
  const guid = typeof guidRaw === "string" ? guidRaw.trim() : String(guidRaw).trim();

  const id = guid || url || `${title}|${date}`;
  const description =
    stripHtml(raw?.description, 1400) || stripHtml(raw?.content, 1400) || stripHtml(raw?.summary, 1400) || "";

  const base: Item = {
    id,
    title,
    url,
    date,
    topic: feedMeta.topic,
    source: feedMeta.source,
    summary: description,
    tags: [],
  };
  base.tags = autoTags(base);
  base.priorityScore = priorityScore(base);
  return base;
}

function ensureDate(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Feed fetching & caching
// ---------------------------------------------------------------------------
async function fetchFeed(env: Env, feedMeta: FeedConfig): Promise<Item[]> {
  const etagKey = `etag:${feedMeta.url}`;
  const itemsKey = `items:${feedMeta.url}`;
  const cachedEtag = await env.FEED_CACHE.get(etagKey);

  try {
    const res = await fetch(feedMeta.url, {
      headers: cachedEtag ? { "If-None-Match": cachedEtag } : {},
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    if (res.status === 304) {
      const cached = await env.FEED_CACHE.get(itemsKey, "json");
      if (Array.isArray(cached)) return cached as Item[];
      return [];
    }

    if (!res.ok) {
      console.warn("feed fetch failed", { url: feedMeta.url, status: res.status });
      return (await readCachedItems(env, itemsKey)) ?? [];
    }

    const text = await res.text();
    const newEtag = res.headers.get("ETag");
    if (newEtag) await env.FEED_CACHE.put(etagKey, newEtag, { expirationTtl: CACHE_TTL_SECONDS });

    const xml = parser.parse(text);
    let items: any[] = [];
    if (xml?.rss?.channel?.item) items = xml.rss.channel.item;
    else if (xml?.feed?.entry) items = xml.feed.entry;
    else if (xml?.channel?.item) items = xml.channel.item;

    const normalized = ensureArray(items)
      .slice(0, MAX_ITEMS_PER_FEED)
      .map((it) => normalizeItem(feedMeta, it))
      .filter((it) => Boolean(it.title));

    await env.FEED_CACHE.put(itemsKey, JSON.stringify(normalized), {
      expirationTtl: CACHE_TTL_SECONDS,
    });

    return normalized;
  } catch (error) {
    console.error("fetchFeed error", { url: feedMeta.url, error });
    return (await readCachedItems(env, itemsKey)) ?? [];
  }
}

async function readCachedItems(env: Env, key: string): Promise<Item[] | null> {
  try {
    const cached = await env.FEED_CACHE.get(key, "json");
    return Array.isArray(cached) ? (cached as Item[]) : null;
  } catch (error) {
    console.error("readCachedItems failed", { key, error });
    return null;
  }
}

function ensureArray<T>(maybeArray: T | T[] | undefined): T[] {
  if (Array.isArray(maybeArray)) return maybeArray;
  if (maybeArray == null) return [];
  return [maybeArray];
}

// ---------------------------------------------------------------------------
// Post generation
// ---------------------------------------------------------------------------
async function generateArticle(env: Env, it: Item): Promise<Post> {
  if (!env.OPENAI_API_KEY) {
    const html = `<article><h1>${escapeHtml(it.title)}</h1><p>${escapeHtml(it.summary)}</p>${footer(it)}</article>`;
    return { html, meta: baseMeta(it) };
  }

  const prompt = [
    "Écris un article clair, concis et structuré en français (350–700 mots) à partir de ces éléments.",
    "Public: génération X, ton direct (woke-free), pas de flafla.",
    "Structure:",
    "- Un titre percutant (H1).",
    "- 2 à 4 intertitres (H2/H3) avec paragraphes courts.",
    "- 1 encadré \"À retenir\" (liste à puces).",
    "Contraintes: factuel, pas d’affirmations non sourcées, pas de jargon gratuit.",
    "Termine par un pied d’article avec la source fournie (lien).",
    "",
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

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI ${response.status} ${errorText}`);
  }

  const json = await response.json();
  const body = (json.choices?.[0]?.message?.content || "").trim();
  const html = ensureHtml(body, it);
  return { html, meta: baseMeta(it) };
}

async function ensurePosts(env: Env, items: Item[], limit = 6): Promise<Post[]> {
  const out: Post[] = [];
  let created = 0;

  for (const it of items) {
    const key = postKey(it);
    const cached = await getPost(env, key);
    if (cached) {
      out.push(cached);
      continue;
    }

    if (created >= limit) continue;

    try {
      const post = await generateArticle(env, it);
      await putPost(env, key, post);
      out.push(post);
      created += 1;
    } catch (error) {
      console.error("generateArticle failed", { title: it.title, error });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------
async function listPosts(env: Env): Promise<Response> {
  const feedResults = await Promise.all(FEEDS.map((f) => fetchFeed(env, f)));
  const items = dedupeById(feedResults.flat())
    .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
    .slice(0, GLOBAL_LIMIT);

  const posts = await ensurePosts(env, items, 6);
  const list = posts.map((p) => ({
    ...p.meta,
    excerpt: `${p.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220)}…`,
  }));

  return json(list, 200, env);
}

async function getPostBySlug(slug: string, env: Env): Promise<Response> {
  if (!slug) return json({ error: "missing slug" }, 400, env);

  const feedResults = await Promise.all(FEEDS.map((f) => fetchFeed(env, f)));
  const all = feedResults.flat();
  const hit = all.find((x) => {
    const candidateSlug = slugify(x.title);
    const idMatch = x.id === slug;
    const slugMatch = candidateSlug === slug;
    const urlMatch = typeof x.url === "string" && x.url.endsWith(slug);
    return slugMatch || idMatch || urlMatch;
  });

  if (!hit) return json({ error: "not found" }, 404, env);

  const key = postKey(hit);
  const post = await getPost(env, key);
  if (!post) {
    try {
      const fresh = await generateArticle(env, hit);
      await putPost(env, key, fresh);
      const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
      applyCors(headers, env.CORS_ORIGIN);
      return new Response(fresh.html, { status: 200, headers });
    } catch (error) {
      console.error("on-demand post generation failed", { slug, error });
      return json({ error: "post generation failed" }, 500, env);
    }
  }

  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
  applyCors(headers, env.CORS_ORIGIN);
  return new Response(post.html, { status: 200, headers });
}

function dedupeById(items: Item[]): Item[] {
  const uniq = new Map<string, Item>();
  for (const it of items) {
    const key = it.url || it.id;
    if (!key) continue;
    const existing = uniq.get(key);
    if (!existing || (it.priorityScore ?? 0) > (existing.priorityScore ?? 0)) {
      uniq.set(key, it);
    }
  }
  return Array.from(uniq.values());
}

const routes: Record<string, RouteHandler> = {
  "/posts": (_req, env) => listPosts(env),
};

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------
export default {
  async scheduled(_evt: ScheduledEvent, env: Env) {
    try {
      const feedResults = await Promise.allSettled(FEEDS.map((f) => fetchFeed(env, f)));
      const items = feedResults
        .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      await ensurePosts(env, items, 4);
    } catch (error) {
      console.error("cron error", error);
    }
  },

  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

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

    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405, env);
    }

    const routeHandler = routes[url.pathname];
    if (routeHandler) return routeHandler(request, env);

    if (url.pathname.startsWith("/post/")) {
      const slug = url.pathname.slice("/post/".length);
      return getPostBySlug(slug, env);
    }

    if (url.pathname === "/") return new Response("LarryFeed v2.0 OK", { status: 200 });

    return new Response("Not found", { status: 404 });
  },
};
