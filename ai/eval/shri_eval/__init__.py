"""Shri Health AI evaluation harness (AI-01 note drafting).

Scores any OpenAI-compatible chat endpoint (vLLM's API) against the fictional visit set in
``ai/eval/data/visits/``. Standard library only (CLAUDE.md: no new dependencies), so it runs
in the backend's locked Python image and on the GPU host alike.

Synthetic data only: every visit is fictional. The harness never logs transcript or draft text;
those appear only in the report files it writes.
"""

PROMPT_VERSION = "note-draft-eval/1"
