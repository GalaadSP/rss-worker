// v1.1 — LarryFeed Worker
// - ID unique robuste par item (guid | link | title|date)
// - Clé de cache résumé IA versionnée (v2) + base64(url|id|title)
// - Parsing des liens RSS/Atom fiable
// - Prompt IA inclut titre + URL + extrait
// - Logs verbeux + erreurs OpenAI visibles
// - ETag + TTL KV pour limiter le spam
// - CORS contrôlé via env.CORS_ORIGIN

import { XMLParser } from "fast-xml-parser";

// --------- CONFIG FEEDS ----------
const FEEDS = [
  { url: "https://bitcoinmagazine.com/.rss", topic: "Crypto", source: "Bitcoin Magazine" },
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml", topic: "Crypto", source: "CoinDesk" },
  { url: "https://www.reuters.com/finance/rss", topic: "Macro", source: "Reuters" },
  { url: "https://www.lesswrong.com/feed.xml", topic: "IA/Philo", source: "LessWrong" },
];

const MAX_ITEMS_PER_FEED = 25;
const GLOBAL_LIMIT = 100;
const CACHE_TTL_SECONDS = 60 * 30; // 30 min
const SUM_TTL_SECONDS = 60 * 60 * 12; // 12 h

// --------- TYPES ----------
type Env = {
  FEED_CACHE: KVNamespace;
  OPENAI_API_KEY?: string;
  CORS_ORIGIN?: string;
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
  ai_summary?: string | null;
};

// --------- XML PARSER ----------
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

// --------- HELPERS ----------
function resolveLink(raw: any): string {
  // RSS 2.0: link string
  if (typeof raw?.link === "string") return raw.link.trim();

  // RSS 2.0 (parfois link objet/array)
  if (Array.isArray(raw?.link)) {
    const alt = raw.link.find((l: any) => l?.["@_rel"] === "alternate" && l?.["@_href"]);
    if (alt?.["@_href"]) return String(alt["@_href"]).trim();
    const first = raw.link.find((l: any) => l?.["@_href"]);
    if (first?.["@_href"]) return String(first["@_href"]).trim();
  }

  if (raw?.link?.["@_href"]) return String(raw.link["@_href"]).trim();

  // Atom: atom:link
  if (raw?.["atom:link"]?.["@_href"]) return String(raw["atom:link"]["@_href"]).trim();
  if (Array.isArray(raw?.["atom:link"])) {
    const alt = raw["atom:link"].find((l: any) => l?.["@_rel"] === "alternate" && l?.["@_href"]);
    if (alt?.["@_href"]) return String(alt["@_href"]).trim();
    const first = raw["atom:link"].find((l: any) => l?.["@_href"]);
    if (first?.["@_href"]) return String(first["@_href"]).trim();
  }

  // parfois content.url
  if (raw?.content?.["@_src"]) return String(raw.content["@_src"]).trim();

  return "";
}

function stripHtml(s: string | undefined | null, limit = 1000): string {
  if (!s) return "";
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, limit);
}

// Versionne la clé pour purger l'ancien cache si besoin (bump -> "v3" un jour)
const CACHE_VER = "v2";
function safeCacheKeyForSummary(it: Partial<Item>): string {
  const base = `${it.url || ""}|${it.id || ""}|${it.title || ""}`;
  try {
    // @ts-ignore btoa existe dans Workers
    return `sum:${CACHE_VER}:` + btoa(base);
  } catch {
    return `sum:${CACHE_VER}:` + base;
  }
}

