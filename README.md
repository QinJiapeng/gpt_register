# codex-remote-registrar

本项目是一个基于本地浏览器的注册流程自动化脚本，用于串联手机号接码、临时邮箱、OpenAI OAuth 授权和 token 文件保存等步骤。

> 详细的逐步部署和运行说明见 [使用说明.md](./使用说明.md)。

## Features

- 使用 `puppeteer-real-browser` 启动本地浏览器自动化流程
- 使用 HeroSMS 或 SMSBower 获取手机号、轮询短信验证码并结束激活
- 支持按国家价格排序选择手机号国家
- 支持 `cloud-mail`、`legacy`、`cloudflare-worker` 和 Outlook 号池邮箱接口
- 支持 Cloudflare Email Routing + Worker + D1 作为临时邮箱后端
- 支持完整流程、分阶段恢复、只补 token、批量补 token
- 支持代理、浏览器持久化 profile、运行时清理 ChatGPT 登录状态
- 支持把 token 输出到一个或多个目录

## Requirements

- Node.js 18 或更高版本
- 可用的 HeroSMS 或 SMSBower API Key
- 可用的临时邮箱服务
- 可启动图形浏览器的运行环境

Linux 环境不要使用 `xvfb-run` 启动，本项目会主动检测并退出。

## Installation

```bash
npm install
```

首次使用建议从示例配置复制一份本地配置：

```bash
cp config.example.json config.json
```

`config.json` 必须是严格 JSON，不能写 `//` 注释。

## Configuration

项目会读取基础配置和环境覆盖配置：

| 文件 | 说明 |
| --- | --- |
| `config.json` | 基础配置 |
| `config.local.json` | macOS 默认覆盖配置 |
| `config.server.json` | Linux 默认覆盖配置 |
| `config.example.json` | 示例配置，不应填真实密钥 |

也可以手动指定配置：

```bash
CONFIG_PROFILE=server node index.js 1
CONFIG_PROFILE=local node index.js 1
CONFIG_FILE=./config.server.json node index.js 1
```

最小配置示例：

```json
{
  "smsProvider": "herosms",
  "heroSmsApiKey": "YOUR_HEROSMS_API_KEY",
  "heroSmsService": "dr",
  "heroSmsCountry": 46,
  "heroSmsPromptCountrySelection": true,
  "heroSmsCountryTopN": 10,
  "phoneCountryCode": "SE",
  "mailProvider": "cloudflare-worker",
  "mailBaseUrl": "https://your-worker.your-subdomain.workers.dev",
  "mailAdminToken": "YOUR_MAIL_API_TOKEN",
  "mailDomain": "your-domain.example.com",
  "mailDomains": ["your-domain.example.com"],
  "tokenOutputDirs": ["tokens"],
  "browserUserDataDir": "browser-profile",
  "browserIncognito": false,
  "browserClearChatGptSession": true
}
```

常用字段：

| 字段 | 说明 |
| --- | --- |
| `smsProvider` | 短信平台：`herosms` 或 `smsbower`，默认 `herosms` |
| `heroSmsApiKey` | HeroSMS API Key |
| `heroSmsService` | HeroSMS 服务代码，默认 `dr` |
| `heroSmsCountry` | HeroSMS 国家 ID，作为默认或兜底国家 |
| `heroSmsPromptCountrySelection` | 启动时是否交互选择低价国家 |
| `heroSmsCountryTopN` | 展示低价国家数量 |
| `smsBowerApiKey` | SMSBower API Key |
| `smsBowerService` | SMSBower 服务代码，默认 `dr` |
| `smsBowerCountry` | SMSBower 国家 ID，作为默认或兜底国家 |
| `smsBowerPromptCountrySelection` | 使用 SMSBower 时是否交互选择低价国家 |
| `smsBowerCountryTopN` | 使用 SMSBower 时展示低价国家数量 |
| `smsBowerMaxPrice` | 使用 SMSBower 时的最高接码价格；`0` 或不填表示不限制 |
| `smsBowerBaseUrl` | SMSBower API 地址，默认 `https://smsbower.page/stubs/handler_api.php` |
| `phoneCountryCode` | 手机国家 ISO 代码，例如 `SE`、`US`、`GB` |
| `phoneCountries` | 自定义国家清单，不填时使用内置清单 |
| `mailProvider` | 邮箱接口类型：`cloud-mail`、`legacy`、`cloudflare-worker`、`outlook`、`auto` |
| `mailBaseUrl` | 邮箱服务根地址 |
| `mailAdminEmail` | `cloud-mail` 管理员邮箱 |
| `mailAdminPassword` | `cloud-mail` 管理员密码或旧接口 admin key |
| `mailAdminToken` | 邮箱接口 token；配置后优先使用 |
| `mailDomain` | 默认邮箱域名 |
| `mailDomains` | 邮箱域名池 |
| `outlookPoolFile` | Outlook 号池文本文件，每行 `email----password----client_id----refresh_token` |
| `outlookPoolStateFile` | Outlook 号池状态文件，记录 `available/in_use/done/failed` |
| `outlookAccounts` | 可选，直接在配置里写 Outlook 四段号数组；适合少量测试 |
| `proxyHost` / `proxyPort` | 浏览器和 OAuth 请求代理 |
| `proxyUsername` / `proxyPassword` | 代理认证信息 |
| `tokenOutputDir` | 单个 token 输出目录 |
| `tokenOutputDirs` | 多个 token 输出目录，优先级高于 `tokenOutputDir` |
| `browserUserDataDir` | 浏览器持久化 profile 目录 |
| `browserIncognito` | 是否使用无痕上下文 |
| `browserClearChatGptSession` | 启动时是否清理 ChatGPT 登录状态 |

