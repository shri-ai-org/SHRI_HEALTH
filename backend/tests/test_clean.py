"""clean_text: what the note gets from the model's English. Run: python -m pytest tests -q (or python -m tests.test_clean)."""

from asr.clean import clean_text


def test_the_brief_example_reads_in_full_words():
    # Whisper renders "BP konjam high increase dose" as English with the shorthand kept; the note spells it out.
    assert clean_text('BP is slightly high, increase the dose') == 'Blood pressure is slightly high, increase the dose.'


def test_shorthand_expands_only_as_a_whole_word():
    assert clean_text('Paracetamol 650 mg TDS') == 'Paracetamol 650 mg three times a day.'
    assert clean_text('BPD measured') == 'BPD measured.'  # not "blood pressureD"


def test_known_hallucinations_are_dropped():
    assert clean_text('Thank you for watching.') == ''
    assert clean_text('Review in two weeks. Thanks for watching!') == 'Review in two weeks.'


def test_a_decoder_loop_is_collapsed():
    assert clean_text('increase the dose increase the dose increase the dose') == 'Increase the dose.'


def test_spacing_capitals_and_full_stop():
    assert clean_text('  sugar is normal .  continue metformin') == 'Sugar is normal. Continue metformin.'


def test_nothing_in_nothing_out():
    assert clean_text('') == '' and clean_text(None) == ''


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn()
            print('PASS', name)
