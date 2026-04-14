"""LINE Webhook 安全驗證工具。"""

import base64
import hashlib
import hmac


class LineSignatureValidator:
    """負責驗證 LINE Webhook `X-Line-Signature`。"""

    def __init__(self, channel_secret: str) -> None:
        self.channel_secret = channel_secret.encode("utf-8")

    def validate(self, raw_body: bytes, signature: str | None) -> bool:
        """驗證簽章是否與 request body 相符。"""

        if not signature:
            return False

        digest = hmac.new(self.channel_secret, raw_body, hashlib.sha256).digest()
        expected_signature = base64.b64encode(digest).decode("utf-8")
        return hmac.compare_digest(signature, expected_signature)
