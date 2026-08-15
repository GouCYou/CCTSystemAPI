# CCTSystemAPI

CCTSystem 的 Cloudflare Worker 后端，提供官网 API、Session、限流和 Durable Object WebSocket 桥接。

## 本地验证

```bash
npm install
npm run build
```

复制 `.dev.vars.example` 为 `.dev.vars` 后填写本地密钥。生产密钥使用 `wrangler secret put` 配置，不得写入 `wrangler.jsonc` 或提交到仓库。

## 首次部署

在 `.dev.vars.production` 中只填写 `NODE_KEYS_JSON` 和 `AUTH_RATE_LIMIT_SALT`，然后执行：

```bash
npm ci
npm run build
npx wrangler login
npx wrangler deploy --secrets-file .dev.vars.production
```

该文件已被 Git 忽略。Worker 使用 `api.cctstudio.cn` Custom Domain，Wrangler 会在首次部署时创建对应的 DNS 与证书。
