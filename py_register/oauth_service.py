import base64
import hashlib
import json
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs

import requests

from .config import ROOT_DIR


class OAuthService:
    def __init__(self, config: dict):
        self.config = config
        self.client_id = config.get("oauthClientId") or "app_EMoamEEZ73f0CkXaXp7hrann"
        self.redirect_port = int(config.get("oauthRedirectPort") or 1455)
        self.redirect_uri = f"http://localhost:{self.redirect_port}/auth/callback"
        self.code_verifier = ""
        self.code_challenge = ""
        self.state = ""
        self.regenerate_pkce()

    @staticmethod
    def _b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")

    def regenerate_pkce(self):
        self.code_verifier = self._b64url(secrets.token_bytes(32))
        self.code_challenge = self._b64url(hashlib.sha256(self.code_verifier.encode()).digest())
        self.state = secrets.token_hex(16)
        print("[OAuth] 已重新生成 PKCE 参数和 state")

    def get_auth_url(self) -> str:
        params = {
            "client_id": self.client_id,
            "code_challenge": self.code_challenge,
            "code_challenge_method": "S256",
            "codex_cli_simplified_flow": "true",
            "id_token_add_organizations": "true",
            "prompt": "login",
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "scope": "openid email profile offline_access",
            "state": self.state,
        }
        return f"https://auth.openai.com/oauth/authorize?{urlencode(params)}"

    def extract_callback_params(self, callback_url: str):
        parsed = urlparse(callback_url)
        qs = parse_qs(parsed.query)
        state = (qs.get("state") or [""])[0]
        if state and state != self.state:
            raise RuntimeError(f"OAuth state 不匹配: got={state}, expected={self.state}")
        return {
            "code": (qs.get("code") or [""])[0],
            "error": (qs.get("error") or [""])[0],
            "error_description": (qs.get("error_description") or [""])[0],
        }

    def _proxies(self):
        host = self.config.get("proxyHost")
        port = self.config.get("proxyPort")
        if not host or not port:
            return None
        username = self.config.get("proxyUsername") or ""
        password = self.config.get("proxyPassword") or ""
        auth = f"{username}:{password}@" if username or password else ""
        url = f"http://{auth}{host}:{port}"
        return {"http": url, "https": url}

    @staticmethod
    def _decode_account_id(access_token: str) -> str:
        try:
            payload = access_token.split(".")[1]
            payload += "=" * (-len(payload) % 4)
            data = json.loads(base64.urlsafe_b64decode(payload))
            return (data.get("https://api.openai.com/auth") or {}).get("chatgpt_account_id") or ""
        except Exception:
            return ""

    def exchange_token_and_save(self, code: str, email: str):
        body = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.redirect_uri,
            "client_id": self.client_id,
            "code_verifier": self.code_verifier,
        }
        response = None
        for attempt in range(1, 6):
            try:
                response = requests.post(
                    "https://auth.openai.com/oauth/token",
                    data=body,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    proxies=self._proxies(),
                    timeout=30,
                )
                response.raise_for_status()
                break
            except Exception as exc:
                if attempt == 5:
                    raise
                print(f"[OAuth] 换 Token 第 {attempt} 次失败: {exc}，稍后重试...")
                time.sleep(attempt * 3)
        tokens = response.json()
        now = datetime.now(timezone(timedelta(hours=8)))
        expired = now + timedelta(seconds=int(tokens.get("expires_in", 0)))
        out = {
            "access_token": tokens.get("access_token", ""),
            "account_id": self._decode_account_id(tokens.get("access_token", "")),
            "disabled": False,
            "email": email,
            "expired": expired.isoformat(timespec="seconds"),
            "id_token": tokens.get("id_token", ""),
            "last_refresh": now.isoformat(timespec="seconds"),
            "refresh_token": tokens.get("refresh_token", ""),
            "type": "codex",
        }
        dirs = self.config.get("tokenOutputDirs") or [self.config.get("tokenOutputDir") or str(ROOT_DIR / "tokens")]
        saved = []
        safe_email = "".join("_" if ch in '\\/:*?"<>|' else ch for ch in email or "unknown")
        for item in dict.fromkeys(dirs):
            p = Path(item)
            if not p.is_absolute():
                p = ROOT_DIR / p
            p.mkdir(parents=True, exist_ok=True)
            target = p / f"codex-{safe_email}-free.json"
            target.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
            saved.append(str(target))
        print(f"[OAuth] Token 成功保存至: {' | '.join(saved)}")
        return {**out, "savedPaths": saved}
