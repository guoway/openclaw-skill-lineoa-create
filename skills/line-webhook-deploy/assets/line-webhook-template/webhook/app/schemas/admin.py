"""Admin API schemas。"""

from pydantic import BaseModel


class AnalyzeStyleResult(BaseModel):
    """單一 owner style 分析結果。"""

    owner_id: str
    total_messages_analyzed: int
    avg_sentence_length: int | None = None
    formality_level: int | None = None


class AnalyzeStyleResponse(BaseModel):
    """/admin/analyze-style 回應。"""

    success: bool
    owner_count: int
    results: list[AnalyzeStyleResult]
