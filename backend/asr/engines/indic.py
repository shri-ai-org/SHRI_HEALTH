"""
The Indic pair — IndicConformer-600M (AI4Bharat) hears Tamil, IndicTrans2
(indic→en, distilled 200M) writes it in English. Both MIT, both gated on Hugging
Face (accept the terms once, `hf auth login`, then the models download into the
cache).

IndicConformer is loaded here directly from its ONNX parts and TorchScript
preprocessor — only the Tamil head, not all 22 languages, and without running the
repository's own Python. English words spoken inside Tamil come out in Tamil
script; asr/codemix.py puts the clinical ones back into English letters before
IndicTrans2 translates (பிபி → BP), which it reads far better. Unlike Whisper there is no
fixed 30-second window: decoding costs grow with the audio, so short partials are
cheap enough to run live on CPU.

  ASR_INDIC_DECODER   ctc (fast) | rnnt (slower, usually more accurate)   (default ctc)
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time

import numpy as np

from asr.codemix import restore_english
from config import SETTINGS

log = logging.getLogger('asr.indic')

CONFORMER = 'ai4bharat/indic-conformer-600m-multilingual'
TRANSLATOR = 'ai4bharat/indictrans2-indic-en-dist-200M'
LANG = 'ta'
BLANK_ID = 256
SOS = 256
RNNT_MAX_SYMBOLS = 10
PRED_LAYERS, PRED_HIDDEN = 2, 640


class IndicEngine:
    name = 'indic'

    def __init__(self):
        import onnxruntime as ort
        import torch
        from huggingface_hub import snapshot_download
        from IndicTransToolkit.processor import IndicProcessor
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        t = time.time()
        torch.set_num_threads(SETTINGS.threads)
        self.decoder = os.getenv('ASR_INDIC_DECODER', 'ctc')
        root = snapshot_download(CONFORMER, local_files_only=os.getenv('HF_HUB_OFFLINE') == '1')
        a = os.path.join(root, 'assets')
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = SETTINGS.threads
        opts.inter_op_num_threads = 1
        session = lambda name: ort.InferenceSession(os.path.join(a, f'{name}.onnx'), sess_options=opts, providers=['CPUExecutionProvider'])
        self.pre = torch.jit.load(os.path.join(a, 'preprocessor.ts'), map_location='cpu')
        self.encoder = session('encoder')
        self.ctc = session('ctc_decoder')
        if self.decoder == 'rnnt':
            self.rnnt = {n: session(n) for n in ['rnnt_decoder', 'joint_enc', 'joint_pred', 'joint_pre_net', f'joint_post_net_{LANG}']}
        with open(os.path.join(a, 'vocab.json'), encoding='utf-8') as f:
            self.vocab = json.load(f)[LANG]
        with open(os.path.join(a, 'language_masks.json'), encoding='utf-8') as f:
            self.mask = json.load(f)[LANG]

        self.tok = AutoTokenizer.from_pretrained(TRANSLATOR, trust_remote_code=True)
        self.mt = AutoModelForSeq2SeqLM.from_pretrained(TRANSLATOR, trust_remote_code=True).eval()
        self.ip = IndicProcessor(inference=True)
        self.lock = threading.Lock()
        self.torch = torch
        log.info('indic: conformer %s + %s, %d threads, loaded in %.1fs', self.decoder, TRANSLATOR, SETTINGS.threads, time.time() - t)

    # ---------------------------------------------------------------- Tamil speech → Tamil text
    def hear(self, audio: np.ndarray) -> str:
        torch = self.torch
        wav = torch.from_numpy(audio).unsqueeze(0)
        sig, length = self.pre(input_signal=wav, length=torch.tensor([wav.shape[-1]]))
        enc, enc_len = self.encoder.run(['outputs', 'encoded_lengths'], {'audio_signal': sig.numpy(), 'length': length.numpy()})
        return self._rnnt(enc) if self.decoder == 'rnnt' else self._ctc(enc)

    def _ctc(self, enc) -> str:
        logits = self.ctc.run(['logprobs'], {'encoder_output': enc})[0][0][:, self.mask]
        ids = np.argmax(logits, axis=-1)
        out, prev = [], None
        for i in ids:
            if i != prev and i != BLANK_ID:
                out.append(self.vocab[i])
            prev = i
        return ''.join(out).replace('▁', ' ').strip()

    def _rnnt(self, enc) -> str:
        r = self.rnnt
        joint_enc = r['joint_enc'].run(['output'], {'input': enc.transpose(0, 2, 1)})[0]
        hyp = [SOS]
        state = (np.zeros((PRED_LAYERS, 1, PRED_HIDDEN), dtype=np.float32), np.zeros((PRED_LAYERS, 1, PRED_HIDDEN), dtype=np.float32))
        for t in range(joint_enc.shape[1]):
            f = joint_enc[:, t : t + 1, :]
            for _ in range(RNNT_MAX_SYMBOLS):
                g, _, s0, s1 = r['rnnt_decoder'].run(
                    ['outputs', 'prednet_lengths', 'states', '162'],
                    {'targets': np.array([[hyp[-1]]], dtype=np.int32), 'target_length': np.array([1], dtype=np.int32), 'states.1': state[0], 'onnx::Slice_3': state[1]},
                )
                g = r['joint_pred'].run(['output'], {'input': g.transpose(0, 2, 1)})[0]
                j = r['joint_pre_net'].run(['output'], {'input': f + g})[0]
                tok = int(np.argmax(r[f'joint_post_net_{LANG}'].run(['output'], {'input': j})[0]))
                if tok == BLANK_ID:
                    break
                hyp.append(tok)
                state = (s0, s1)
        return ''.join(self.vocab[x] for x in hyp[1:]).replace('▁', ' ').strip()

    # ---------------------------------------------------------------- Tamil text → English
    def translate(self, tamil: str, *, final: bool) -> str:
        if not tamil.strip():
            return ''
        batch = self.ip.preprocess_batch([restore_english(tamil)], src_lang='tam_Taml', tgt_lang='eng_Latn')
        inputs = self.tok(batch, truncation=True, padding='longest', return_tensors='pt', return_attention_mask=True)
        with self.torch.no_grad():
            out = self.mt.generate(**inputs, use_cache=True, min_length=0, max_length=256, num_beams=4 if final else 1, num_return_sequences=1)
        text = self.tok.batch_decode(out, skip_special_tokens=True, clean_up_tokenization_spaces=True)
        return self.ip.postprocess_batch(text, lang='eng_Latn')[0]

    def transcribe(self, audio: np.ndarray, *, final: bool, context: str = '') -> str:
        with self.lock:
            return self.translate(self.hear(audio), final=final)

    def describe(self) -> dict:
        return {'engine': 'indic', 'model': f'IndicConformer-600M ({self.decoder}) + IndicTrans2-200M', 'device': 'cpu', 'threads': SETTINGS.threads, 'language': LANG}
