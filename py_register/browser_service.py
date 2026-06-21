import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse

def sleep(seconds: float):
    time.sleep(seconds)


class PatchrightBrowserService:
    def __init__(self, config: dict, proxy: dict | None = None):
        self.config = config
        self.proxy = proxy
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None

    def launch(self):
        try:
            from patchright.sync_api import sync_playwright
        except ModuleNotFoundError as exc:
            raise RuntimeError("缺少 patchright，请先执行: pip install -r requirements-patchright.txt") from exc

        print("[Browser] 启动 patchright Chromium...")
        self.playwright = sync_playwright().start()
        proxy_settings = None
        if self.proxy and self.proxy.get("host") and self.proxy.get("port"):
            proxy_settings = {"server": f"http://{self.proxy['host']}:{self.proxy['port']}", "bypass": "localhost"}
            if self.proxy.get("username") or self.proxy.get("password"):
                proxy_settings["username"] = self.proxy.get("username", "")
                proxy_settings["password"] = self.proxy.get("password", "")
            print(f"[Browser] 使用代理: {self.proxy['host']}:{self.proxy['port']}")

        args = ["--lang=zh-CN"]
        chrome_path = self.config.get("chromePath") or None
        user_data_dir = self.config.get("browserUserDataDir") or ""
        incognito = bool(self.config.get("browserIncognito"))

        if user_data_dir and not incognito:
            Path(user_data_dir).mkdir(parents=True, exist_ok=True)
            self.context = self.playwright.chromium.launch_persistent_context(
                user_data_dir,
                headless=False,
                executable_path=chrome_path,
                args=args,
                proxy=proxy_settings,
                locale="zh-CN",
                viewport={"width": 1280, "height": 900},
            )
            self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
            print(f"[Browser] 使用持久化 profile: {user_data_dir}")
        else:
            self.browser = self.playwright.chromium.launch(
                headless=False,
                executable_path=chrome_path,
                args=args,
                proxy=proxy_settings,
            )
            self.context = self.browser.new_context(
                locale="zh-CN",
                viewport={"width": 1280, "height": 900},
                extra_http_headers={"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"},
            )
            self.page = self.context.new_page()
        print("[Browser] patchright 浏览器已启动")

    def close(self):
        for item in (self.context, self.browser):
            try:
                if item:
                    item.close()
            except Exception:
                pass
        try:
            if self.playwright:
                self.playwright.stop()
        except Exception:
            pass

    def screenshot(self, filename: str):
        path = Path("logs") / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.page.screenshot(path=str(path))
            print(f"[Browser] 截图: {path}")
        except Exception as exc:
            print(f"[Browser] 截图失败: {exc}")

    def wait_for_cloudflare(self, timeout_ms: int = 60000):
        deadline = time.time() + timeout_ms / 1000
        while time.time() < deadline:
            try:
                title = self.page.title()
                url = self.page.url
                if not any(x.lower() in title.lower() for x in ["checking", "稍候", "moment"]):
                    if "challenge" not in url:
                        return
            except Exception:
                pass
            sleep(2)
        raise RuntimeError("Cloudflare 验证超时")

    def wait_for_text(self, texts, timeout_ms: int = 30000):
        candidates = texts if isinstance(texts, list) else [texts]
        deadline = time.time() + timeout_ms / 1000
        while time.time() < deadline:
            body = self._body_text()
            if any(text in body for text in candidates):
                return
            sleep(1)
        raise RuntimeError(f"等待文字超时: {candidates}")

    def wait_for_button_text(self, texts, timeout_ms: int = 30000):
        candidates = texts if isinstance(texts, list) else [texts]
        deadline = time.time() + timeout_ms / 1000
        while time.time() < deadline:
            buttons = self.page.locator("button, [role=button], a")
            for i in range(buttons.count()):
                text = (buttons.nth(i).inner_text(timeout=500) or "").strip()
                if any(x in text for x in candidates):
                    return
            sleep(1)
        raise RuntimeError(f"等待按钮超时: {candidates}")

    def click_button_by_text(self, texts, timeout_ms: int = 10000):
        candidates = texts if isinstance(texts, list) else [texts]
        deadline = time.time() + timeout_ms / 1000
        while time.time() < deadline:
            buttons = self.page.locator("button, [role=button], a")
            for i in range(buttons.count()):
                node = buttons.nth(i)
                try:
                    text = (node.inner_text(timeout=500) or "").strip()
                    if any(x in text for x in candidates):
                        node.click(timeout=1500)
                        return
                except Exception:
                    continue
            sleep(0.8)
        raise RuntimeError(f"找不到按钮: {candidates}")

    def click_submit_button(self):
        clicked = self.page.evaluate(
            """() => {
                const labels = ['继续', 'Continue', '下一步', 'Next', '创建账号', 'Create account', 'Sign up', 'Verify', 'Submit'];
                const nodes = Array.from(document.querySelectorAll('button[type="submit"], button, [role="button"]'));
                const visible = el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                };
                const disabled = el => el.disabled || el.getAttribute('aria-disabled') === 'true';
                const candidates = nodes.filter(el => visible(el) && !disabled(el));
                const target = candidates.find(el => labels.includes((el.innerText || el.textContent || '').trim()))
                    || candidates.find(el => el.matches('button[type="submit"]'))
                    || candidates[0];
                if (!target) return '';
                target.scrollIntoView({block: 'center', inline: 'center'});
                for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
                    target.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, view: window}));
                }
                target.click?.();
                return (target.innerText || target.textContent || '').trim();
            }"""
        )
        print(f"[Browser] 点击提交按钮: {clicked or '(unknown)'}")
        sleep(3)

    def _body_text(self) -> str:
        try:
            return self.page.evaluate("() => document.body?.innerText || ''")
        except Exception:
            return ""

    def page_info(self):
        return self.page.evaluate(
            """() => ({
                url: location.href,
                text: (document.body?.innerText || '').slice(0, 1000),
                btns: Array.from(document.querySelectorAll('button')).map(b => (b.innerText || '').trim()).filter(Boolean),
                inputs: Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
                    type: i.type || '', name: i.name || '', placeholder: i.placeholder || '', id: i.id || ''
                }))
            })"""
        )

    @staticmethod
    def get_local_phone_number(phone: str, country: dict) -> str:
        normalized = str(phone or "").strip()
        dial = str((country or {}).get("dialCode") or "").lstrip("+")
        if dial and normalized.startswith(f"+{dial}"):
            return normalized[len(dial) + 1:]
        return normalized.lstrip("+")

    def select_country(self, dial_code: str, country_hint: str = "", country_iso: str = ""):
        dial_code = str(dial_code or "").lstrip("+")
        if not dial_code:
            return
        print(f"[Browser] 选择国家代码 +{dial_code}...")
        result = self.page.evaluate(
            """({code, hint, iso}) => {
                for (const b of document.querySelectorAll('button')) {
                    const text = (b.innerText || '').trim();
                    if (text.includes(`+${code}`) || text.includes(`(${code})`)) return `already:${text}`;
                }
                const select = document.querySelector('select');
                if (!select) return '';
                const options = Array.from(select.options);
                let target = null;
                if (iso) target = options.find(opt => String(opt.value).toUpperCase() === String(iso).toUpperCase());
                if (!target && hint) target = options.find(opt => opt.text.includes(hint));
                if (!target) target = options.find(opt => opt.text.includes(`+${code}`) || opt.text.includes(`(${code})`));
                if (!target) return '';
                const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
                if (setter) setter.call(select, target.value); else select.value = target.value;
                select.dispatchEvent(new Event('change', {bubbles: true}));
                return target.text;
            }""",
            {"code": dial_code, "hint": country_hint or "", "iso": country_iso or ""},
        )
        if result:
            print(f"[Browser] 国家选择结果: {result}")
        sleep(1)

    def enter_phone(self, local_number: str):
        print(f"[Browser] 输入手机号: {local_number}")
        input_box = self.page.locator('input[name="phoneNumberInput"], input[type="tel"]').first
        input_box.click(click_count=3, timeout=15000)
        input_box.type(str(local_number), delay=50)
        sleep(0.5)
        self.click_submit_button()
        self.wait_for_cloudflare(60000)
        sleep(3)

    def enter_code(self, code: str):
        print(f"[Browser] 输入验证码: {code}")
        sleep(1.5)
        target = None
        inputs = self.page.locator('input:not([type="hidden"]):not([type="password"])')
        for index in range(inputs.count()):
            candidate = inputs.nth(index)
            try:
                name = candidate.get_attribute("name") or ""
                box = candidate.bounding_box()
                if name != "phoneNumberInput" and box and box.get("width", 0) > 0 and box.get("height", 0) > 0:
                    target = candidate
                    break
            except Exception:
                continue
        try:
            if not target:
                raise RuntimeError("no visible code input")
            target.click(click_count=3, timeout=5000)
            target.type(str(code), delay=80)
        except Exception:
            self.page.keyboard.press("Tab")
            self.page.keyboard.type(str(code), delay=80)
        sleep(1)
        self.click_submit_button()

    def fill_password(self, password: str):
        box = self.page.locator('input[type="password"]').first
        box.click(click_count=3, timeout=10000)
        box.type(password, delay=35)

    def fill_about_you_and_submit(self, full_name: str, age: int, birth_date: str, tag: str):
        sleep(1.5)
        filled = self.page.evaluate(
            """({fullName, age, birthDate}) => {
                const [year, month, day] = String(birthDate || '1990-01-01').split('-');
                const results = [];
                const isVisible = (el) => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const labelText = (el) => {
                    const parts = [
                        el.name,
                        el.id,
                        el.placeholder,
                        el.getAttribute('aria-label'),
                        el.getAttribute('autocomplete'),
                    ];
                    if (el.id) {
                        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                        if (label) parts.push(label.innerText || label.textContent || '');
                    }
                    const parentText = el.closest('label, div, section, fieldset')?.innerText || '';
                    parts.push(parentText.slice(0, 180));
                    return parts.filter(Boolean).join(' ').toLowerCase();
                };
                const setValue = (el, value) => {
                    el.scrollIntoView({block: 'center', inline: 'center'});
                    el.focus();
                    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
                    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                    if (setter) setter.call(el, String(value)); else el.value = String(value);
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                    el.dispatchEvent(new Event('change', {bubbles: true}));
                    el.dispatchEvent(new KeyboardEvent('keyup', {bubbles: true}));
                };
                const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])')).filter(isVisible);

                const nameInput = inputs.find((el) => {
                    const text = labelText(el);
                    return /(^|\\s)(name|full-name|fullname)(\\s|$)/i.test(text)
                        || text.includes('full name')
                        || text.includes('姓名')
                        || text.includes('名字')
                        || String(el.name || '').toLowerCase() === 'name';
                });
                if (nameInput && fullName) {
                    setValue(nameInput, fullName);
                    results.push(`name=${fullName}`);
                }

                const ageInput = inputs.find((el) => {
                    const text = labelText(el);
                    if (String(el.name || '').toLowerCase() === 'age') return true;
                    if (text.includes('age') || text.includes('年龄') || text.includes('old')) return true;
                    return el.type === 'number' && !/(year|month|day|birth|年|月|日|phone|code)/i.test(text);
                });
                if (ageInput && age) {
                    setValue(ageInput, age);
                    results.push(`age=${age}`);
                }

                const dateInput = !ageInput && inputs.find((el) => {
                    const text = labelText(el);
                    return el.type === 'date' || text.includes('birth date') || text.includes('birthday') || text.includes('出生日期') || text.includes('生日');
                });
                if (dateInput && birthDate) {
                    setValue(dateInput, birthDate);
                    results.push(`birthDate=${birthDate}`);
                }

                if (!ageInput && !dateInput) {
                    const findPart = (patterns) => inputs.find((el) => {
                        const text = labelText(el);
                        return patterns.some((pattern) => pattern.test(text));
                    });
                    const yearInput = findPart([/birth.{0,30}year/i, /year.{0,30}birth/i, /(^|\\s)year(\\s|$)/i, /出生.*年/, /年/]);
                    const monthInput = findPart([/birth.{0,30}month/i, /month.{0,30}birth/i, /(^|\\s)month(\\s|$)/i, /出生.*月/, /月/]);
                    const dayInput = findPart([/birth.{0,30}day/i, /day.{0,30}birth/i, /(^|\\s)day(\\s|$)/i, /出生.*日/, /日/]);
                    if (yearInput && year) {
                        setValue(yearInput, year);
                        results.push(`birthYear=${year}`);
                    }
                    if (monthInput && month) {
                        setValue(monthInput, String(Number(month)));
                        results.push(`birthMonth=${String(Number(month))}`);
                    }
                    if (dayInput && day) {
                        setValue(dayInput, String(Number(day)));
                        results.push(`birthDay=${String(Number(day))}`);
                    }
                }

                const selects = Array.from(document.querySelectorAll('select')).filter(isVisible);
                for (const select of selects) {
                    const text = labelText(select);
                    let wanted = '';
                    if (/year|年/.test(text)) wanted = year;
                    if (/month|月/.test(text)) wanted = String(Number(month));
                    if (/day|日/.test(text)) wanted = String(Number(day));
                    if (!wanted) continue;
                    const option = Array.from(select.options).find((opt) => opt.value === wanted || opt.text.trim() === wanted || opt.text.includes(wanted));
                    if (option) {
                        setValue(select, option.value);
                        results.push(`${text.includes('month') || text.includes('月') ? 'birthMonth' : text.includes('day') || text.includes('日') ? 'birthDay' : 'birthYear'}=${wanted}`);
                    }
                }
                return results;
            }""",
            {"fullName": full_name, "age": str(age), "birthDate": birth_date},
        )
        if filled:
            print(f"{tag} about-you 已填写: {', '.join(filled)}")
        else:
            print(f"{tag} 未识别到 about-you 输入框，准备直接尝试提交")
        self.page.evaluate(
            """() => {
                for (const input of document.querySelectorAll('input[type="checkbox"]')) {
                    if (!input.checked && !input.disabled) input.click();
                }
                for (const box of document.querySelectorAll('[role="checkbox"][aria-checked="false"]')) box.click();
            }"""
        )
        self.click_submit_button()
        self.wait_for_cloudflare(60000)
        sleep(2)

    @staticmethod
    def is_choose_account_page(info: dict) -> bool:
        url = str(info.get("url") or "")
        text = str(info.get("text") or "")
        return (
            "/choose-an-account" in url
            or "选择帐户" in text
            or "选择账户" in text
            or "choose an account" in text.lower()
        )

    def choose_existing_account(self, phone: str = "", full_name: str = "", tag: str = "[OAuth]"):
        phone_digits = re.sub(r"\D+", "", str(phone or ""))
        local_digits = phone_digits[-9:] if len(phone_digits) > 6 else phone_digits
        result = self.page.evaluate(
            """({phoneDigits, localDigits, fullName}) => {
                const visible = (el) => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const digitsOnly = (value) => String(value || '').replace(/\\D+/g, '');
                const normalizedName = String(fullName || '').trim().toLowerCase();
                const skipTexts = [
                    'use another account',
                    'add account',
                    '使用其他',
                    '其他帐号',
                    '其他账号',
                    '继续使用手机',
                    'continue with phone',
                    'continue with email',
                    'google',
                    'apple',
                    'microsoft'
                ];
                const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex], [role="option"]'));
                let best = null;
                for (const node of nodes) {
                    if (!visible(node)) continue;
                    const text = (node.innerText || node.textContent || '').trim();
                    if (!text || text.length < 2) continue;
                    const lower = text.toLowerCase();
                    if (skipTexts.some(item => lower.includes(item.toLowerCase()))) continue;
                    const digits = digitsOnly(text);
                    let score = 0;
                    if (phoneDigits && digits.includes(phoneDigits)) score += 120;
                    if (localDigits && digits.includes(localDigits)) score += 90;
                    if (normalizedName && lower.includes(normalizedName)) score += 70;
                    if (/@/.test(text)) score += 25;
                    if (digits.length >= 4) score += 20;
                    if (lower.includes('choose') || lower.includes('选择')) score -= 20;
                    if (score <= 0 && !/@/.test(text) && digits.length < 4) continue;
                    const rect = node.getBoundingClientRect();
                    const item = {
                        score,
                        text: text.slice(0, 200),
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2,
                    };
                    if (!best || item.score > best.score) best = item;
                }
                if (!best) {
                    const fallback = nodes.find((node) => {
                        if (!visible(node)) return false;
                        const text = (node.innerText || node.textContent || '').trim();
                        const lower = text.toLowerCase();
                        if (!text || text.length < 2) return false;
                        if (skipTexts.some(item => lower.includes(item.toLowerCase()))) return false;
                        if (lower.includes('choose an account') || lower.includes('选择帐户') || lower.includes('选择账户')) return false;
                        return true;
                    });
                    if (fallback) {
                        const rect = fallback.getBoundingClientRect();
                        best = {
                            score: 1,
                            text: (fallback.innerText || fallback.textContent || '').trim().slice(0, 200),
                            x: rect.left + rect.width / 2,
                            y: rect.top + rect.height / 2,
                        };
                    }
                }
                return best;
            }""",
            {"phoneDigits": phone_digits, "localDigits": local_digits, "fullName": full_name or ""},
        )
        if not result:
            self.screenshot("choose-account-not-found.png")
            raise RuntimeError("choose-an-account 页面未找到可点击账号卡片")
        print(f"{tag} 选择已有账号: {result.get('text')}")
        self.page.mouse.click(result["x"], result["y"])
        sleep(3)
        self.wait_for_cloudflare(30000)
        sleep(2)

    def navigate_to_signup(self):
        if self.config.get("browserClearChatGptSession"):
            print("[Browser] Python 版暂不主动清理 profile，仅使用配置的 profile/上下文")
        print("[Browser] 导航到 chatgpt.com...")
        self.page.goto("https://chatgpt.com", wait_until="domcontentloaded", timeout=60000)
        self.wait_for_cloudflare()
        self.wait_for_button_text(["免费注册", "Sign up for free", "Sign up"], 30000)
        sleep(4)
        for attempt in range(1, 4):
            print(f"[Browser] 点击「免费注册」... ({attempt}/3)")
            self.click_button_by_text(["免费注册", "Sign up for free", "Sign up"], 12000)
            try:
                self.wait_for_text(["登录或注册", "Log in or sign up"], 30000)
                break
            except Exception:
                if attempt == 3:
                    raise
        sleep(1)
        self.click_button_by_text(["使用电话号码继续", "继续使用手机登录", "手机登录", "Continue with phone number", "Continue with phone"], 10000)
        self.page.locator('input[name="phoneNumberInput"]').wait_for(timeout=15000)

    def complete_profile(self, user, on_sms_needed):
        last_url = ""
        for round_no in range(20):
            sleep(3)
            info = self.page_info()
            url = info["url"]
            text = info["text"]
            print(f"[Phase1] Round {round_no}: {url[:80]}")
            if "chatgpt.com" in url and "auth.openai.com" not in url and "登录或注册" not in text:
                print("[Phase1] 注册完成，已到达 ChatGPT")
                return True
            if self.is_choose_account_page(info):
                self.choose_existing_account(full_name=user.full_name, tag="[Phase1]")
                last_url = ""
                continue
            if url == last_url and "password" not in url:
                continue
            if "about-you" in url or "about_you" in url or "你的年龄是多少" in text:
                self.fill_about_you_and_submit(user.full_name, user.age, user.birth_date, "[Phase1]")
                last_url = url
                continue
            if "password" in url or any(i["type"] == "password" for i in info["inputs"]):
                if "log-in/password" in url or "forgot password" in text.lower() or "忘记密码" in text:
                    raise RuntimeError("当前手机号可能已存在账号，落到了登录密码页")
                self.fill_password(user.password)
                self.page.keyboard.press("Enter")
                sleep(1)
                self.click_submit_button()
                last_url = ""
                continue
            if "contact-verification" in url or "verify" in url or re.search(r"验证码|verification|code", text, re.I):
                code = on_sms_needed()
                self.enter_code(code)
                last_url = url
                continue
            name_input = next((i for i in info["inputs"] if "name" in (i["name"] + i["placeholder"] + i["id"]).lower() or "姓名" in i["placeholder"]), None)
            if name_input:
                sel = f"#{name_input['id']}" if name_input.get("id") else f"input[name='{name_input['name']}']"
                self.page.locator(sel).first.fill(user.full_name)
                self.click_submit_button()
                last_url = url
                continue
            last_url = url
        raise RuntimeError("注册资料填写超时")

    def navigate_to_oauth(self, auth_url: str):
        print("[Browser] 导航到 OAuth URL...")
        self.page.goto(auth_url, wait_until="domcontentloaded", timeout=60000)
        self.wait_for_cloudflare()
        sleep(4)

    def oauth_login_and_authorize(self, opts: dict):
        redirect = urlparse(opts["redirectUri"])
        captured = {"url": ""}

        def on_request(request):
            try:
                parsed = urlparse(request.url)
                if parsed.hostname == redirect.hostname and str(parsed.port or "") == str(redirect.port) and parsed.path == redirect.path:
                    if "code=" in parsed.query or "error=" in parsed.query:
                        captured["url"] = request.url
                        print(f"[OAuth] 捕获到回调 URL: {request.url[:100]}...")
            except Exception:
                pass

        self.page.on("request", on_request)
        login_method = opts.get("loginMethod", "phone")
        email_bound = False
        last_url = ""
        sleep(4)
        try:
            for round_no in range(30):
                sleep(3)
                if captured["url"]:
                    return captured["url"]
                info = self.page_info()
                url = info["url"]
                text = info["text"]
                buttons = info["btns"]
                print(f"[OAuth] Round {round_no}: {url[:80]}")
                if captured["url"]:
                    return captured["url"]
                if "chrome-error" in url and captured["url"]:
                    return captured["url"]
                if self.is_choose_account_page(info):
                    try:
                        self.choose_existing_account(opts.get("phone", ""), opts.get("fullName", ""), "[OAuth]")
                    except Exception as exc:
                        raise RuntimeError(f"停在选择账号页，但自动选择失败: {exc}") from exc
                    last_url = ""
                    continue
                if "/choose-an-account" in url:
                    raise RuntimeError("停在 choose-an-account，但页面识别失败，已阻止误点普通继续按钮")
                if url == last_url:
                    continue
                if login_method == "email" and any("email" in b.lower() or "邮箱" in b or "电子邮件" in b for b in buttons):
                    self.click_button_by_text(["电子邮件地址登录", "邮箱登录", "email"], 10000)
                    last_url = url
                    continue
                if login_method != "email" and any("phone" in b.lower() or "手机" in b or "电话号码" in b for b in buttons):
                    self.click_button_by_text(["使用电话号码继续", "继续使用手机登录", "手机登录", "Continue with phone number", "Continue with phone"], 10000)
                    last_url = url
                    continue
                if login_method == "email" and any(i["type"] == "email" or i["name"] in {"email", "username", "identifier"} for i in info["inputs"]):
                    target = self.page.locator('input[type="email"], input[name="email"], input[name="username"], input[name="identifier"], input[type="text"]').first
                    target.click(click_count=3, timeout=10000)
                    target.type(opts["email"], delay=35)
                    self.click_submit_button()
                    self.wait_for_cloudflare(30000)
                    last_url = url
                    continue
                if any(i["name"] == "phoneNumberInput" or i["type"] == "tel" for i in info["inputs"]):
                    country = opts.get("phoneCountry") or {}
                    self.select_country(country.get("dialCode", ""), country.get("name", ""), country.get("isoCode", ""))
                    local = self.get_local_phone_number(opts["phone"], country)
                    self.enter_phone(local)
                    last_url = url
                    continue
                if "password" in url or any(i["type"] == "password" for i in info["inputs"]):
                    self.fill_password(opts["password"])
                    self.page.keyboard.press("Enter")
                    sleep(1)
                    self.click_submit_button()
                    self.wait_for_cloudflare(30000)
                    last_url = url
                    continue
                if "about-you" in url or "about_you" in url:
                    self.fill_about_you_and_submit(opts.get("fullName") or opts["email"], opts.get("age") or 30, opts.get("birthDate", ""), "[OAuth]")
                    last_url = url
                    continue
                if "add-email" in url or "add_email" in url:
                    target = self.page.locator('input[type="email"], input[name="email"], input[type="text"]').first
                    target.click(click_count=3, timeout=10000)
                    target.type(opts["email"], delay=35)
                    self.click_submit_button()
                    self.wait_for_cloudflare(30000)
                    email_bound = True
                    last_url = url
                    continue
                if "email-verification" in url or (login_method == "email" and re.search(r"code|verification|验证码", text, re.I)):
                    code = opts["onEmailCodeNeeded"]()
                    self.enter_code(code)
                    email_bound = True
                    last_url = url
                    continue
                if opts.get("stopAfterEmailBound") and email_bound and ("add-email" not in url and "email-verification" not in url):
                    return "EMAIL_BOUND"
                if "contact-verification" in url:
                    code = opts["onSmsNeeded"]()
                    self.enter_code(code)
                    last_url = url
                    continue
                clicked = self.page.evaluate(
                    """() => {
                        const skip = ['Google', 'Apple', 'Microsoft', '邮件', '邮箱', '手机', 'email', 'phone'];
                        for (const b of document.querySelectorAll('button')) {
                            const text = (b.innerText || '').trim();
                            if (!text || text.length > 12) continue;
                            if (skip.some(s => text.includes(s))) continue;
                            if (['Allow', '授权', '允许', '同意', 'Continue', '继续'].some(s => text.includes(s))) {
                                b.click();
                                return text;
                            }
                        }
                        return '';
                    }"""
                )
                if clicked:
                    print(f"[OAuth] 点击了「{clicked}」")
                    last_url = url
            raise RuntimeError("OAuth 登录+授权超时")
        finally:
            try:
                self.page.remove_listener("request", on_request)
            except Exception:
                pass

    def login_and_complete_profile(self, opts: dict):
        print("[Phase1.5] 导航到 chatgpt.com...")
        self.page.goto("https://chatgpt.com", wait_until="domcontentloaded", timeout=60000)
        self.wait_for_cloudflare()
        sleep(5)
        body = self._body_text()
        if "登录" not in body and "Log in" not in body:
            print("[Phase1.5] 看起来已经处于登录状态")
            return True
        try:
            self.click_button_by_text(["登录", "Log in"], 10000)
            self.wait_for_text(["登录或注册", "Log in or sign up"], 15000)
            self.click_button_by_text(["使用电话号码继续", "继续使用手机登录", "手机登录", "Continue with phone number", "Continue with phone"], 10000)
            country = opts.get("phoneCountry") or {}
            self.select_country(country.get("dialCode", ""), country.get("name", ""), country.get("isoCode", ""))
            self.enter_phone(self.get_local_phone_number(opts["phone"], country))
            for _ in range(15):
                sleep(3)
                info = self.page_info()
                if "chatgpt.com" in info["url"] and "auth.openai.com" not in info["url"]:
                    return True
                if self.is_choose_account_page(info):
                    self.choose_existing_account(opts.get("phone", ""), opts.get("fullName", ""), "[Phase1.5]")
                    continue
                if any(i["type"] == "password" for i in info["inputs"]):
                    self.fill_password(opts["password"])
                    self.click_submit_button()
                    continue
                if "about-you" in info["url"] or "你的年龄是多少" in info["text"]:
                    self.fill_about_you_and_submit(opts["fullName"], opts.get("age") or 30, opts.get("birthDate", ""), "[Phase1.5]")
            return False
        except Exception as exc:
            print(f"[Phase1.5] 登录资料补全失败: {exc}")
            return False
