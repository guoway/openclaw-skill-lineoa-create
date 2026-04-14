"""LLM 生成服務。"""

import json

import httpx

from app.core.config import Settings
from app.db.models.owner_style import OwnerStyle
from app.db.models.user_memory import UserMemory


class LlmService:
    """封裝 OpenAI-compatible chat completion 與回覆生成。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def chat_completion(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.7,
        max_tokens: int = 4000,
    ) -> str:
        """呼叫 OpenAI-compatible chat completions API。"""

        if not self.settings.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is not configured")

        base_url = self.settings.openai_base_url.rstrip("/")
        payload = {
            "model": self.settings.llm_model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        headers = {
            "Authorization": f"Bearer {self.settings.openai_api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(f"{base_url}/chat/completions", json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
            return data["choices"][0]["message"]["content"]

    async def generate_reply(
        self,
        *,
        user_question: str,
        rag_results: list[dict],
        owner_style: OwnerStyle | None,
        conversation_history: list[dict[str, str]],
        user_memory_text: str,
        learned_knowledge: list[dict],
    ) -> str:
        """依 Node.js 版 prompt 方向生成第一版回覆。"""

        context = "（無相關資料）"
        if rag_results:
            context = "\n\n".join(f"[{index + 1}] {item.get('content', '')}" for index, item in enumerate(rag_results))

        learned_context = ""
        if learned_knowledge:
            learned_context = "\n\n【Bot 學習到的知識】\n" + "\n".join(
                f"- {(item.get('title') or '').strip()}：{item.get('content', '')}" for item in learned_knowledge
            )

        style_prompt = ""
        if owner_style is not None:
            phrases = []
            if owner_style.common_phrases:
                try:
                    phrases = json.loads(owner_style.common_phrases)
                except json.JSONDecodeError:
                    phrases = []
            style_prompt = (
                "\n請模仿以下語氣風格回覆：\n"
                f"- 平均句長：{owner_style.avg_sentence_length or '中等'} 字\n"
                f"- 常用語：{'、'.join(phrases[:5]) if phrases else '無資料'}\n"
                f"- 正式程度：{owner_style.formality_level or 3}/5\n"
                f"- 標點風格：{owner_style.punctuation_style or '一般'}\n"
            )

        system_prompt = (
            "你是席爾克軟體的專業業務人員。請根據參考資料回答客戶的問題。\n\n"
            "**重要指示**：\n"
            "1. 你是在跟客戶對話，不是在跟內部同事對話\n"
            "2. 參考資料是內部文件，你需要轉化為對客戶友善的說明\n"
            "3. 不要直接引用內部備註，要改寫成客戶易懂的表達\n"
            "4. 如果資訊不明確，寧可說需要進一步確認，也不要猜測\n"
            "5. 你的公司名稱就是『席爾克軟體』，不要擅自增加別稱\n"
            "6. 回覆要專業、溫和、清楚，像公司的業務或客服\n"
            "7. 嚴格禁止捏造參考資料中不存在的資訊\n"
            f"{user_memory_text}"
            f"{style_prompt}"
            "回答要完整，但角度要是代表公司對外說明。"
        )

        messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
        if conversation_history:
            messages.extend(conversation_history)
        messages.append(
            {
                "role": "user",
                "content": (
                    "【參考資料】（這是內部文件，請轉化為對客戶友善的說明）\n"
                    f"{context}{learned_context}\n\n"
                    f"【客戶問題】\n{user_question}\n\n"
                    "請以業務人員角度，友善且專業地回答。不要直接引用內部備註；如果資料不足，請坦白表示需要進一步確認。"
                ),
            }
        )
        return await self.chat_completion(messages)

    async def generate_memory_summary(
        self,
        *,
        existing_memory: UserMemory | None,
        conversation_text: str,
        display_name: str | None,
    ) -> dict | None:
        """用 LLM 生成或更新用戶記憶摘要。"""

        if existing_memory is None:
            existing_summary = "（這是新用戶，尚無記憶）"
        else:
            existing_summary = json.dumps(
                {
                    "summary": existing_memory.summary,
                    "topics": self._safe_json_loads(existing_memory.topics, []),
                    "preferences": self._safe_json_loads(existing_memory.preferences, {}),
                    "status": existing_memory.status,
                    "visit_count": existing_memory.visit_count,
                },
                ensure_ascii=False,
                indent=2,
            )

        prompt = (
            "你是記憶管理員。根據以下對話內容，更新用戶的記憶摘要。\n\n"
            f"【現有摘要】\n{existing_summary}\n\n"
            f"【本次對話】\n{conversation_text}\n\n"
            "請輸出一個 JSON 物件，包含：\n"
            "- summary: 一段簡短摘要（100字內）\n"
            "- topics: 用戶關心主題（JSON 陣列）\n"
            "- preferences: 用戶偏好（JSON 物件）\n"
            "- status: 新訪客 / 潛在客戶 / 已成交 / 回頭客 其中一個\n"
            "- last_conversation_summary: 本次對話摘要（50字內）\n\n"
            "規則：\n"
            "1. 只保留有價值資訊，不要記錄閒聊\n"
            "2. 若本次沒有新資訊，可維持原摘要\n"
            "3. 合併歷史與本次資訊\n"
            "4. 只輸出 JSON，不要其他文字"
        )

        result = await self.chat_completion([
            {"role": "user", "content": prompt}
        ], temperature=0.3, max_tokens=1000)

        start = result.find("{")
        end = result.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        return json.loads(result[start : end + 1])

    async def analyze_learning_suggestions(self, *, conversation_text: str) -> list[dict]:
        """分析對話是否值得轉成 learned knowledge。"""

        prompt = (
            "你是知識管理員。請分析以下 Owner 親自回覆客戶的對話，判斷是否有值得 Bot 學習的通用知識。\n\n"
            f"{conversation_text}\n\n"
            "若有值得學習的內容，請只輸出 JSON：\n"
            "{\n"
            '  "suggestions": [\n'
            "    {\n"
            '      "title": "簡短標題",\n'
            '      "content": "完整知識內容",\n'
            '      "category": "FAQ/報價/技術/流程/其他"\n'
            "    }\n"
            "  ]\n"
            "}\n"
            "若沒有值得學習的內容，請輸出：{\"suggestions\": []}"
        )

        result = await self.chat_completion([
            {"role": "user", "content": prompt}
        ], temperature=0.3, max_tokens=1000)

        start = result.find("{")
        end = result.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return []
        try:
            parsed = json.loads(result[start : end + 1])
        except json.JSONDecodeError:
            return []
        suggestions = parsed.get("suggestions")
        return suggestions if isinstance(suggestions, list) else []

    @staticmethod
    def _safe_json_loads(value: str | None, default):
        """安全解析 JSON 字串。"""

        if not value:
            return default
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return default
