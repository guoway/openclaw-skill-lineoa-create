"""Admin 維運服務。"""

import json
from collections import Counter

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.logging import format_log_context, get_logger
from app.repositories.messages import MessageRepository
from app.repositories.owner_styles import OwnerStyleRepository
from app.schemas.admin import AnalyzeStyleResult, AnalyzeStyleResponse
from app.services.llm_service import LlmService


logger = get_logger(__name__)


class AdminService:
    """封裝 owner style analysis 與 admin 維運邏輯。"""

    def __init__(self, settings: Settings, db: Session) -> None:
        self.settings = settings
        self.db = db
        self.message_repository = MessageRepository(db)
        self.owner_style_repository = OwnerStyleRepository(db)
        self.llm_service = LlmService(settings)

    async def analyze_owner_styles(self) -> AnalyzeStyleResponse:
        """分析所有 owner 的語氣，並寫回資料庫。"""

        results: list[AnalyzeStyleResult] = []
        for owner_user_id in self.settings.owner_user_ids:
            if not owner_user_id:
                continue
            try:
                analysis = await self._analyze_single_owner(owner_user_id)
                results.append(analysis)
            except Exception as exc:
                logger.exception(
                    "owner style analysis failed | %s",
                    format_log_context(owner_user_id=owner_user_id, error=str(exc)),
                )
                raise
        self.db.commit()
        return AnalyzeStyleResponse(success=True, owner_count=len(results), results=results)

    async def _analyze_single_owner(self, owner_user_id: str) -> AnalyzeStyleResult:
        """分析單一 owner 的語氣風格。"""

        messages = self.message_repository.list_recent_owner_messages(owner_user_id=owner_user_id, limit=500)
        if len(messages) < 10:
            record = self.owner_style_repository.upsert_analysis(
                owner_user_id=owner_user_id,
                avg_sentence_length=None,
                common_phrases=json.dumps([], ensure_ascii=False),
                emoji_usage_pattern="資料不足",
                punctuation_style="資料不足",
                formality_level=None,
                total_messages_analyzed=len(messages),
            )
            return AnalyzeStyleResult(
                owner_id=owner_user_id,
                total_messages_analyzed=record.total_messages_analyzed or 0,
                avg_sentence_length=record.avg_sentence_length,
                formality_level=record.formality_level,
            )

        texts = [item.content or "" for item in messages if item.content]
        joined = "\n---\n".join(texts)
        prompt = (
            "分析以下對話的語氣特徵，並以 JSON 格式回傳：\n\n"
            f"{joined[:3000]}\n\n"
            "請輸出 JSON：\n"
            "{\n"
            '  "avg_sentence_length": 數字,\n'
            '  "common_phrases": ["常用語1", "常用語2"],\n'
            '  "emoji_usage": "表情符號使用頻率描述",\n'
            '  "punctuation_style": "標點風格描述",\n'
            '  "formality_level": 1-5 數字\n'
            "}"
        )

        analysis_text = await self.llm_service.chat_completion([
            {"role": "user", "content": prompt}
        ], temperature=0.3, max_tokens=1000)

        parsed = self._parse_analysis_json(analysis_text)
        avg_sentence_length = parsed.get("avg_sentence_length") or self._estimate_avg_sentence_length(texts)
        common_phrases = parsed.get("common_phrases") or self._estimate_common_phrases(texts)
        emoji_usage = parsed.get("emoji_usage") or self._estimate_emoji_usage(texts)
        punctuation_style = parsed.get("punctuation_style") or self._estimate_punctuation_style(texts)
        formality_level = parsed.get("formality_level") or 3

        record = self.owner_style_repository.upsert_analysis(
            owner_user_id=owner_user_id,
            avg_sentence_length=int(avg_sentence_length) if avg_sentence_length is not None else None,
            common_phrases=json.dumps(common_phrases, ensure_ascii=False),
            emoji_usage_pattern=emoji_usage,
            punctuation_style=punctuation_style,
            formality_level=int(formality_level) if formality_level is not None else None,
            total_messages_analyzed=len(messages),
        )
        return AnalyzeStyleResult(
            owner_id=owner_user_id,
            total_messages_analyzed=record.total_messages_analyzed or 0,
            avg_sentence_length=record.avg_sentence_length,
            formality_level=record.formality_level,
        )

    def _parse_analysis_json(self, text: str) -> dict:
        """從 LLM 輸出解析 JSON。"""

        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return {}
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return {}

    def _estimate_avg_sentence_length(self, texts: list[str]) -> int:
        """用簡單規則估算平均句長。"""

        total_length = sum(len(text) for text in texts if text)
        count = max(len([text for text in texts if text]), 1)
        return max(1, round(total_length / count))

    def _estimate_common_phrases(self, texts: list[str]) -> list[str]:
        """用簡單詞頻估算常用語。"""

        counter: Counter[str] = Counter()
        for text in texts:
            stripped = text.strip()
            if 2 <= len(stripped) <= 12:
                counter[stripped] += 1
        return [item for item, _ in counter.most_common(5)]

    def _estimate_emoji_usage(self, texts: list[str]) -> str:
        """簡單估算 emoji 使用頻率。"""

        emoji_chars = sum(sum(1 for char in text if ord(char) > 10000) for text in texts)
        if emoji_chars == 0:
            return "幾乎不使用"
        if emoji_chars < 5:
            return "偶爾使用"
        return "經常使用"

    def _estimate_punctuation_style(self, texts: list[str]) -> str:
        """簡單估算標點風格。"""

        joined = "".join(texts)
        if "！" in joined or "!" in joined:
            return "偏活潑，常用驚嘆號"
        if "。" in joined:
            return "偏正式，常用句號"
        return "一般"
