import { XMLParser } from "fast-xml-parser";

const FEEDS = [
  { url: "https://bitcoinmagazine.com/.rss", topic: "Crypto", source: "Bitcoin Magazine" },
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml", topic: "Crypto", source: "CoinDesk" },
  { url: "https://www.reuters.com/finance/rss", topic: "Macro", source: "Reuters" },
  { url: "https://www.lesswrong.com/feed.xml", topic: "IA/Philo", source: "LessWrong" }
];

const MAX_ITEMS_PER_FEED = 25;
const GLOBAL_LIMIT = 100;
const CACHE_TTL_SECONDS = 60 * 30;

type Env = {
  FEED_CACHE: KVNamespace;
  OPENAI_API_KEY?: string;
  CORS_ORIGIN?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function normalizeItem(feedMeta: any, raw: any) {
  const title = raw.title?.toString()?.trim() ?? "";
  const link = raw.link?.toString()?.trim() ?? raw["atom:link"]?.["@_href"] ?? "";
  const pub = raw.pubDate || raw.published || raw.updated || raw["dc:date"];
  const date = pub ? new Date(pub).toISOString() : new Date().toISOString();
  const guid = (raw.guid?.toString() || link || title + date).trim();
  const description =
    raw.description?.toString()?.replace(/<[^>]+>/g, "").slice(0, 1000) ??
    raw.content?.toString()?.replace(/<[^>]+>/g, "").slice(0, 1000) ??
    "";

  return {
    id: guid,
    title,
    url: link,
    date,
    topic: feedMeta.topic,
    source: feedMeta.source,
    summary: description,
    tags: [],
  };
}

async function fetchFeed(env: Env, feedMeta: any) {
  const cacheKey = `etag:${feedMeta.url}`;
  const etag = await env.FEED_CACHE.get(cacheKey);

  const res = await fetch(feedMeta.url, {
    headers: etag ? { "If-None-Match": etag } : {},
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (res.status === 304) {
    const cached = await env.FEED_CACHE.get(`items:${feedMeta.url}`, "json");
    return cached ?? [];
  }

  const text = await res.text();
  const newEtag = res.headers.get("ETag");
  if (newEtag) await env.FEED_CACHE.put(cacheKey, newEtag, { expirationTtl: CACHE_TTL_SECONDS });

  const xml = parser.parse(text);

  let items: any[] = [];
  if (xml?.rss?.channel?.item) items = xml.rss.channel.item;
  else if (xml?.feed?.entry) items = xml.feed.entry;
  else if (xml?.channel?.item) items = xml.channel.item;
  else items = [];

  const normalized = (Array.isArray(items) ? items : [items])
    .slice(0, MAX_ITEMS_PER_FEED)
    .map((it) => normalizeItem(feedMeta, it));

  await env.FEED_CACHE.put(`items:${feedMeta.url}`, JSON.stringify(normalized), {
    expirationTtl: CACHE_TTL_SECONDS,
  });

  return normalized;
}

async function summarizeIfEnabled(env: Env, text: string) {
  if (!env.OPENAI_API_KEY) return null;
  const prompt = `Résumé en 2 phrases, franc et factuel (<=280 caractères). Si un red flag est évident, mentionne-le.\n---\n${text}\n---`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Assistant de résumé d’actualités, précis et concis." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 140
    })
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() ?? null;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await Promise.allSettled(FEEDS.map((f) => fetchFeed(env, f)));
  },

  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/news") {
      const all = (await Promise.all(FEEDS.map((f) => fetchFeed(env, f)))).flat();

      let enriched = all;
      if (url.searchParams.get("summarize") === "true" && env.OPENAI_API_KEY) {
        enriched = await Promise.all(
          all.map(async (it) => {
            const cacheKey = `sum:${it.id}`;
            const cached = await env.FEED_CACHE.get(cacheKey);
            if (cached) return { ...it, ai_summary: cached };

            const ai = await summarizeIfEnabled(env, `${it.title}\n${it.summary}`);
            if (ai) await env.FEED_CACHE.put(cacheKey, ai, { expirationTtl: 60 * 60 * 12 });
            return { ...it, ai_summary: ai };
          })
        );
      }

      enriched.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const limited = enriched.slice(0, 100);

      return json(limited, 200, env);
    }

    if (url.pathname === "/") {
      return new Response("RSS Worker ok", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};

function json(data: unknown, status = 200, env: Env) {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "max-age=60, stale-while-revalidate=120",
  };
  if (env.CORS_ORIGIN) {
    headers["access-control-allow-origin"] = env.CORS_ORIGIN;
    headers["access-control-allow-headers"] = "content-type, authorization";
  }
  return new Response(JSON.stringify(data), { status, headers });
}
