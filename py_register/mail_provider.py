import json
import random
import re
import string
import time
from pathlib import Path

import requests


def _random_name(length: int = 10) -> str:
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choice(chars) for _ in range(length))


def _random_password(length: int = 14) -> str:
    chars = string.ascii_letters + string.digits + "!@#$"
    return "".join(random.choice(chars) for _ in range(length)) + "A1!"


def mail_to_text(mail: dict) -> str:
    parts = [mail.get(key) for key in ("raw", "text", "content", "subject", "message")]
    return "\n\n".join(str(x) for x in parts if isinstance(x, str) and x.strip())


def extract_verification_code(raw: str) -> str | None:
    if not raw:
        return None
    strong = [
        r"(?:code|验证码|verification(?:\s+code)?|verify|one[-\s]*time\s+code)[^\d]{0,120}(\d{6})",
        r"-->\s*(\d{6})\s*<!--",
        r">\s*(\d{6})\s*<",
    ]
    for pattern in strong:
        match = re.search(pattern, raw, flags=re.I)
        if match:
            return match.group(1)
    for match in re.finditer(r"\d{6}", raw):
        idx = match.start()
        ctx = raw[max(0, idx - 80): idx + 120].lower()
        if "http" in ctx or "href=" in ctx or "color:" in ctx or "font-" in ctx:
            continue
        return match.group(0)
    return None


class OutlookPool:
    def __init__(self, pool_file: str, state_file: str, accounts: list[str] | None = None):
        self.pool_file = Path(pool_file) if pool_file else None
        self.state_file = Path(state_file) if state_file else None
        self.records = {}
        self._load(accounts or [])

    @staticmethod
    def _parse_line(line: str):
        parts = [x.strip() for x in str(line or "").strip().split("----")]
        if len(parts) != 4:
            return None
        email, password, client_id, refresh_token = parts
        if "@" not in email or not client_id or len(refresh_token) < 20:
            return None
        return {"email": email.lower(), "password": password, "clientId": client_id, "refreshToken": refresh_token, "status": "available"}

    def _load(self, accounts: list[str]):
        for line in accounts:
            parsed = self._parse_line(line)
            if parsed:
                self.records[parsed["email"]] = parsed
        if self.pool_file and self.pool_file.exists():
            for line in self.pool_file.read_text(encoding="utf-8").splitlines():
                parsed = self._parse_line(line)
                if parsed:
                    self.records.setdefault(parsed["email"], parsed)
        if self.state_file and self.state_file.exists():
            try:
                state = json.loads(self.state_file.read_text(encoding="utf-8"))
                for email, patch in state.items():
                    if email in self.records and isinstance(patch, dict):
                        self.records[email].update(patch)
            except Exception:
                pass

    def _save(self):
        if not self.state_file:
            return
        self.state_file.write_text(json.dumps(self.records, ensure_ascii=False, indent=2), encoding="utf-8")

    def claim_next(self):
        for record in self.records.values():
            if record.get("status", "available") == "available":
                record["status"] = "in_use"
                record["updatedAt"] = int(time.time())
                self._save()
                return record
        raise RuntimeError("[outlook] 号池里没有 available 账号")

    def mark(self, email: str, status: str, reason: str = ""):
        key = str(email or "").lower()
        if key in self.records:
            self.records[key]["status"] = status
            self.records[key]["reason"] = reason
            self.records[key]["updatedAt"] = int(time.time())
            self._save()