代理也可以通过 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY` 环境变量提供。

使用 Outlook 号池时，邮箱配置可以这样写：

```json
{
  "mailProvider": "outlook",
  "outlookPoolFile": "outlook_pool.txt",
  "outlookPoolStateFile": "outlook_pool_state.json"
}
```

`outlook_pool.txt` 每行一个接码号，格式与 `gpt-outlook-register` 一致：

```text
email----password----client_id----microsoft_refresh_token
```

Outlook 模式不需要 `mailBaseUrl`、`mailDomain`、`mailAdminToken`。脚本会从号池 claim 一个 `available` 邮箱，使用 Microsoft refresh_token 换 IMAP access_token，通过 XOAUTH2 扫描 `INBOX/Junk/Junk Email/Spam` 收 OpenAI 验证码。邮箱绑定成功后状态会写成 `done`；绑定前失败会写成 `failed`。`--phase3` / `--phase8` 会按 `username.json` 里的 email 从状态文件找回同一个 Outlook 凭证取码。

使用 SMSBower 时，短信平台配置可以这样写：

```json
{
  "smsProvider": "smsbower",
  "smsBowerApiKey": "YOUR_SMSBOWER_API_KEY",
  "smsBowerService": "dr",
  "smsBowerCountry": 73,
  "smsBowerMaxPrice": 0.05,
  "phoneCountryCode": "US"
}
```

## Cloudflare Email Worker

如果使用 Cloudflare Email Routing 作为临时邮箱后端，项目已包含 Worker 和 D1 表结构：

- [cloudflare-email-worker.js](./cloudflare-email-worker.js)
- [cloudflare-email-worker-schema.sql](./cloudflare-email-worker-schema.sql)

部署步骤概览：

1. 在 Cloudflare 创建 Worker。
2. 创建 D1 数据库并执行 `cloudflare-email-worker-schema.sql`。
3. 给 Worker 绑定 D1，绑定名必须是 `DB`。
4. 设置 Worker 环境变量：
   - `MAIL_API_TOKEN`：本项目查询邮件时使用的密钥
   - `MAIL_DOMAIN`：你的收信域名
5. 在 Email Routing 的 catch-all 规则中选择 `Send to Worker`。
6. 在本项目配置 `mailProvider`、`mailBaseUrl`、`mailAdminToken` 和域名。

## Usage

完整流程，产出 1 个 token：

```bash
node index.js 1
```

批量产出多个 token：

```bash
node index.js 5
```

指定国家：

```bash
node index.js 1 --country=SE
```

新注册并停在 Phase 2 收尾：

```bash
node index.js 1 --stop-after-phase2
```

使用已注册账号继续跑邮箱绑定：

```bash
node index.js --phase2
```

只补最后一步 token：

```bash
node index.js --phase3
```

按 `username.json` 批量补 token：

```bash
node index.js --phase8
```

## Remote Agent

本项目支持在本地常驻一个 Agent，由 Agent 主动向远程服务器拉取任务，然后在本机执行现有脚本并回传运行状态。这样不需要把本地电脑暴露到公网，也避免远程命令直接执行 shell。

复制 Agent 配置：

```bash
cp config.agent.example.json config.agent.json
```

编辑 `config.agent.json`：

```json
{
  "baseUrl": "https://your-server.example.com",
  "token": "YOUR_AGENT_API_TOKEN",
  "workerId": "local-pc-1",
  "pollIntervalMs": 10000,
  "authFileUploadUrl": "http://170.106.140.71:8317/v0/management/auth-files",
  "authFileUploadToken": "YOUR_AUTH_FILE_UPLOAD_TOKEN"
}
```

启动本地 Agent：

```bash
npm run agent
```

也可以用环境变量覆盖：

```bash
AGENT_BASE_URL=https://your-server.example.com AGENT_TOKEN=xxx npm run agent
```

Agent 默认调用这些接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/agent/jobs/next` | 拉取下一条任务 |
| `POST` | `/api/agent/jobs/{id}/status` | 上报 `running`、`success`、`failed` |

