"""Regression tests for output sanitizer."""

import base64
from vox2ai.agent.sanitizer import sanitize_output, sanitize_answer, sanitize_chunk, _looks_like_protocol


class TestSanitizeOutput:
    def test_clean_text_passes_through(self):
        text = "Your system supports s2idle and S3 suspend modes."
        assert sanitize_output(text) == text

    def test_strips_tool_call_xml(self):
        text = "Result.\n\n<tool_calls>\n<invoke name=test>\n</invoke>\n</tool_call>"
        result = sanitize_output(text)
        assert "<tool_calls>" not in result
        assert "<invoke" not in result
        assert "Result" in result

    def test_strips_thinking_tags(self):
        text = "<thinking>I need to check this</thinking>The system is fine."
        result = sanitize_output(text)
        assert "<thinking>" not in result
        assert "The system is fine" in result

    def test_strips_scratchpad(self):
        text = "<scratchpad>internal notes</scratchpad>Final answer here."
        result = sanitize_output(text)
        assert "<scratchpad>" not in result
        assert "Final answer here" in result

    def test_strips_function_call_xml(self):
        text = "<function_calls>\n<function name=test>\n</function>\n</function_calls>\n\nResult."
        result = sanitize_output(text)
        assert "<function" not in result
        assert "Result" in result

    def test_strips_dsml_marker(self):
        text = "DSML protocol detected. The answer is 42."
        result = sanitize_output(text)
        assert "DSML" not in result
        assert "The answer is 42" in result

    def test_strips_working_memory_mention(self):
        text = "Based on working memory analysis, the answer is clear."
        result = sanitize_output(text)
        assert "working memory" not in result.lower()

    def test_strips_tool_registry_mention(self):
        text = "The tool registry shows 5 available tools."
        result = sanitize_output(text)
        assert "tool registry" not in result.lower()

    def test_strips_iteration_counter(self):
        text = "Iteration 3/10: checking logs..."
        result = sanitize_output(text)
        assert "Iteration" not in result

    def test_strips_exit_code(self):
        text = "exit_code: 0\nThe command succeeded."
        result = sanitize_output(text)
        assert "exit_code" not in result
        assert "The command succeeded" in result

    def test_strips_developer_prompt_reference(self):
        text = "According to DEVELOPER_PROMPT, I should..."
        result = sanitize_output(text)
        assert "DEVELOPER_PROMPT" not in result

    def test_returns_fallback_for_completely_stripped(self):
        b64 = base64.b64decode("PHRvb2xfY2FsbHM+PGZ1bmN0aW9uX2NhbGxzPjxmdW5jdGlvbj48cGFyYW1ldGVyPng8L3BhcmFtZXRlcj48L2Z1bmN0aW9uPjwvdG9vbF9jYWxscz4=").decode()
        result = sanitize_output(b64)
        assert len(result) < len(b64)

    def test_empty_text_returns_empty(self):
        assert sanitize_output("") == ""
        assert sanitize_output("   ") == "   "

    def test_normal_answer_preserved(self):
        text = "I checked the kernel logs and found a GPU driver issue."
        assert sanitize_output(text) == text


class TestLooksLikeProtocol:
    def test_json_object(self):
        assert _looks_like_protocol("{\"action\": \"tool\", \"tool\": \"bash\"}")

    def test_xml_tag(self):
        assert _looks_like_protocol("<tool_calls><invoke>")

    def test_code_fence(self):
        assert _looks_like_protocol("```json\n{}\n```")

    def test_normal_text(self):
        assert not _looks_like_protocol("The system is working correctly.")

    def test_empty(self):
        assert not _looks_like_protocol("")


class TestSanitizeChunk:
    def test_clean_chunk_passes(self):
        assert sanitize_chunk("Hello world") == "Hello world"

    def test_catches_tool_call_in_chunk(self):
        assert sanitize_chunk("<tool_calls>") == ""

    def test_catches_invoke_in_chunk(self):
        assert sanitize_chunk("<invoke>") == ""

    def test_normal_text_preserved(self):
        text = "Your system supports"
        assert sanitize_chunk(text) == text


class TestSanitizeAnswer:
    def test_clean_answer_passes(self):
        text = "I found the issue: your GPU driver needs updating."
        assert sanitize_answer(text) == text

    def test_strips_leaked_protocol_from_answer(self):
        text = "Answer.\n\n<tool_calls>\n<invoke name=test>\n</invoke>\n</tool_call>"
        result = sanitize_answer(text)
        assert "<tool_calls>" not in result
        assert "Answer" in result
