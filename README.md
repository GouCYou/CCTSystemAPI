# CCTSystemAPI

CCTSystem 的 Cloudflare Worker 后端，提供官网 API、Session、限流和 Durable Object WebSocket 桥接。

## 本地验证

```bash
npm install
npm run build
```

复制 `.dev.vars.example` 为 `.dev.vars` 后填写本地密钥。生产密钥使用 `wrangler secret put` 配置，不得写入 `wrangler.jsonc` 或提交到仓库。

## 首次部署

在 `.dev.vars.production` 中填写 `NODE_KEYS_JSON` 和 `AUTH_RATE_LIMIT_SALT`，然后执行：

```bash
npm ci
npm run build
npx wrangler login
npx wrangler deploy --secrets-file .dev.vars.production
```

该文件已被 Git 忽略。Worker 使用 `api.cctstudio.cn` Custom Domain，Wrangler 会在首次部署时创建对应的 DNS 与证书。

## 支付 FM

开启支付前再配置下面三个生产环境 Secret，不写入 Git：

```dotenv
ZHIFUX_API_BASE=https://支付FM后台显示的接口根地址
ZHIFUX_MERCHANT_NUM=支付FM商户号
ZHIFUX_SECRET=支付FM接入密钥
```

回调地址固定为：

```text
https://api.cctstudio.cn/api/payments/zhifufm/notify
```

确认支付 FM 账号、收款通道和监控端已就绪后，把 `wrangler.jsonc` 中的 `PAYMENT_ENABLED` 改为 `true`。`ZHIFUX_PAY_TYPE` 必须使用商户后台为当前通道提供的值，个人支付宝免签通常为 `aloop`，不要凭名称自行填写。

订单以人民币整元创建，范围为 1–1000 元；固定按 `1 CNY = 20 点券` 入账。回调只在验签、商户号、订单号和原订单金额全部匹配后确认支付，点券发放通过 CCTSystem `points.credit` 并使用订单级幂等 ID。免签通道可能出现实付金额浮动，`actualPayAmount` 仅用于审计，不参与点券计算。
