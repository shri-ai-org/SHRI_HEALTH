"""The VAD on silence and on real Tamil speech (a FLEURS clip). Run: python -m tests.test_vad"""

from pathlib import Path

import numpy as np
import soundfile as sf

from audio.vad import StreamingVad, is_speech

CLIPS = Path(__file__).resolve().parents[2] / 'backend-data' / 'fleurs' / 'test'


def test_silence_is_not_speech():
    assert not is_speech(np.zeros(16000 * 2, dtype=np.float32))


def test_real_speech_opens_and_closes_one_utterance():
    clip = sorted(CLIPS.glob('*.wav'))[4]
    audio, _ = sf.read(clip, dtype='float32')
    assert is_speech(audio)
    vad = StreamingVad()
    events = []
    padded = np.concatenate([audio, np.zeros(16000, dtype=np.float32)])
    for i in range(0, len(padded), 4000):  # 250 ms frames, as the browser sends them
        events += vad.feed(padded[i : i + 4000])
    kinds = [k for k, _ in events]
    assert kinds[0] == 'start' and kinds[-1] == 'end', events
    assert events[-1][1] <= len(padded), events


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn()
            print('PASS', name)
