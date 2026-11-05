# Model shortlist: AI-01 note drafting and AI-02 chart summaries

**Status:** a research note for choosing what to benchmark. Sources were read on 2 November 2026; the two model cards' licence fields were read again on 5 November 2026.

**Candidates for the first benchmark (Vimal, 2026-11-05):** **MedGemma 1.5 4B** (`google/medgemma-1.5-4b-it`) is the primary candidate and **Qwen 3.5 4B** (`Qwen/Qwen3.5-4B`) the fallback. This picks what to benchmark first, not the model: the choice is made on the harness's scores (`ai/eval/RUNNING.md`). **MedGemma can't be served, even for the benchmark, until Sena records its licence exception** (below).

## What this covers

- **The job:** one small LLM, served by vLLM on one GPU, drafts a note from a visit transcript (AI-01) and summarizes a chart (AI-02). faster-whisper does speech on the same GPU.
- **The licence rule (D75):**
  - Weights must be Apache-2.0 or MIT.
  - Gemma-family terms do not pass. Gemma 4 needs a check first (see the table).
  - MedGemma needs a line in the licence exceptions register. D75 has not granted that line.
  - **The two candidates' licences, from their model cards** (Hugging Face, read 2026-11-05):
    - `google/medgemma-1.5-4b-it`: `license: other`, `license_name: health-ai-developer-foundations`, terms at <https://developers.google.com/health-ai-developer-foundations/terms>; gated (accept the terms to download). **Not on the D75 allowlist: it needs Sena's exception in the register first.**
    - `Qwen/Qwen3.5-4B`: `license: apache-2.0` (its `LICENSE` file). On the D75 allowlist.
- **The next step:** run each candidate the shortlist keeps through the evaluation harness (`ai/eval`, `python -m shri_eval --endpoint … --model …`) and pick on its scores (guide Step 7.7).

## How to read the numbers

**Read on a source.** Each of these comes from the model's own pages:

- licence;
- parameter count;
- context length;
- weights on disk;
- the attention layout in `config.json`;
- vLLM notes.

For a repo id `<id>`, the pages are:

- **Card:** `https://huggingface.co/<id>`
- **Config:** `https://huggingface.co/<id>/raw/main/config.json`
- **Hub API:** `https://huggingface.co/api/models/<id>?blobs=true`. It gives the licence metadata, `safetensors.total` (the parameter count) and the file sizes.

**Derived.** Columns marked "(derived)" are arithmetic on the sourced figures, not published numbers:

- **Weight memory:** parameters × 2 bytes at BF16, × 1 byte at 8-bit, × 0.5 bytes at 4-bit. These are weights only. Real quantized checkpoints keep some layers at higher precision. vLLM also needs room for activations, CUDA graphs and the CUDA context; none of that is counted here.
- **KV cache at BF16:**
  - per token = 2 (K and V) × full-attention layers × KV heads × head dimension × 2 bytes;
  - for 8k context, that × 8,192 tokens, for one sequence;
  - for 32k context, that × 32,768 tokens, for one sequence.
