import argparse
import json
import random
import sys
from datetime import datetime
from pathlib import Path

from .browser_service import PatchrightBrowserService
from .config import ROOT_DIR, load_config
from .identity import generate_user_data
from .mail_provider import MailProvider
from .oauth_service import OAuthService
from .sms_provider import SMSBowerProvider, SMSProvider


ACCOUNTS_FILE = ROOT_DIR / "accounts.json"
USERNAME_FILE = ROOT_DIR / "username.json"


def read_json_array(path: Path) -> list:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def write_json(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="milliseconds") + "Z"


def sms_platform(config: dict) -> dict:
    if config.get("smsProvider") == "smsbower":
        return {
            "provider": "smsbower",
            "label": "SMSBower",
            "apiKey": config.get("smsBowerApiKey", ""),
            "baseUrl": config.get("smsBowerBaseUrl"),
            "service": config.get("smsBowerService", "dr"),
            "country": int(config.get("smsBowerCountry") or 73),
            "countryKey": "smsBowerCountry",
            "maxPrice": config.get("smsBowerMaxPrice"),
        }
    return {
        "provider": "herosms",
        "label": "HeroSMS",
        "apiKey": config.get("heroSmsApiKey", ""),
        "service": config.get("heroSmsService", "dr"),
        "country": int(config.get("heroSmsCountry") or 33),
        "countryKey": "heroSmsCountry",
        "maxPrice": config.get("heroSmsMaxPrice"),
    }


def create_sms_provider(platform: dict):
    if platform["provider"] == "smsbower":
        return SMSBowerProvider(platform["apiKey"], platform["baseUrl"], platform.get("maxPrice"))
    return SMSProvider(platform["apiKey"])


def get_country_provider_id(country: dict, platform: dict):
    for key in (platform["countryKey"], "smsCountry", "heroSmsCountry", "smsBowerCountry"):
        value = country.get(key)
        try:
            num = int(value)
            if num > 0:
                return num
        except Exception:
            pass
    return None


def resolve_phone_country(config: dict, platform: dict, country_arg: str = "") -> dict:
    countries = config.get("phoneCountries") or []
    code = (country_arg or config.get("phoneCountryCode") or "").upper()
    country = next((item for item in countries if item.get("isoCode") == code), None)
    if not country:
        country = next((item for item in countries if item.get("isoCode") == "CO"), None) or countries[0]
    resolved = {**country}
    provider_id = get_country_provider_id(resolved, platform) or platform["country"]
    resolved["smsCountry"] = provider_id
    resolved[platform["countryKey"]] = provider_id
    print(f"[SMS] 本轮使用国家: {resolved['name']} (+{resolved['dialCode']}), {platform['label']} 国家ID={provider_id}")
    return resolved


def selected_mail_domain(config: dict) -> str:
    domains = config.get("mailDomains") or []
    if not domains:
        return config.get("mailDomain") or ""
    return random.choice(domains)


def browser_proxy(config: dict):
    if not config.get("proxyHost") or not config.get("proxyPort"):
        return None
    return {
        "host": config.get("proxyHost"),
        "port": config.get("proxyPort"),
        "username": config.get("proxyUsername") or "",
        "password": config.get("proxyPassword") or "",
    }


def save_account(phone: str, password: str, name: str, birth_date: str, country: dict, platform: dict):
    rows = read_json_array(ACCOUNTS_FILE)
    rows.append({
        "phone": phone,
        "password": password,
        "name": name,
        "birthDate": birth_date,
        "phoneCountryCode": country.get("isoCode", ""),
        "phoneCountryDialCode": country.get("dialCode", ""),
        "phoneCountryName": country.get("name", ""),
        "heroSmsCountry": country.get("heroSmsCountry"),
        "smsBowerCountry": country.get("smsBowerCountry"),
        "smsProvider": platform["provider"],
        "smsCountry": get_country_provider_id(country, platform),
        "createdAt": now_iso(),
        "status": "registered",
    })
    write_json(ACCOUNTS_FILE, rows)
    print(f"[账号] 已保存到 accounts.json (共 {len(rows)} 个)")


def save_username(email: str, phone: str, password: str, name: str, birth_date: str, status: str, country: dict, platform: dict):
    rows = read_json_array(USERNAME_FILE)
    rows.append({
        "email": email,
        "phone": phone,
        "password": password,
        "name": name,
        "birthDate": birth_date,
        "phoneCountryCode": country.get("isoCode", ""),
        "phoneCountryDialCode": country.get("dialCode", ""),
        "phoneCountryName": country.get("name", ""),
        "heroSmsCountry": country.get("heroSmsCountry"),
        "smsBowerCountry": country.get("smsBowerCountry"),
        "smsProvider": platform["provider"],
        "smsCountry": get_country_provider_id(country, platform),
        "createdAt": now_iso(),
        "status": status,
    })
    write_json(USERNAME_FILE, rows)
    print(f"[账号] 已保存到 username.json (共 {len(rows)} 个)")


