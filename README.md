# RSS Worker (Cloudflare Workers + KV + Cron)

## Déploiement rapide
1. Installer Wrangler : `npm i -g wrangler`
2. `npm install`
3. Créer le KV : `wrangler kv:namespace create FEED_CACHE` → remplace l'id dans `wrangler.toml`
4. (Optionnel) Résumés IA : `wrangler secret put OPENAI_API_KEY`
5. `npm run deploy`

## Utilisation
- API : `/news` (ajoute `?summarize=true` pour IA s'il y a une clé)
- Cron : toutes les 15 min (configurable dans `wrangler.toml`)
- CORS : règle `CORS_ORIGIN` dans `wrangler.toml`

## Domaine perso
- Ajoute une route dans `wrangler.toml` + entrée DNS → ex. `api.larry.ovh`