- **FP8 KV cache** (`kv_cache_dtype="fp8"`) is half that ([vLLM: Quantized KV cache](https://docs.vllm.ai/en/latest/features/quantization/quantized_kvcache.html)).
- **Hybrid models** (Qwen3.5, Granite 4.0-H, gpt-oss): only their full-attention layers grow with context. The fixed linear-attention, Mamba or sliding-window state comes on top and was not computed.

GB means 10⁹ bytes.

## Shortlist summary

| Model (repo id) | Licence (card metadata) | Params | Weights BF16 / 8-bit / 4-bit, GB (derived) | KV per sequence, BF16, 8k / 32k, GB (derived) | Native context | vLLM | Verdict |
|---|---|---|---|---|---|---|---|
| Qwen/Qwen3-8B | apache-2.0 | 8.2B | 16.4 / 8.2 / 4.1 | 1.21 / 4.83 | 32,768 (131,072 with YaRN) | card: `vllm>=0.8.5` | **Benchmark first.** Mature vLLM support; vendor FP8 and AWQ builds. Turn thinking off (`enable_thinking: false`) |
| Qwen/Qwen3-4B-Instruct-2507 | apache-2.0 | 4.0B | 8.0 / 4.0 / 2.0 | 1.21 / 4.83 | 262,144 | card: `vllm>=0.8.5` | **Benchmark first.** Small, non-thinking only; vendor FP8 build |
| Qwen/Qwen3.5-9B | apache-2.0 | 9.7B | 19.3 / 9.7 / 4.8 | 0.27 / 1.07 (+ linear-attention state) | 262,144 | card: vLLM nightly, `--language-model-only` | **Benchmark.** Small KV cache (8 of 32 layers are full attention). Multimodal architecture and thinking by default. No vendor FP8 build |
| Qwen/Qwen3.5-4B | apache-2.0 | 4.7B | 9.3 / 4.7 / 2.3 | 0.27 / 1.07 (+ state) | 262,144 | as Qwen3.5-9B | **Benchmark** (the guide's Qwen3.5-4B). No vendor FP8 build |
| ibm-granite/granite-4.2-8b | apache-2.0 | 8.8B | 17.6 / 8.8 / 4.4 | 1.34 / 5.37 | 128K (extension to 512K) | card: "requires vLLM v0.20+" (reasoning parser) | **Benchmark.** Dense model; vendor fp8, mxfp4 and nvfp4 builds |
| microsoft/Phi-4-mini-instruct | mit | 3.8B | 7.7 / 3.8 / 1.9 | 1.07 / 4.29 | 128K | card: `vllm>=0.7.3` | **Benchmark** as the small baseline. No vendor FP8 or AWQ build |
| mistralai/Ministral-3-8B-Instruct-2512 | apache-2.0 | 8.9B (8.4B LM + 0.4B vision) | 17.8 / 8.9 / 4.5 (published as FP8: 10.42 GB) | 1.14 / 4.56 | 256k | card: `vllm >= 0.12.0` | **Reserve.** Card: fits "in 12GB of VRAM in FP8" |
| openai/gpt-oss-20b | apache-2.0 (+ usage policy file) | 20.9B (3.6B active, MoE) | native MXFP4: 13.76 GB on disk | 0.20 / 0.81 (+ 128-token sliding window) | 131,072 in `max_position_embeddings`; card states none | card: `vllm==0.10.1+gptoss` wheel | **Reserve.** Card: "run within 16GB of memory". Reasoning model with its own chat format |
| Qwen/Qwen3-14B | apache-2.0 | 14.8B | 29.5 / 14.8 / 7.4 | 1.34 / 5.37 | 32,768 (131,072 YaRN) | card: `vllm>=0.8.5` | **Reserve** for a 48 GB card at 8-bit, if the 8B models fall short |
| mistralai/Ministral-3-14B-Instruct-2512 | apache-2.0 | 13.9B | 27.9 / 13.9 / 7.0 (FP8 on disk: 15.73 GB) | 1.34 / 5.37 | 256k | card: `vllm >= 0.12.0` | **Reserve.** Card: fits "in 24GB of VRAM in FP8" |
| microsoft/phi-4 | mit | 14.7B | 29.3 / 14.7 / 7.3 | 1.68 / (n/a) | 16K | none on card | **Reserve.** 16K context limits long visits and charts |
| mistralai/Mistral-Small-3.2-24B-Instruct-2506 | apache-2.0 | 24.0B | 48.0 / 24.0 / 12.0 | 1.34 / 5.37 | 128k (3.1 card) | card: `vLLM >= 0.9.1`; "~55 GB of GPU RAM in bf16" | **Out** for one GPU with Whisper, except quantized on 48 GB |
| google/gemma-4-E4B-it, gemma-4-12B-it | apache-2.0 (link: ai.google.dev/gemma/docs/gemma_4_license) | 8.0B with embeddings; 12.0B | 16.0; 23.9 at BF16 | not computed (shared and unified K/V layers) | 128K; 256K | supported-models page lists `Gemma4…ForConditionalGeneration` | **Hold.** The metadata says Apache-2.0, but the licence page links separate Gemma terms of use and prohibited-use pages. Whether those apply was not verified, so it needs a D75 check before any use |
| google/medgemma-1.5-4b-it | other: `health-ai-developer-foundations` | 4.3B (4,300,079,472) | 8.6 / 4.3 / 2.2 | — | — | — | **Primary candidate** (Vimal, 2026-11-05), served only once Sena's D75 exception is in the register |
| google/medgemma-4b-it, medgemma-27b-text-it | other: `health-ai-developer-foundations` | 4.3B; 27.0B | — | — | — | — | Not benchmarked (the 1.5 4B supersedes the 4B; the 27B doesn't fit one 24 GB card) |
| google/gemma-3-4b-it, gemma-3-12b-it | `gemma` | — | — | — | — | — | **Excluded** (D75) |
| meta-llama/Llama-3.1-8B-Instruct | `llama3.1` | 8.0B | — | — | — | — | **Excluded** (D75) |
| mistralai/Ministral-8B-Instruct-2410 | other: `mrl` (Mistral AI Research License) | 8.0B | — | — | — | — | **Excluded** (D75) |

**Also seen, not shortlisted.** All are Apache-2.0:

- **SmolLM3-3B:** 3.1B, 64k native. vLLM runs it only through the Transformers backend.
- **Olmo-3-7B-Instruct:** no GQA, so a large KV cache. Transformers backend only.
- **Granite 4.0-H tiny:** hybrid Mamba MoE, 7B total and 1B active.
- **Qwen3.5-27B, Qwen3.6-27B and Qwen3.8-27B:** about 55.6 GB at BF16. Too big for one GPU shared with Whisper, except at 8-bit on 80 GB.

### The architecture figures behind the KV column

From each model's `config.json`.

| Model | Architecture | Full-attention layers | KV heads | Head dim | KV per token, BF16 (derived) |
|---|---|---|---|---|---|
| Qwen3-4B, Qwen3-4B-2507 and Qwen3-8B | Qwen3ForCausalLM | 36 | 8 | 128 | 144 KiB |
| Qwen3-14B | Qwen3ForCausalLM | 40 | 8 | 128 | 160 KiB |
| Qwen3.5-4B and Qwen3.5-9B | Qwen3_5ForConditionalGeneration | 8 of 32 (24 Gated DeltaNet) | 4 | 256 | 32 KiB |
| granite-4.2-8b | GraniteForCausalLM | 40 | 8 | 128 | 160 KiB |
| Phi-4-mini-instruct | Phi3ForCausalLM | 32 | 8 | 128 | 128 KiB |
| phi-4 | Phi3ForCausalLM | 40 | 10 | 128 | 200 KiB |
| Ministral-3-8B | Mistral3ForConditionalGeneration | 34 | 8 | 128 | 136 KiB |
| Ministral-3-14B and Mistral-Small-3.2 | Mistral3ForConditionalGeneration | 40 | 8 | 128 | 160 KiB |
| gpt-oss-20b | GptOssForCausalLM | 12 of 24 (12 sliding, window 128) | 8 | 64 | 24 KiB |

**vLLM support.** The vLLM supported-models page ([docs](https://docs.vllm.ai/en/latest/models/supported_models.html); [source](https://raw.githubusercontent.com/vllm-project/vllm/main/docs/models/supported_models.md)) lists:

- **Natively:** `Qwen3ForCausalLM`, `Qwen3MoeForCausalLM`, `Phi3ForCausalLM`, `MistralForCausalLM`, `GraniteForCausalLM`, `GraniteMoeHybridForCausalLM` and `GptOssForCausalLM`.
- **In the multimodal table:** `Qwen3_5ForConditionalGeneration`, `Mistral3ForConditionalGeneration` and `Gemma4ForConditionalGeneration`.

The latest vLLM release is v0.32.0, of 18 October 2026 ([GitHub releases](https://api.github.com/repos/vllm-project/vllm/releases/latest)).

## Speech: faster-whisper

**Recommendation:** faster-whisper with `large-v3-turbo` on the GPU, at `float16` or `int8_float16`.

**Alternatives:**

- `distil-large-v3` if the pilot is English-only.
- `large-v3` if the benchmark shows turbo's word error rate is not good enough.

Silero VAD is on, through faster-whisper's `vad_filter=True`.

| Item | Licence | Size | Notes | Source |
|---|---|---|---|---|
| faster-whisper (CTranslate2 runtime) | MIT | — | Latest release v1.2.1 (2025-10-31). Needs CUDA 12 and cuDNN 9 | [LICENSE](https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/LICENSE), [README](https://github.com/SYSTRAN/faster-whisper) |
| openai/whisper-large-v3-turbo | mit | 809M params; 1.62 GB | Multilingual. The card: "decoding layers … reduced from 32 to 4" | [card](https://huggingface.co/openai/whisper-large-v3-turbo) |
| openai/whisper-large-v3 | apache-2.0 | 1,550M params; 3.09 GB | Multilingual | [card](https://huggingface.co/openai/whisper-large-v3) |
| distil-whisper/distil-large-v3 | mit | 756M params; 1.51 GB | English only | [card](https://huggingface.co/distil-whisper/distil-large-v3) |
| Silero VAD | MIT | — | faster-whisper loads `silero_vad_v6.onnx`, which needs onnxruntime | [LICENSE](https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE), [vad.py](https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/faster_whisper/vad.py) |

**Pin the turbo weights by explicit repo and revision.** faster-whisper's `turbo` name maps to `mobiuslabsgmbh/faster-whisper-large-v3-turbo` ([utils.py](https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/faster_whisper/utils.py)). That repo now redirects to `dropbox-dash/faster-whisper-large-v3-turbo`.

### Memory and speed

The faster-whisper README benchmarks only **large-v2**, on an RTX 3070 Ti 8 GB with 13 minutes of audio and beam size 5:

| Precision | Batch size | Time | VRAM |
|---|---|---|---|
| fp16 | — | 1m03s | 4,525 MB |
| fp16 | 8 | 17s | 6,090 MB |
| int8 | — | 59s | 2,926 MB |
| int8 | 8 | 16s | 4,500 MB |

The README publishes no large-v3 or turbo figures. Turbo has about half large-v3's parameters (809M against 1,550M) and 4 decoder layers instead of 32, so the large-v2 numbers are a reasonable upper bound for planning. That is an inference, not a measurement. Measure turbo on the chosen GPU.

## GPU sizing

**Recommendation (2026-11-05): one 24 GB card of the L4 class** (AWS `g6.xlarge` or `g6.2xlarge`, 1 × L4). It holds **one** 4B model at BF16 (MedGemma 1.5 4B 8.6 GB, or Qwen 3.5 4B 9.3 GB), Whisper and a few concurrent requests. **Both candidates loaded side by side need 48 GB**; that is only for a side-by-side benchmark, which can also run one model at a time on the 24 GB card. An 8–9B model at BF16 is no longer the plan, so a 48 GB L40S is not the minimum.

The arithmetic for one 4B model on 24 GB: about 6 GB for Whisper and the CUDA context leaves about 17 GB for vLLM (`--gpu-memory-utilization` about 0.7); the weights take 8.6 to 9.3 GB, leaving about 8 GB of KV cache, enough for a few concurrent requests of a visit transcript's length. Two 4B models (about 18 GB of weights together) plus Whisper exceed 24 GB.

**Reasoning, for one pilot clinic.** The card holds one LLM, its KV cache and Whisper together.

- **Whisper's share:**
  - The README's large-v2 measurement is 4.5 GB at fp16, and 6.1 GB batched.
  - Turbo should need no more.
  - Reserve about 6 GB for Whisper and the CUDA context.
- **vLLM must be capped to make room for Whisper.**
  - vLLM pre-allocates a fraction of GPU memory for weights and KV cache.
  - The default is 0.92 in v0.32.0, and 0.9 up to v0.19.0 ([cache.py v0.32.0](https://raw.githubusercontent.com/vllm-project/vllm/v0.32.0/vllm/config/cache.py)).
  - So vLLM must run with a lower `--gpu-memory-utilization` to leave Whisper its share.

**What fits on each card** (derived from the tables above):

| GPU | What fits |
|---|---|
| **24 GB** (L4 or A10G) | About 17 GB left for vLLM. That fits Qwen3-4B-2507 at BF16 (8.0 GB) with room for several 32k sequences (4.8 GB each). It also fits an 8B model only at 8-bit (8.2 to 8.9 GB weights) with two or three 32k sequences. An 8B at BF16 (16.4 to 17.8 GB) leaves almost nothing for the KV cache |
| **48 GB** (L40S) | About 41 GB left. Any 8B to 9B candidate runs at BF16, so the benchmark compares the models themselves and not quantization effects, with room for several concurrent 32k sequences. A 14B model at 8-bit (13.9 to 14.8 GB) also fits, if the 8B models fall short |

**Memory bandwidth** caps how fast tokens are generated:

| GPU | Bandwidth | Source |
|---|---|---|
| L4 | 300 GB/s | [NVIDIA L4](https://www.nvidia.com/en-us/data-center/l4/) |
| A10 | 600 GB/s | [NVIDIA A10](https://www.nvidia.com/en-us/data-center/products/a10-gpu/) |
| L40S | 864 GB/s | [NVIDIA L40S](https://www.nvidia.com/en-us/data-center/l40s/) |

**AWS instances:**

| Instance | GPU | GPU memory | Source |
|---|---|---|---|
| `g6.xlarge` | 1 × L4 | 24 GB | [AWS G6](https://aws.amazon.com/ec2/instance-types/g6/) |
| `g5.xlarge` | 1 × A10G | 24 GB | [AWS G5](https://aws.amazon.com/ec2/instance-types/g5/) |
| `g6e.xlarge` | 1 × L40S | 48 GB | [AWS G6e](https://aws.amazon.com/ec2/instance-types/g6e/) |

### Paragraph for Thulasi

> **GPU for the pilot (AI-01 notes, AI-02 summaries, speech), updated 2026-11-05:** one 24 GB L4-class card (AWS g6.xlarge or g6.2xlarge), running vLLM with one 4B model and faster-whisper side by side. Candidates: MedGemma 1.5 4B (primary, once Sena's D75 exception is recorded) and Qwen 3.5 4B (fallback, Apache-2.0). Both loaded at once would need 48 GB; that isn't needed.
>
> - **Whisper:** large-v3-turbo needs about 4.5 to 6 GB. That is the faster-whisper README's large-v2 figure, which turbo should not exceed. Cap vLLM with `--gpu-memory-utilization` so Whisper keeps its share; vLLM 0.32 otherwise takes 92%.
> - **The LLM:** one 4B model at BF16 (8.6 to 9.3 GB of weights) with about 8 GB of KV cache, enough for a few concurrent requests.
> - **Bandwidth:** the L4's 300 GB/s makes generation slower than a 48 GB L40S (864 GB/s); the benchmark measures whether a 4B model's latency is acceptable on it.
> - **Sources and arithmetic:** `ai/docs/MODEL_SHORTLIST.md`.
> - **Still to measure on the card:** Whisper turbo's real footprint and both models' latency.

## Before anything is installed

None of these components is in a lockfile. Each one comes in through a reviewed pull request that changes the lockfile, follows the 7-day rule and passes the licence check (CLAUDE.md, D75). The model server is a separate program on the GPU host (D75 "Scope").

| Component | What it is | Licence |
|---|---|---|
| vLLM | The model server | Not verified here |
| faster-whisper | Speech to text | MIT |
| CTranslate2 | faster-whisper's runtime | Not verified here |
| onnxruntime | Runs Silero VAD | Not verified here |
| Silero VAD | Voice-activity detection | MIT |

This note proposes them; it installs nothing.

## Not verified

- **Gemma 4:** whether the separate Gemma terms of use and prohibited-use pages apply.
- **faster-whisper:** the large-v3 and turbo memory and speed figures, which the README does not publish.
- **A10G:** its memory bandwidth (the AWS page gives none).
- **Model cards without a context length:** gpt-oss-20b, Mistral-7B-v0.3 and Olmo-3-7B. Only their `config.json` values were read.
- **Hybrid models:** how vLLM sizes the KV and state memory of Qwen3.5 (linear attention), Granite 4.0-H (Mamba) and Gemma 4 (shared K/V).
- **Qwen3.5 on a release build:** whether vLLM v0.32.0 runs it without the nightly wheel the card names.
- **Licences of the serving stack:** vLLM, CTranslate2 and onnxruntime.
- **Transcript length:** how many tokens a real 15-minute visit transcript takes. The harness reports prompt tokens per visit; use that to choose between 8k and 32k.