def update_account_status(phone: str, status: str):
    rows = read_json_array(ACCOUNTS_FILE)
    for item in rows:
        if item.get("phone") == phone:
            item["status"] = status
            item["updatedAt"] = now_iso()
    write_json(ACCOUNTS_FILE, rows)


def latest_phase2_account():
    rows = [x for x in read_json_array(ACCOUNTS_FILE) if x.get("phone") and x.get("password") and x.get("status", "registered") in {"registered", "oauth_phase2_failed"}]
    rows.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
    return rows[0] if rows else None


def latest_phase3_entry():
    rows = [x for x in read_json_array(USERNAME_FILE) if x.get("email") and x.get("password")]
    rows.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
    return rows[0] if rows else None


def phase1(sms, browser: PatchrightBrowserService, user, country: dict, platform: dict):
    print("[阶段1] 开始 ChatGPT 手机号注册流程")
    browser.navigate_to_signup()
    country_id = get_country_provider_id(country, platform) or platform["country"]
    sms.get_number(platform["service"], country_id)
    sms.mark_ready()
    browser.select_country(country.get("dialCode", ""), country.get("name", ""), country.get("isoCode", ""))
    local_number = browser.get_local_phone_number(sms.get_phone(), country)
    browser.enter_phone(local_number)
    browser.complete_profile(user, lambda: sms.poll_for_code(interval=5, max_attempts=36))
    save_account(sms.get_phone(), user.password, user.full_name, user.birth_date, country, platform)
    print("[阶段1] ChatGPT 注册流程完成")


def phase1_5(sms, browser: PatchrightBrowserService, user, country: dict):
    print("[阶段1.5] 首次登录 chatgpt.com 完成个人资料")
    browser.login_and_complete_profile({
        "phone": sms.get_phone(),
        "password": user.password,
        "fullName": user.full_name,
        "birthDate": user.birth_date,
        "age": user.age,
        "phoneCountry": country,
    })


def phase2(sms, mail: MailProvider, browser: PatchrightBrowserService, oauth: OAuthService, user, country: dict):
    print("[阶段2] 开始 Codex OAuth（绑定邮箱）")
    mail.create_address()
    email = mail.get_email()
    print(f"[阶段2] 邮箱: {email}")
    oauth.regenerate_pkce()
    browser.navigate_to_oauth(oauth.get_auth_url())
    browser.oauth_login_and_authorize({
        "loginMethod": "phone",
        "stopAfterEmailBound": True,
        "phone": sms.get_phone(),
        "phoneCountry": country,
        "email": email,
        "password": user.password,
        "fullName": user.full_name,
        "age": user.age,
        "birthDate": user.birth_date,
        "redirectUri": oauth.redirect_uri,
        "onSmsNeeded": lambda: sms.poll_for_code(interval=5, max_attempts=36),
        "onEmailCodeNeeded": lambda: mail.poll_code(),
    })
    mail.mark_address_done("email_bound")
    print("[阶段2] 临时邮箱绑定完成")
    return {"email": email}


def phase3(sms, mail: MailProvider, browser: PatchrightBrowserService, oauth: OAuthService, user, country: dict):
    print("[阶段3] 开始 Codex OAuth（邮箱登录获取 Token）")
    if not mail.get_email():
        raise RuntimeError("阶段3失败：未检测到已绑定邮箱")
    oauth.regenerate_pkce()
    browser.navigate_to_oauth(oauth.get_auth_url())
    callback = browser.oauth_login_and_authorize({
        "loginMethod": "email",
        "phone": sms.get_phone(),
        "phoneCountry": country,
        "email": mail.get_email(),
        "password": user.password,
        "fullName": user.full_name,
        "age": user.age,
        "birthDate": user.birth_date,
        "redirectUri": oauth.redirect_uri,
        "onSmsNeeded": lambda: sms.poll_for_code(interval=5, max_attempts=36),
        "onEmailCodeNeeded": lambda: mail.poll_code(),
    })
    params = oauth.extract_callback_params(callback)
    if params.get("error"):
        raise RuntimeError(f"OAuth 授权失败: {params.get('error_description') or params.get('error')}")
    if not params.get("code"):
        raise RuntimeError("回调 URL 中未找到授权码")
    return oauth.exchange_token_and_save(params["code"], mail.get_email())


