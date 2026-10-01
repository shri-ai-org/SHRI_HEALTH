"""
Which speech model can run live on the shri-ai.org server (4 CPU cores, no GPU)?

Runs a candidate engine over real Tamil speech (Google FLEURS ta_in test, CC BY 4.0)
with the server's thread count, and reports:
  · RTF — decode time ÷ audio duration (under 1 keeps up with speech; ≤ 0.5 leaves room)
  · chrF — the English it produced against FLEURS's own English sentence for the same id

Usage:
  python -m tools.bench whisper:small whisper:medium indic:ctc indic:rnnt --clips 12 --threads 4

For the Indic engine it also reports CER — the Tamil it heard against FLEURS's own
Tamil transcript — so hearing and translating can be judged apart.
"""

import argparse
import csv
import os
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

DATA = Path(__file__).resolve().parents[2] / 'backend-data' / 'fleurs'


def load_pairs(n: int):
    """(wav path, Tamil transcript, English reference) for the first n test clips with an English twin."""
    en = {}
    with open(DATA / 'en_test.tsv', encoding='utf-8') as f:
        for row in csv.reader(f, delimiter='\t'):
            en.setdefault(row[0], row[2])
    out = []
    with open(DATA / 'ta_test.tsv', encoding='utf-8') as f:
        for row in csv.reader(f, delimiter='\t'):
            wav = DATA / 'test' / row[1]
            if row[0] in en and wav.exists():
                out.append((wav, row[2], en[row[0]]))
            if len(out) >= n:
                break
    return out


def whisper_engine(size: str, threads: int, beam: int):
    from faster_whisper import WhisperModel

    model = WhisperModel(size, device='cpu', compute_type='int8', cpu_threads=threads)

    def run(audio: np.ndarray) -> str:
        segs, _ = model.transcribe(audio, task='translate', language='ta', beam_size=beam, vad_filter=False, condition_on_previous_text=False)
        return ' '.join(s.text.strip() for s in segs)

    return run


def indic_engine(decoder: str, threads: int):
    os.environ['ASR_INDIC_DECODER'] = decoder
    from asr.engines.indic import IndicEngine

    eng = IndicEngine()
    heard: list[str] = []

    def run(audio: np.ndarray) -> str:
        tamil = eng.hear(audio)
        heard.append(tamil)
        return eng.translate(tamil, final=True)

    run.heard = heard
    return run


def cer(hyp: str, ref: str) -> float:
    a, b = hyp.replace(' ', ''), ref.replace(' ', '')
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1] / max(1, len(b))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('engines', nargs='+', help='whisper:small, whisper:medium, whisper:large-v3')
    ap.add_argument('--clips', type=int, default=12)
    ap.add_argument('--threads', type=int, default=4)
    ap.add_argument('--beam', type=int, default=1)
    args = ap.parse_args()
    os.environ['ASR_THREADS'] = str(args.threads)  # read by config.py, which the engines import

    import sacrebleu

    pairs = load_pairs(args.clips)
    print(f'{len(pairs)} clips, {args.threads} threads, beam {args.beam}', flush=True)
    for spec in args.engines:
        kind, name = spec.split(':', 1)
        t0 = time.time()
        run = whisper_engine(name, args.threads, args.beam) if kind == 'whisper' else indic_engine(name, args.threads) if kind == 'indic' else sys.exit(f'unknown engine {kind}')
        load = time.time() - t0
        rtfs, hyps, refs = [], [], []
        for wav, _ta, en in pairs:
            audio, sr = sf.read(wav, dtype='float32')
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            assert sr == 16000, sr
            t = time.time()
            hyp = run(audio)
            rtfs.append((time.time() - t) / (len(audio) / sr))
            hyps.append(hyp)
            refs.append(en)
        chrf = sacrebleu.corpus_chrf(hyps, [refs]).score
        heard = getattr(run, 'heard', None)
        c = f' · Tamil CER {statistics.mean(cer(h, ta) for h, (_, ta, _) in zip(heard, pairs)) * 100:.1f}%' if heard else ''
        print(f'\n== {spec}: load {load:.1f}s · RTF median {statistics.median(rtfs):.2f} (max {max(rtfs):.2f}) · chrF {chrf:.1f}{c}', flush=True)
        if heard:
            print(f'   heard: {heard[0][:140]}\n   Tamil: {pairs[0][1][:140]}')
        for h, r in list(zip(hyps, refs))[:3]:
            print(f'   hyp: {h[:140]}\n   ref: {r[:140]}')


if __name__ == '__main__':
    main()