所有请求会带上：

```http
Authorization: Bearer YOUR_AGENT_API_TOKEN
```

### 任务格式

推荐服务端返回结构化任务：

```json
{
  "id": "job_001",
  "command": "run",
  "mode": "full",
  "count": 5,
  "country": "SE",
  "configProfile": "server"
}
```

等价于本地执行：

```bash
CONFIG_PROFILE=server node index.js 5 --country=SE
```

支持的 `mode`：

| mode | 本地命令 |
| --- | --- |
| `full` | `node index.js <count>` |
| `stop-after-phase2` | `node index.js <count> --stop-after-phase2` |
| `phase2` | `node index.js --phase2` |
| `phase3` | `node index.js --phase3` |
| `phase8` | `node index.js --phase8` |
| `test-sms-country` | `node index.js --test-sms-country` |

也兼容直接返回白名单参数：

```json
{
  "id": "job_002",
  "command": "run",
  "args": ["3", "--country=GB"]
}
```

Agent 只允许这些参数：

```text
<1-100>
--country=XX
--phase2
--phase3
--phase8
--stop-after-phase2
--test-sms-country
```

### 认证文件上传

如果配置了 `authFileUploadUrl`，Agent 会把上传配置传给注册进程。每次 Token JSON 保存成功后，`index.js` 会立即上传本次保存的文件。

```json
{
  "authFileUploadUrl": "http://170.106.140.71:8317/v0/management/auth-files",
  "authFileUploadToken": "YOUR_AUTH_FILE_UPLOAD_TOKEN",
  "authFileUploadField": "file",
  "authFileUploadMaxBytes": 2097152
}
```

如果一个任务一次性注册 5 个账号，成功生成第 1 个 Token JSON 后会立即上传第 1 个，不会等 5 个全部完成。上传失败的文件不会删除或移动。

上传方式是 `multipart/form-data`，默认文件字段名是 `file`，请求头为：

```http
Authorization: Bearer YOUR_AUTH_FILE_UPLOAD_TOKEN
```

同时会带上普通表单字段：

```text
jobId
workerId
path
```

### 状态回报

`/status` 会收到类似：

```json
{
  "workerId": "local-pc-1",
  "status": "success",
  "exitCode": 0,
  "stdoutTail": "...",
  "stderrTail": "..."
}
```

## Workflow

默认完整流程分为四段：

| 阶段 | 说明 |
| --- | --- |
| Phase 1 | 手机号注册并完成短信验证 |
| Phase 1.5 | 首次登录后补全 about-you |
| Phase 2 | 绑定临时邮箱 |
| Phase 3 | 邮箱登录 OAuth，换取并保存 token |

`--stop-after-phase2` 会在 Phase 2 邮箱绑定完成后停止，不进入 Phase 3。

## Output Files

| 路径 | 说明 |
| --- | --- |
| `accounts.json` | 手机号注册账号池 |
| `username.json` | 已绑定邮箱账号池 |
| `tokens/codex-<email>-free.json` | 生成的 token 文件 |
| `shibai.json` | 批量补 token 失败记录 |
| `logs/` | 运行日志 |
| `browser-profile/` | 浏览器持久化 profile，启用时产生 |

这些文件通常包含账号、token、浏览器会话或运行状态，不建议提交到公开仓库。

## Project Structure

```text
.
├── index.js
├── src/
│   ├── browserService.js
│   ├── config.js
│   ├── mailProvider.js
│   ├── smsProvider.js
│   └── tokenExchange.js
├── cloudflare-email-worker.js
├── cloudflare-email-worker-schema.sql
├── config.example.json
├── package.json
└── 使用说明.md
```

## Troubleshooting

### 配置解析失败

检查 `config.json` 是否为严格 JSON。不要写注释、尾逗号或未转义字符。

### 提示缺少 HeroSMS API Key

检查当前实际加载的是哪个配置文件。Linux 默认会叠加 `config.server.json`，macOS 默认会叠加 `config.local.json`。

### 邮箱接口 401 或认证失败

检查 `mailProvider` 是否和实际服务一致，并确认 `mailAdminEmail`、`mailAdminPassword`、`mailAdminToken`、`mailDomain` 配置正确。

### 代理不可用

脚本会在代理连接失败时尝试回退直连。需要固定走代理时，请确认代理主机、端口和认证信息有效。

### `--phase2` 找不到账号

先运行完整注册流程，或确认 `accounts.json` 内存在可恢复记录。

## Security

- 不要把真实 API Key、邮箱密钥、账号文件、token 文件提交到公开仓库。
- 不要把 `browser-profile/` 作为可共享产物，它可能包含登录状态。
- 建议把生产配置放在本地覆盖配置文件中，只把 `config.example.json` 作为公开示例。

## License

ISC
