# CCTSystemAPI

CCTSystem 的 Cloudflare Worker 后端，提供官网 API、Session、限流和 Durable Object WebSocket 桥接。

## 本地验证

```bash
npm install
npm run build
```

复制 `.dev.vars.example` 为 `.dev.vars` 后填写本地密钥。生产密钥使用 `wrangler secret put` 配置，不得写入 `wrangler.jsonc` 或提交到仓库。