class MailProvider:
    def __init__(self, config: dict, domain: str | None = None):
        self.config = config
        self.provider = str(config.get("mailProvider") or "cloud-mail").lower()
        self.base_url = str(config.get("mailBaseUrl") or "").rstrip("/")
        self.domain = domain or config.get("mailDomain") or ""
        self.jwt = None
        self.address = None
        self.address_id = None
        self.address_password = None
        self.outlook_pool = None
        self.outlook_finalized = False

    def _admin_headers(self):
        headers = {"Content-Type": "application/json", "x-admin-auth": self.config.get("mailAdminPassword", "")}
        if self.config.get("mailSitePassword"):
            headers["x-custom-auth"] = self.config["mailSitePassword"]
        return headers

    def _cloud_headers(self, token):
        return {"Content-Type": "application/json", "Authorization": token}

    def _worker_headers(self):
        token = self.config.get("mailAdminToken") or self.config.get("mailAdminPassword") or ""
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    @staticmethod
    def _unwrap_cloud(payload, action: str):
        if isinstance(payload, dict) and payload.get("code") == 200:
            return payload.get("data")
        if isinstance(payload, dict) and "code" in payload:
            raise RuntimeError(f"[cloud-mail] {action} failed: {payload}")
        return payload

    def _ensure_admin_token(self):
        token = self.config.get("mailAdminToken")
        if token:
            return token
        email = self.config.get("mailAdminEmail") or ""
        password = self.config.get("mailAdminPassword") or ""
        if not email and "@" in password:
            email = password
        response = requests.post(f"{self.base_url}/api/login", json={"email": email, "password": password}, timeout=20)
        response.raise_for_status()
        data = self._unwrap_cloud(response.json(), "login")
        token = data.get("token") or data.get("jwt")
        if not token:
            raise RuntimeError("[cloud-mail] /api/login 未返回 token")
        self.config["mailAdminToken"] = token
        return token

    def _create_legacy(self, name=None):
        response = requests.post(
            f"{self.base_url}/admin/new_address",
            json={"name": name or _random_name(), "domain": self.domain, "enablePrefix": False},
            headers=self._admin_headers(),
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        self.jwt = data["jwt"]
        self.address = data["address"]
        self.address_id = data.get("address_id")
        print(f"[Mail] 创建邮箱: {self.address}")
        return self.address

    def _create_cloud_mail(self, name=None):
        admin = self._ensure_admin_token()
        suffix = self.domain if str(self.domain).startswith("@") else f"@{self.domain}"
        email = f"{name or _random_name()}{suffix}"
        password = _random_password()
        response = requests.post(
            f"{self.base_url}/api/user/add",
            json={"email": email, "suffix": suffix, "password": password, "type": self.config.get("mailUserType", 1)},
            headers=self._cloud_headers(admin),
            timeout=20,
        )
        response.raise_for_status()
        self._unwrap_cloud(response.json(), "user/add")
        login = requests.post(f"{self.base_url}/api/login", json={"email": email, "password": password}, timeout=20)
        login.raise_for_status()
        data = self._unwrap_cloud(login.json(), "login(new mailbox)")
        self.jwt = data.get("token") or data.get("jwt")
        self.address = email
        self.address_password = password
        print(f"[Mail][cloud-mail] 创建邮箱: {self.address}")
        return self.address

    def _create_cloudflare_worker(self, name=None):
        response = requests.post(
            f"{self.base_url}/api/create-address",
            json={"name": name or _random_name(), "domain": self.domain},
            headers=self._worker_headers(),
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        self.jwt = self.config.get("mailAdminToken") or self.config.get("mailAdminPassword") or "cloudflare-worker"
        self.address = data.get("address") or f"{name}@{self.domain}"
        self.address_id = data.get("id")
        print(f"[Mail][cloudflare-worker] 创建邮箱: {self.address}")
        return self.address

    def _create_outlook(self):
        if not self.outlook_pool:
            self.outlook_pool = OutlookPool(
                self.config.get("outlookPoolFile", ""),
                self.config.get("outlookPoolStateFile", ""),
                self.config.get("outlookAccounts", []),
            )
        account = self.outlook_pool.claim_next()
        self.jwt = "outlook-imap-oauth2"
        self.address = account["email"]
        self.address_password = account.get("password")
        print(f"[Mail][outlook] 从号池取用邮箱: {self.address}")
        return self.address

    def create_address(self, name=None):
        if self.provider == "outlook":
            return self._create_outlook()
        if self.provider == "legacy":
            return self._create_legacy(name)
        if self.provider == "cloudflare-worker":
            return self._create_cloudflare_worker(name)
        return self._create_cloud_mail(name)

    def get_email(self) -> str:
        return self.address or ""

    def get_mails(self, limit=10, offset=0):
        if self.provider == "cloudflare-worker":
            response = requests.get(
                f"{self.base_url}/api/mails",
                params={"address": self.address, "limit": limit, "offset": offset},
                headers=self._worker_headers(),
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()
            return data if isinstance(data, list) else data.get("mails") or data.get("results") or data.get("data") or []
        if self.provider == "cloud-mail":
            if not self.jwt:
                raise RuntimeError("[cloud-mail] 当前邮箱会话不存在")
            response = requests.get(
                f"{self.base_url}/api/email/list",
                params={"type": 0, "size": limit, "emailId": 0, "timeSort": 0, "allReceive": 0},
                headers=self._cloud_headers(self.jwt),
                timeout=20,
            )
            response.raise_for_status()
            data = self._unwrap_cloud(response.json(), "email/list")
            return data.get("list") if isinstance(data, dict) else []
        if self.provider == "outlook":
            raise NotImplementedError("Python 版已支持 Outlook 号池 claim，但暂未实现 IMAP XOAUTH2 收信；请先用 cloudflare-worker/cloud-mail，或继续使用 Node 版 Outlook 收信。")
        response = requests.get(f"{self.base_url}/api/mails", params={"limit": limit, "offset": offset}, headers={"Authorization": self.jwt}, timeout=15)
        response.raise_for_status()
        return response.json().get("results", [])

    def poll_code(self, max_attempts=30, interval=5) -> str:
        for attempt in range(1, max_attempts + 1):
            print(f"[Mail] polling code... ({attempt}/{max_attempts})")
            for mail in self.get_mails(5, 0):
                code = extract_verification_code(mail_to_text(mail))
                if code:
                    print(f"[Mail] latest code: {code}")
                    return code
            time.sleep(interval)
        raise RuntimeError("email code timeout")

    def mark_address_done(self, reason=""):
        if self.provider == "outlook" and self.outlook_pool and self.address and not self.outlook_finalized:
            self.outlook_pool.mark(self.address, "done", reason)
            self.outlook_finalized = True

    def mark_address_failed(self, reason=""):
        if self.provider == "outlook" and self.outlook_pool and self.address and not self.outlook_finalized:
            self.outlook_pool.mark(self.address, "failed", reason)
            self.outlook_finalized = True