def build_user_from_account(account: dict):
    class User:
        pass
    user = User()
    user.full_name = account.get("name") or "OpenAI User"
    user.password = account.get("password") or ""
    user.birth_date = account.get("birthDate") or "1990-01-01"
    try:
        user.age = datetime.utcnow().year - int(str(user.birth_date).split("-")[0])
    except Exception:
        user.age = 30
    return user


def build_country_from_record(record: dict, fallback: dict):
    return {
        "isoCode": record.get("phoneCountryCode") or fallback.get("isoCode", ""),
        "dialCode": record.get("phoneCountryDialCode") or fallback.get("dialCode", ""),
        "name": record.get("phoneCountryName") or fallback.get("name", ""),
        "heroSmsCountry": record.get("heroSmsCountry") or fallback.get("heroSmsCountry"),
        "smsBowerCountry": record.get("smsBowerCountry") or fallback.get("smsBowerCountry"),
        "smsCountry": record.get("smsCountry") or fallback.get("smsCountry"),
    }


def run_one(config: dict, args, platform: dict, country: dict):
    domain = selected_mail_domain(config)
    local_config = {**config, "mailDomain": domain}
    sms = create_sms_provider(platform)
    mail = MailProvider(local_config, domain)
    oauth = OAuthService(local_config)
    browser = PatchrightBrowserService(local_config, browser_proxy(local_config))
    browser.launch()
    try:
        if args.phase2:
            account = latest_phase2_account()
            if not account:
                raise RuntimeError("accounts.json 中没有可用于 phase2 的账号")
            user = build_user_from_account(account)
            sms.phone_number = account["phone"]
            run_country = build_country_from_record(account, country)
            phase1_5(sms, browser, user, run_country)
            data = phase2(sms, mail, browser, oauth, user, run_country)
            update_account_status(account["phone"], "email_bound")
            save_username(data["email"], account["phone"], user.password, user.full_name, user.birth_date, "email_bound", run_country, platform)
            return

        if args.phase3:
            entry = latest_phase3_entry()
            if not entry:
                raise RuntimeError("username.json 中没有可用于 phase3 的记录")
            user = build_user_from_account(entry)
            sms.phone_number = entry.get("phone", "")
            run_country = build_country_from_record(entry, country)
            mail.address = entry["email"]
            token = phase3(sms, mail, browser, oauth, user, run_country)
            print(f"[主程序] Token 已保存，邮箱: {token['email']}")
            return

        user = generate_user_data()
        print(f"[主程序] 用户: {user.full_name}, 年龄: {user.age}, 生日: {user.birth_date}")
        phase1(sms, browser, user, country, platform)
        phase1_5(sms, browser, user, country)
        data = phase2(sms, mail, browser, oauth, user, country)
        update_account_status(sms.get_phone(), "email_bound")
        save_username(data["email"], sms.get_phone(), user.password, user.full_name, user.birth_date, "email_bound", country, platform)
        if args.stop_after_phase2:
            sms.complete()
            print("[主程序] 已按 --stop-after-phase2 停在第二阶段收尾状态")
            return
        token = phase3(sms, mail, browser, oauth, user, country)
        sms.complete()
        update_account_status(sms.get_phone(), "oauth_done")
        print(f"[主程序] Token 已保存，邮箱: {token['email']}")
    except Exception:
        try:
            mail.mark_address_failed("flow failed")
        except Exception:
            pass
        raise
    finally:
        browser.close()


def parse_args(argv: list[str]):
    parser = argparse.ArgumentParser(description="Patchright Python registrar")
    parser.add_argument("count", nargs="?", type=int, default=1)
    parser.add_argument("--country", default="")
    parser.add_argument("--phase2", action="store_true")
    parser.add_argument("--phase3", action="store_true")
    parser.add_argument("--stop-after-phase2", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    config = load_config()
    platform = sms_platform(config)
    country = resolve_phone_country(config, platform, args.country)
    total = 1 if args.phase2 or args.phase3 else max(1, args.count)
    success = 0
    for idx in range(1, total + 1):
        print(f"\n[Start] ===== {idx}/{total} =====")
        try:
            run_one(config, args, platform, country)
            success += 1
        except Exception as exc:
            print(f"[Error] 第 {idx} 个流程失败: {exc}")
            if total == 1:
                raise
    print(f"\n[Result] success={success}, failed={total - success}, total={total}")


if __name__ == "__main__":
    main()
