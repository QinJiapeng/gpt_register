# Python Patchright 版

这个目录是当前项目的 Python + patchright 迁移版，参考了 `OutlookRegister` 的浏览器启动方式，但保留本项目原来的注册阶段：

1. Phase 1：手机号注册 ChatGPT。
2. Phase 1.5：首次登录并补全 about-you。
3. Phase 2：OpenAI OAuth 中绑定邮箱。
4. Phase 3：邮箱登录 OAuth 并保存 Codex token。

## 安装

```bash
pip install -r requirements-patchright.txt
patchright install chromium
```

## 运行

完整流程：

```bash
python -m py_register.main 1
```

只跑邮箱绑定：

```bash
python -m py_register.main --phase2
```

只补 token：

```bash
python -m py_register.main --phase3
```

停在 Phase 2：

```bash
python -m py_register.main 1 --stop-after-phase2
```

## 配置

Python 版复用现有 `config.json`，也支持：

```bash
set CONFIG_PROFILE=server
python -m py_register.main 1
```

或：

```bash
set CONFIG_FILE=config.server.json
python -m py_register.main 1
```

## 当前差异

- 浏览器层已改为 patchright，有头 Chromium，支持代理和持久化 profile。
- 短信支持 HeroSMS 和 SMSBower。
- 邮箱支持 `cloud-mail`、`cloudflare-worker`、`legacy`。
- Outlook 号池目前支持 claim 和状态标记，但 Python 版暂未实现 IMAP XOAUTH2 收 OpenAI 验证码；如果你当前依赖 Outlook 号池收信，先继续用 Node 版，或下一步补 Python IMAP 收信模块。
- `--phase8` 批量补 token 尚未迁移。
