import json
import os
import platform
from pathlib import Path
from urllib.parse import urlparse, unquote


ROOT_DIR = Path(__file__).resolve().parent.parent


DEFAULT_PHONE_COUNTRIES = [
    {"isoCode": "GB", "dialCode": "44", "name": "英国"},
    {"isoCode": "US", "dialCode": "1", "name": "美国"},
    {"isoCode": "CA", "dialCode": "1", "name": "加拿大"},
    {"isoCode": "AU", "dialCode": "61", "name": "澳大利亚"},
    {"isoCode": "NZ", "dialCode": "64", "name": "新西兰"},
    {"isoCode": "IE", "dialCode": "353", "name": "爱尔兰"},
    {"isoCode": "DE", "dialCode": "49", "name": "德国"},
    {"isoCode": "FR", "dialCode": "33", "name": "法国"},
    {"isoCode": "ES", "dialCode": "34", "name": "西班牙"},
    {"isoCode": "IT", "dialCode": "39", "name": "意大利"},
    {"isoCode": "NL", "dialCode": "31", "name": "荷兰"},
    {"isoCode": "BE", "dialCode": "32", "name": "比利时"},
    {"isoCode": "AT", "dialCode": "43", "name": "奥地利"},
    {"isoCode": "CH", "dialCode": "41", "name": "瑞士"},
    {"isoCode": "SE", "dialCode": "46", "name": "瑞典"},
    {"isoCode": "NO", "dialCode": "47", "name": "挪威"},
    {"isoCode": "DK", "dialCode": "45", "name": "丹麦"},
    {"isoCode": "FI", "dialCode": "358", "name": "芬兰"},
    {"isoCode": "PL", "dialCode": "48", "name": "波兰"},
    {"isoCode": "PT", "dialCode": "351", "name": "葡萄牙"},
    {"isoCode": "CZ", "dialCode": "420", "name": "捷克"},
    {"isoCode": "GR", "dialCode": "30", "name": "希腊"},
    {"isoCode": "RO", "dialCode": "40", "name": "罗马尼亚"},
    {"isoCode": "HU", "dialCode": "36", "name": "匈牙利"},
    {"isoCode": "TR", "dialCode": "90", "name": "土耳其"},
    {"isoCode": "IL", "dialCode": "972", "name": "以色列"},
    {"isoCode": "AE", "dialCode": "971", "name": "阿联酋"},
    {"isoCode": "SA", "dialCode": "966", "name": "沙特阿拉伯"},
    {"isoCode": "SG", "dialCode": "65", "name": "新加坡"},
    {"isoCode": "MY", "dialCode": "60", "name": "马来西亚"},
    {"isoCode": "TH", "dialCode": "66", "name": "泰国"},
    {"isoCode": "VN", "dialCode": "84", "name": "越南"},
    {"isoCode": "PH", "dialCode": "63", "name": "菲律宾"},
    {"isoCode": "ID", "dialCode": "62", "name": "印度尼西亚"},
    {"isoCode": "IN", "dialCode": "91", "name": "印度"},
    {"isoCode": "JP", "dialCode": "81", "name": "日本"},
    {"isoCode": "KR", "dialCode": "82", "name": "韩国"},
    {"isoCode": "HK", "dialCode": "852", "name": "中国香港"},
    {"isoCode": "TW", "dialCode": "886", "name": "中国台湾"},
    {"isoCode": "BR", "dialCode": "55", "name": "巴西"},
    {"isoCode": "MX", "dialCode": "52", "name": "墨西哥"},
    {"isoCode": "AR", "dialCode": "54", "name": "阿根廷"},
    {"isoCode": "CL", "dialCode": "56", "name": "智利"},
    {"isoCode": "CO", "dialCode": "57", "name": "哥伦比亚", "heroSmsCountry": 33},
    {"isoCode": "PE", "dialCode": "51", "name": "秘鲁"},
    {"isoCode": "ZA", "dialCode": "27", "name": "南非"},
    {"isoCode": "EG", "dialCode": "20", "name": "埃及"},
    {"isoCode": "NG", "dialCode": "234", "name": "尼日利亚"},
]


def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[Config] 解析配置失败: {path} -> {exc}")
        return {}


def _profile_path() -> Path | None:
    explicit = os.environ.get("CONFIG_FILE", "").strip()
    if explicit:
        p = Path(explicit)
        return p if p.is_absolute() else ROOT_DIR / p
    profile = os.environ.get("CONFIG_PROFILE", "").strip()
    if profile:
        return ROOT_DIR / f"config.{profile}.json"
    system = platform.system().lower()
    if system == "darwin":
        return ROOT_DIR / "config.local.json"
    if system == "linux":
        return ROOT_DIR / "config.server.json"
    return None


