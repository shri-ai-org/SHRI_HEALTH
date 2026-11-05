# Running the AI-01 evaluation on a GPU

How to score candidate models with this harness once a GPU server exists. **This chooses no model.** The choice is made on the scores (guide Step 7.7) and within the licence rule (D75). Fictional visits only (`data/visits/`); no patient data ever goes to the endpoint.

## The two candidates named for the first run

| Candidate | Model ID | Licence | Status |
|---|---|---|---|
| MedGemma 1.5 4B (primary candidate) | `google/medgemma-1.5-4b-it` | Health AI Developer Foundations terms | **Needs Sena's exception first.** D75 allows it only through the licence exceptions register, and the register has no line for it. Don't serve it, even for an evaluation, until that line exists |
| Qwen 3.5 4B (fallback) | `Qwen/Qwen3.5-4B` | Apache-2.0 | Allowed by D75. Its card asks for vLLM nightly and `--language-model-only` (`docs/MODEL_SHORTLIST.md`) |

## Steps

1. **Serve the model with vLLM** on the GPU host, as an OpenAI-compatible endpoint. Leave memory for faster-whisper on the same card (`--gpu-memory-utilization` below 1; `docs/MODEL_SHORTLIST.md` has the sizing):

   ```bash
   vllm serve Qwen/Qwen3.5-4B --language-model-only --gpu-memory-utilization 0.6   # 0.6 is an example: size it per docs/MODEL_SHORTLIST.md
   ```

   For MedGemma, only after its register line exists, the same with `google/medgemma-1.5-4b-it` and without `--language-model-only`.
2. **Run the harness** from `ai/eval`, with the backend's locked Python environment (no new dependency):

   ```bash
   python -m shri_eval --endpoint http://gpu-host:8000/v1 --model Qwen/Qwen3.5-4B --out reports/qwen3.5-4b --no-thinking
   ```

   - `--no-thinking` applies to the Qwen family only.
   - Add `--json-mode` if the server supports `response_format`.
   - If the endpoint needs a key, pass `--api-key-env NAME`. The key stays in that environment variable and is never printed.
3. **Read the report:** `report.json` (every score and finding) and `summary.md` (numbers only, never transcript or draft text).

## The scores, per visit (0 to 1, higher is better)

| Score | Measures | In `overall` |
|---|---|---|
| `sectionCoverage` | Section completeness: the share of the reference's non-empty sections the draft fills | Yes (0.2) |
| `factRecall` | Key facts present: the share of the visit's `keyFacts` the draft keeps | Yes (0.25) |
| `invention` | Statements with no support in the transcript (a lexical floor) | Yes (0.25) |
| `medicalTerms` | Medical-term errors against the reference (misses, wrong terms, wrong doses) | Yes (0.15) |
| `format` | Valid JSON in the template's sections | Yes (0.15) |
| `editSimilarity` | Closeness to the reference note: 1 minus the word-level edit distance, divided by the longer note; per section in `findings.sectionEditSimilarity` | No: measured only, so `overall` stays comparable |

Compare models on the same visit set and the same `scoringVersion`. The numbers aren't absolute: the invention check is lexical (`shri_eval/scoring.py`).

## Tests

Without a GPU, the harness's own tests run against fixtures and a stub:

```bash
cd backend && pytest -c ../ai/pyproject.toml ../ai/eval/tests
```
