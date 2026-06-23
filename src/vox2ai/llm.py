import base64
from collections.abc import Iterator
from pathlib import Path

from openai import APIConnectionError, APIError, AuthenticationError, OpenAI, RateLimitError

from vox2ai.config import AssistantConfig
from vox2ai.credentials import resolve_api_key
from vox2ai.errors import LLMError


class LLMClient:
    """OpenAI-compatible Chat Completions client.

    Reads credentials from the environment at call time so that
    the caller controls when the API key is resolved.
    """

    def __init__(self, config: AssistantConfig) -> None:
        self._config = config
        self._client: OpenAI | None = None

    def _get_client(self) -> OpenAI:
        if self._client is not None:
            return self._client
        api_key = resolve_api_key(self._config)
        if not api_key:
            raise LLMError(
                f"API key environment variable '{self._config.api_key_env}' is not set, "
                "and no API key is saved in Settings or config.toml."
            )
        self._client = OpenAI(
            api_key=api_key,
            base_url=self._config.base_url,
            timeout=self._config.timeout_seconds,
        )
        return self._client

    def complete(self, system_prompt: str, user_prompt: str) -> str:
        client = self._get_client()

        try:
            response = client.chat.completions.create(
                model=self._config.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=self._config.temperature,
            )
        except AuthenticationError as e:
            raise LLMError(f"Authentication failed (check API key): {e}") from e
        except RateLimitError as e:
            raise LLMError(f"Rate limited by provider: {e}") from e
        except APIConnectionError as e:
            raise LLMError(f"Could not connect to {self._config.base_url}: {e}") from e
        except APIError as e:
            raise LLMError(f"API error: {e}") from e

        content = response.choices[0].message.content
        if not content:
            raise LLMError("LLM returned an empty response.")

        return content

    def stream_complete(self, system_prompt: str, user_prompt: str) -> Iterator[str]:
        """Stream a Chat Completions response token by token.

        Yields content deltas as they arrive from the API.
        """
        client = self._get_client()

        try:
            stream = client.chat.completions.create(
                model=self._config.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=self._config.temperature,
                stream=True,
            )
        except AuthenticationError as e:
            raise LLMError(f"Authentication failed (check API key): {e}") from e
        except RateLimitError as e:
            raise LLMError(f"Rate limited by provider: {e}") from e
        except APIConnectionError as e:
            raise LLMError(f"Could not connect to {self._config.base_url}: {e}") from e
        except APIError as e:
            raise LLMError(f"API error: {e}") from e

        for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                yield delta.content

    def complete_with_image(
        self,
        system_prompt: str,
        user_prompt: str,
        image_path: Path,
        mime_type: str = "image/png",
    ) -> str:
        """Complete a vision-capable chat request with one local image.

        The call uses the OpenAI-compatible Chat Completions image content
        shape. Callers must only use this with models known to support vision.
        """
        client = self._get_client()
        try:
            data = base64.b64encode(image_path.read_bytes()).decode("ascii")
            response = client.chat.completions.create(
                model=self._config.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": user_prompt},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:{mime_type};base64,{data}"},
                            },
                        ],
                    },
                ],
                temperature=self._config.temperature,
            )
        except AuthenticationError as e:
            raise LLMError(f"Authentication failed (check API key): {e}") from e
        except RateLimitError as e:
            raise LLMError(f"Rate limited by provider: {e}") from e
        except APIConnectionError as e:
            raise LLMError(f"Could not connect to {self._config.base_url}: {e}") from e
        except APIError as e:
            raise LLMError(f"API error: {e}") from e

        content = response.choices[0].message.content
        if not content:
            raise LLMError("Vision model returned an empty response.")
        return content
