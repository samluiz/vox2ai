import os

from openai import APIConnectionError, APIError, AuthenticationError, OpenAI, RateLimitError

from vox2ai.config import AssistantConfig
from vox2ai.errors import LLMError


class LLMClient:
    """OpenAI-compatible Chat Completions client.

    Reads credentials from the environment at call time so that
    the caller controls when the API key is resolved.
    """

    def __init__(self, config: AssistantConfig) -> None:
        self._config = config

    def complete(self, system_prompt: str, user_prompt: str) -> str:
        api_key = os.environ.get(self._config.api_key_env)
        if not api_key:
            raise LLMError(f"API key environment variable '{self._config.api_key_env}' is not set.")

        client = OpenAI(
            api_key=api_key,
            base_url=self._config.base_url,
            timeout=self._config.timeout_seconds,
        )

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