def _bool(value, default=False) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _int(value, default=0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _float_or_none(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except Exception:
        return None


def _path(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    p = Path(raw)
    return str(p if p.is_absolute() else ROOT_DIR / p)


def _proxy_from_env() -> dict | None:
    raw = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("ALL_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("http_proxy")
        or os.environ.get("all_proxy")
        or ""
    ).strip()
    if not raw:
        return None
    parsed = urlparse(raw if "://" in raw else f"http://{raw}")
    if not parsed.hostname:
        return None
    return {
        "host": parsed.hostname,
        "port": parsed.port or (443 if parsed.scheme == "https" else 80),
        "username": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "protocol": f"{parsed.scheme}:",
    }


def _mail_domains(data: dict) -> list[str]:
    domains = data.get("mailDomains") if isinstance(data.get("mailDomains"), list) else []
    out = [str(item).strip().lstrip("@") for item in domains if str(item or "").strip()]
    fallback = str(data.get("mailDomain") or "").strip().lstrip("@")
    return out or ([fallback] if fallback else [])


def _phone_countries(data: dict) -> list[dict]:
    raw = data.get("phoneCountries") if isinstance(data.get("phoneCountries"), list) else DEFAULT_PHONE_COUNTRIES
    rows = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        iso = str(item.get("isoCode") or item.get("iso") or "").strip().upper()
        dial = str(item.get("dialCode") or item.get("phoneCode") or "").strip().lstrip("+")
        name = str(item.get("name") or item.get("country") or "").strip()
        if not iso or not dial or not name:
            continue
        row = {"isoCode": iso, "dialCode": dial, "name": name}
        for key in ("heroSmsCountry", "smsBowerCountry", "smsCountry"):
            if item.get(key) not in (None, ""):
                row[key] = _int(item.get(key), 0) or None
        rows.append(row)
    return rows


def load_config() -> dict:
    base = _read_json(ROOT_DIR / "config.json")
    profile = _profile_path()
    overlay = _read_json(profile) if profile else {}
    if profile and profile.exists():
        print(f"[Config] 使用覆盖配置: {profile}")
    raw = {**base, **overlay}
    env_proxy = _proxy_from_env()
    domains = _mail_domains(raw)
    sms_provider = str(
        os.environ.get("SMS_PROVIDER")
        or raw.get("smsProvider")
        or ("smsbower" if raw.get("smsBowerApiKey") or os.environ.get("SMSBOWER_API_KEY") else "herosms")
    ).strip().lower()
    token_dirs = raw.get("tokenOutputDirs") if isinstance(raw.get("tokenOutputDirs"), list) else []
    return {
        **raw,
        "smsProvider": "smsbower" if sms_provider == "smsbower" else "herosms",
        "heroSmsApiKey": raw.get("heroSmsApiKey", ""),
        "heroSmsService": raw.get("heroSmsService", "dr"),
        "heroSmsCountry": _int(raw.get("heroSmsCountry"), 33),
        "heroSmsMaxPrice": _float_or_none(raw.get("heroSmsMaxPrice")),
        "smsBowerApiKey": os.environ.get("SMSBOWER_API_KEY") or os.environ.get("SMS_BOWER_API_KEY") or raw.get("smsBowerApiKey") or raw.get("smsbowerApiKey") or "",
        "smsBowerBaseUrl": raw.get("smsBowerBaseUrl") or raw.get("smsbowerBaseUrl") or "https://smsbower.page/stubs/handler_api.php",
        "smsBowerService": raw.get("smsBowerService") or raw.get("smsbowerService") or "dr",
        "smsBowerCountry": _int(raw.get("smsBowerCountry") or raw.get("smsbowerCountry"), 73),
        "smsBowerMaxPrice": _float_or_none(raw.get("smsBowerMaxPrice") or raw.get("smsbowerMaxPrice") or raw.get("heroSmsMaxPrice")),
        "phoneCountryCode": str(raw.get("phoneCountryCode") or "CO").strip().upper(),
        "phoneCountries": _phone_countries(raw),
        "mailProvider": raw.get("mailProvider") or "cloud-mail",
        "mailBaseUrl": str(raw.get("mailBaseUrl") or "").rstrip("/"),
        "mailAdminEmail": raw.get("mailAdminEmail") or "",
        "mailAdminPassword": raw.get("mailAdminPassword") or "",
        "mailAdminToken": raw.get("mailAdminToken") or "",
        "mailSitePassword": raw.get("mailSitePassword") or "",
        "mailUserType": _int(raw.get("mailUserType"), 1),
        "mailDomain": domains[0] if domains else "",
        "mailDomains": domains,
        "outlookPoolFile": _path(os.environ.get("OUTLOOK_POOL_FILE") or raw.get("outlookPoolFile") or "outlook_pool.txt"),
        "outlookPoolStateFile": _path(raw.get("outlookPoolStateFile") or "outlook_pool_state.json"),
        "outlookAccounts": raw.get("outlookAccounts") if isinstance(raw.get("outlookAccounts"), list) else [],
        "proxyHost": raw.get("proxyHost") or (env_proxy or {}).get("host", ""),
        "proxyPort": _int(raw.get("proxyPort"), 0) or (env_proxy or {}).get("port", 0),
        "proxyUsername": raw.get("proxyUsername") or (env_proxy or {}).get("username", ""),
        "proxyPassword": raw.get("proxyPassword") or (env_proxy or {}).get("password", ""),
        "oauthClientId": raw.get("oauthClientId") or "app_EMoamEEZ73f0CkXaXp7hrann",
        "oauthRedirectPort": _int(raw.get("oauthRedirectPort"), 1455),
        "tokenOutputDir": os.environ.get("TOKEN_OUTPUT_DIR") or raw.get("tokenOutputDir") or "",
        "tokenOutputDirs": [str(x) for x in token_dirs if str(x or "").strip()],
        "chromePath": raw.get("chromePath") or "",
        "browserUserDataDir": _path(raw.get("browserUserDataDir") or ""),
        "browserIncognito": _bool(raw.get("browserIncognito"), False),
        "browserClearChatGptSession": _bool(raw.get("browserClearChatGptSession"), False),
    }
