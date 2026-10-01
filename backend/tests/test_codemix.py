"""restore_english: English words spoken inside Tamil, back in English letters. Run: python -m pytest tests -q."""

from asr.codemix import restore_english, tamil_to_latin


def test_tamil_script_is_read_aloud():
    assert tamil_to_latin('பிபி') == 'pipi'
    assert tamil_to_latin('டோஸ்') == 'tos'
    assert tamil_to_latin('மெட்ஃபார்மின்') == 'metfarmin'


def test_the_brief_example():
    assert restore_english('பிபி கொஞ்சம் ஹை இன்க்ரீஸ் டோஸ்') == 'BP கொஞ்சம் high increase dose'


def test_a_tamil_ending_is_kept_on_the_english_word():
    assert restore_english('சுகர் லெவல் கண்ட்ரோல்ல இருக்கு') == 'sugar level control-ல இருக்கு'
    assert restore_english('ரிவ்யூக்கு') == 'review-க்கு'


def test_colloquial_come_is_not_read_as_buy():
    assert restore_english('ரெண்டு வாரம் கழிச்சு ரிவ்யூக்கு வாங்க') == 'ரெண்டு வாரம் கழித்து review-க்கு வரவும்'


def test_tamil_words_stay_tamil():
    for line in ['காய்ச்சல் இருக்கு தலைவலி இருக்கு', 'எங்களுடைய விளையாட்டு வீரர்கள் மற்றும் கிளப்புகளின் நலன்கள் முதன்மையானவை']:
        assert restore_english(line) == line


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn()
            print('PASS', name)
