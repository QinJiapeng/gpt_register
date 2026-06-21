import re
import time
from typing import Any

import requests


class SMSProvider:
    def __init__(self, api_key: str, base_url: str = "https://hero-sms.com/stubs/handler_api.php", provider_name: str = "HeroSMS", status_action: str = "getStatusV2"):
        self.api_key = api_key
        self.base_url = base_url
        self.provider_name = provider_name
        self.status_action = status_action
        self.activation_id = None
        self.phone_number = None

    def request(self, action: str, **params) -> Any:
        response = requests.get(
            self.base_url,
            params={"api_key": self.api_key, "action": action, **params},
            timeout=30,
        )
        response.raise_for_status()
        try:
            return response.json()
        except Exception:
            return response.text.strip()

    @staticmethod
    def normalize_phone(value: str) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        return text if text.startswith("+") else f"+{text}"

    @staticmethod
    def parse_access_number(data: str):
        parts = str(data or "").split(":")
        if len(parts) < 3 or parts[0] != "ACCESS_NUMBER":
            return None
        return {"activationId": parts[1], "phoneNumber": SMSProvider.normalize_phone(parts[2])}

    @staticmethod
    def _num(value, default=None):
        try:
            return float(re.sub(r"[^0-9.]+", "", str(value)))
        except Exception:
            return default

    @staticmethod
    def _int(value, default=None):
        try:
            return int(re.sub(r"[^0-9-]+", "", str(value)))
        except Exception:
            return default

    def get_number_request_params(self, service: str, country: int) -> dict:
        return {"service": service, "country": country}

    def get_number(self, service: str = "dr", country: int = 33, max_retries: int = 10):
        for attempt in range(1, max_retries + 1):
            try:
                data = self.request("getNumberV2", **self.get_number_request_params(service, country))
            except Exception as exc:
                print(f"[SMS] API 请求失败: {exc} ({attempt}/{max_retries})")
                if attempt < max_retries:
                    time.sleep(5)
                    continue
                raise

            if isinstance(data, str):
                if data == "BAD_ACTION":
                    data = self.request("getNumber", **self.get_number_request_params(service, country))
                parsed = self.parse_access_number(data) if isinstance(data, str) else None
                if parsed:
                    self.activation_id = parsed["activationId"]
                    self.phone_number = parsed["phoneNumber"]
                    print(f"[SMS] 获取号码: {self.phone_number} (activation: {self.activation_id})")
                    return parsed
                if data == "NO_BALANCE":
                    raise RuntimeError(f"{self.provider_name} 余额不足")
                if data == "BAD_KEY":
                    raise RuntimeError(f"{self.provider_name} API Key 无效")
                if data == "NO_NUMBERS":
                    print(f"[SMS] 暂无可用号码，稍后重试... ({attempt}/{max_retries})")
                    if attempt < max_retries:
                        time.sleep(3)
                        continue
                    raise RuntimeError("当前无可用号码")
                raise RuntimeError(f"获取号码失败: {data}")

            activation_id = data.get("activationId") or data.get("activation_id") or data.get("id")
            phone_number = self.normalize_phone(data.get("phoneNumber") or data.get("phone_number") or data.get("number"))
            if not activation_id or not phone_number:
                raise RuntimeError(f"获取号码返回格式异常: {data}")
            self.activation_id = activation_id
            self.phone_number = phone_number
            print(f"[SMS] 获取号码: {self.phone_number} (activation: {self.activation_id})")
            return {"activationId": activation_id, "phoneNumber": phone_number}

        raise RuntimeError("获取号码失败: 重试耗尽")

    def set_status(self, status: int, label: str):
        result = self.request("setStatus", id=self.activation_id, status=status)
        print(f"[SMS] {label}: {result}")
        return result

    def mark_ready(self):
        return self.set_status(1, "已标记准备接收短信")

    def complete(self):
        return self.set_status(6, "激活已完成")

    def cancel(self):
        try:
            return self.set_status(8, "激活已取消")
        except Exception as exc:
            print(f"[SMS] 取消失败: {exc}")
            return None

    def get_status(self):
        data = self.request(self.status_action, id=self.activation_id)
        if isinstance(data, str):
            if data in {"STATUS_WAIT_CODE", "STATUS_WAIT_RETRY"} or data.startswith("STATUS_WAIT_RETRY:"):
                return {"received": False}
            if data.startswith("STATUS_OK:"):
                return {"received": True, "code": data.split(":", 1)[1]}
            if data == "STATUS_CANCEL":
                raise RuntimeError("短信激活已取消")
            return {"received": False}
        code = data.get("code") or data.get("smsCode") or data.get("sms_code") or data.get("text")
        if isinstance(data.get("sms"), dict):
            code = data["sms"].get("code") or code
        if code:
            match = re.search(r"\d{4,8}", str(code))
            return {"received": True, "code": match.group(0) if match else str(code)}
        return {"received": False}

    def poll_for_code(self, interval: int = 5, max_attempts: int = 36) -> str:
        for attempt in range(1, max_attempts + 1):
            print(f"[SMS] 等待短信验证码... ({attempt}/{max_attempts})")
            result = self.get_status()
            if result.get("received"):
                print(f"[SMS] 收到验证码: {result['code']}")
                return result["code"]
            time.sleep(interval)
        self.cancel()
        raise RuntimeError("短信验证码超时，已取消激活")

    def get_phone(self) -> str:
        return self.phone_number or ""


class SMSBowerProvider(SMSProvider):
    def __init__(self, api_key: str, base_url: str, max_price=None):
        super().__init__(api_key, base_url=base_url, provider_name="SMSBower", status_action="getStatus")
        self.max_price = max_price

    def get_number_request_params(self, service: str, country: int) -> dict:
        params = {"service": service, "country": country}
        if self.max_price:
            params["maxPrice"] = str(self.max_price)
        return params
