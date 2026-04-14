"""RAG 檢索服務。"""

from typing import Any

import httpx

from app.core.config import Settings


class RagService:
    """封裝向量檢索流程。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def get_embedding(self, text: str) -> list[float]:
        """使用 OpenAI-compatible embeddings 取得 query vector。"""

        if not self.settings.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is not configured")

        base_url = self.settings.openai_base_url.rstrip("/")
        payload = {
            "input": text,
            "model": self.settings.embedding_model,
        }
        headers = {
            "Authorization": f"Bearer {self.settings.openai_api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(f"{base_url}/embeddings", json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
            return data["data"][0]["embedding"]

    async def search_similar(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """從 Qdrant 搜尋相似知識片段，並套用與 Node 版一致的簡單 rerank。"""

        embedding = await self.get_embedding(query)
        candidate_limit = max(limit, 100)
        search_payload = {
            "vector": embedding,
            "limit": candidate_limit,
            "with_payload": True,
            "with_vector": False,
        }
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.settings.qdrant_url}/collections/{self.settings.qdrant_collection}/points/search",
                json=search_payload,
            )
            response.raise_for_status()
            data = response.json()

        results: list[dict[str, Any]] = []
        for point in data.get("result", []):
            payload = point.get("payload") or {}
            results.append(
                {
                    "id": point.get("id"),
                    "score": point.get("score", 0),
                    "content": payload.get("content", ""),
                    "source": payload.get("source", "unknown"),
                    "metadata": payload.get("metadata") or {},
                }
            )

        lowered_query = (query or "").lower()
        reranked: list[dict[str, Any]] = []
        for item in results:
            boosted_score = item["score"]
            source = (item.get("source") or "").lower()
            if "報價原則" in lowered_query and "報價原則" in source:
                boosted_score += 1.0
            elif (("原則" in lowered_query) or ("規則" in lowered_query)) and (("原則" in source) or ("規則" in source)):
                boosted_score += 0.5
            elif "報價" in lowered_query and "報價" in source:
                boosted_score += 0.3
            reranked.append({**item, "score": boosted_score})

        reranked.sort(key=lambda item: item["score"], reverse=True)
        return reranked[:limit]