function json(data: unknown, status = 200, env?: Env) {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "max-age=60, stale-while-revalidate=120",
  };
  if (env?.CORS_ORIGIN) {
    headers["access-control-allow-origin"] = env.CORS_ORIGIN;
    headers["access-control-allow-headers"] = "content-type, authorization";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

// --------- NORMALISATION ----------
function normalizeItem(feedMeta: any, raw: any): Item {
  const title = String(raw?.title ?? "").trim();
  const url = resolveLink(raw);
  const pub = raw?.pubDate || raw?.published || raw?.updated || raw?.["dc:date"];
  const date = pub ? new Date(pub).toISOString() : new Date().toISOString();

  // guid peut être texte ou objet {#text}
  const guidRaw = raw?.guid?.["#text"] ?? raw?.guid ?? "";
  const guidStr = typeof guidRaw === "string" ? guidRaw : String(guidRaw);

  const id = (guidStr && guidStr.trim().length > 0)
    ? guidStr.trim()
    : (url && url.length > 0)
      ? url
      : (title + "|" + date);

  const description =
    stripHtml(raw?.description, 1400) ||
    stripHtml(raw?.content, 1400) ||
    stripHtml(raw?.summary, 1400) ||
    "";

  return {
    id,
    title,
    url,
    date,
    topic: feedMeta.topic,
    source: feedMeta.source,
    summary: description,
    tags: [],
  };
}

// --------- FETCH & CACHE FEED ----------
async function fetchFeed(env: Env, feedMeta: any): Promise<Item[]> {
  // ETag pour économiser le réseau
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
  else if (xml?.feed?.entry) items = xml.feed.entry;
  else if (xml?.channel?.item) items = xml.channel.item;

  const normalized = (Array.isArray(items) ? items : [items])
    .slice(0, MAX_ITEMS_PER_FEED)
    .map((it) => normalizeItem(feedMeta, it));

  await env.FEED_CACHE.put(`items:${feedMeta.url}`, JSON.stringify(normalized), {
    expirationTtl: CACHE_TTL_SECONDS,
  });

  return normalized;
}

// --------- OPENAI SUMMARY ----------
async function summarizeIfEnabled(env: Env, text: string) {
  try {
    if (!env.OPENAI_API_KEY) return null;
    const clean = (text || "").trim();
    if (clean.length < 40) return "Texte trop court pour un résumé pertinent.";

    const payload = {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Assistant concis. Résume en 2–3 phrases, franc et factuel. Pas de fluff.",
        },
        { role: "user", content: clean.slice(0, 3000) },
      ],
      temperature: 0.4,
      max_tokens: 160,
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const body = await r.text();
      console.error("OpenAI error", r.status, body);
      return null;
    }
    const j = await r.json();
    const out = j?.choices?.[0]?.message?.content?.trim();
    return out || null;
  } catch (e) {
    console.error("summarizeIfEnabled() failed", e);
    return null;
  }
}

// --------- SCHEDULED (CRON) ----------
export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    try {
      await Promise.allSettled(FEEDS.map((f) => fetchFeed(env, f)));
      // (optionnel) ici on pourrait nettoyer des clés anciennes préfixées sum:v1:
    } catch (e) {
      console.error("cron error", e);
    }
  },

  // --------- HTTP HANDLER ----------
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/news") {
      // 1) Récupérer tous les feeds (avec cache)
      const all = (await Promise.all(FEEDS.map((f) => fetchFeed(env, f)))).flat();

      // 2) (optionnel) dédup simple via map sur l'URL (si absente: id)
      const uniqMap = new Map<string, Item>();
      for (const it of all) {
        const key = it.url || it.id;
        if (!uniqMap.has(key)) uniqMap.set(key, it);
      }
      let items = Array.from(uniqMap.values());

      // 3) Résumés IA (si demandé & clé dispo)
      if (url.searchParams.get("summarize") === "true" && env.OPENAI_API_KEY) {
        items = await Promise.all(
          items.map(async (it) => {
            try {
              const cacheKey = safeCacheKeyForSummary(it);
              const cached = await env.FEED_CACHE.get(cacheKey);
              if (cached) return { ...it, ai_summary: cached };

              // IMPORTANT: inclure URL pour unicité sémantique
              const ai = await summarizeIfEnabled(env, `${it.title}\n${it.url}\n${it.summary || ""}`);
              if (ai) await env.FEED_CACHE.put(cacheKey, ai, { expirationTtl: SUM_TTL_SECONDS });
              return { ...it, ai_summary: ai };
            } catch (e) {
              console.error("IA error for:", it.title, e);
              return it;
            }
          })
        );
      }

      // 4) Tri et limite
      items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      items = items.slice(0, GLOBAL_LIMIT);

      return json(items, 200, env);
    }

    if (url.pathname === "/") {
      return new Response("RSS Worker v1.1 ok", { status: 200 });
    }

    // CORS preflight si besoin
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

    return new Response("Not found", { status: 404 });
  },
};
