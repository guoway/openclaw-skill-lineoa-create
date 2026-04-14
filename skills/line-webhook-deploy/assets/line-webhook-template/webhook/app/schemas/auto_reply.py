"""Auto reply decision schemas。"""

from pydantic import BaseModel


class AutoReplyDecision(BaseModel):
    """描述是否應觸發 auto reply。"""

    should_reply: bool
    reason: str
    trigger_keyword: str | None = None
