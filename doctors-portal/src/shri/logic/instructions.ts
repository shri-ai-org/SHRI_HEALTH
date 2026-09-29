// ported from src/screens/m06/S0608.tsx:31-47 (the AI-111 rewrite and its
// AI-110 translation, word for word) and 67-99 (the language, the channels and
// what Issue says).
//
// The old screen offered this one rewrite — SD-P-01's levothyroxine
// instructions — for every patient, and printed its Kannada beside any English
// in any language. Here the rewrite is offered only to the patient it was
// written for, and the translation only beside the text it translates: an
// edited or hand-written patient version, another language, or the AI off
// prints in English with that limitation stated, never a partial translation.

import type { InstructionChannel } from '@/store/clinical'

const PLAIN_ENGLISH = `Keep taking your thyroid tablet — levothyroxine, 75 micrograms — once every day.

Take it first thing in the morning, at least 30 minutes before you eat or drink anything except water.

If you take calcium or iron tablets, leave at least four hours between those and your thyroid tablet. They stop it being absorbed properly.

In six months, have a blood test for your thyroid. Book an appointment with Dr. Iyer for after the test, and bring the results.

Come back sooner if the tiredness returns, you feel cold all the time, or your weight changes without you trying.`

const KANNADA = `ನಿಮ್ಮ ಥೈರಾಯ್ಡ್ ಮಾತ್ರೆ — ಲೆವೊಥೈರಾಕ್ಸಿನ್ 75 ಮೈಕ್ರೋಗ್ರಾಂ — ಪ್ರತಿದಿನ ಒಂದು ಬಾರಿ ತೆಗೆದುಕೊಳ್ಳುವುದನ್ನು ಮುಂದುವರಿಸಿ.

ಬೆಳಿಗ್ಗೆ ಎದ್ದ ತಕ್ಷಣ, ಆಹಾರ ಅಥವಾ ನೀರಿನ ಹೊರತಾಗಿ ಬೇರೇನೂ ಸೇವಿಸುವ ಮೊದಲು ಕನಿಷ್ಠ 30 ನಿಮಿಷ ಮುಂಚಿತವಾಗಿ ತೆಗೆದುಕೊಳ್ಳಿ.

ಕ್ಯಾಲ್ಸಿಯಂ ಅಥವಾ ಕಬ್ಬಿಣದ ಮಾತ್ರೆಗಳನ್ನು ತೆಗೆದುಕೊಳ್ಳುತ್ತಿದ್ದರೆ, ಅವುಗಳ ಮತ್ತು ಥೈರಾಯ್ಡ್ ಮಾತ್ರೆಯ ನಡುವೆ ಕನಿಷ್ಠ ನಾಲ್ಕು ಗಂಟೆಗಳ ಅಂತರ ಇರಲಿ.

ಆರು ತಿಂಗಳ ನಂತರ ಥೈರಾಯ್ಡ್ ರಕ್ತ ಪರೀಕ್ಷೆ ಮಾಡಿಸಿ, ನಂತರ ಡಾ. ಐಯರ್ ಅವರನ್ನು ಭೇಟಿ ಮಾಡಿ.`

interface Rewrite {
  english: string
  /** AI-110's translations of exactly this English, by language code. */
  translations: Partial<Record<string, string>>
}

const REWRITES: Record<string, Rewrite> = {
  'SD-P-01': { english: PLAIN_ENGLISH, translations: { KN: KANNADA } },
}

/** AI-111's plain-language rewrite for this patient, where the build has one. */
export function rewriteFor(patientId: string): Rewrite | undefined {
  return REWRITES[patientId]
}

/** The old screen's default language, for a patient whose preference is not yet recorded. */
export const DEFAULT_LANGUAGE = 'KN'

/**
 * The translation printed beside the patient version — only the one made of
 * exactly this English, and only while AI-110 is live to have made it.
 */
export function translationFor(patientId: string, english: string, language: string, aiActive: boolean): string | undefined {
  if (!aiActive || language === 'EN') return undefined
  const r = REWRITES[patientId]
  if (!r || r.english !== english) return undefined
  return r.translations[language]
}

/** English only, with the limitation stated on the document — never a partial translation. */
export const ENGLISH_ONLY = 'Printed in English only. A translation of these instructions is not available, and a partial translation is never printed.'

/**
 * What Issue says, in the old toast's words, for the channels actually used:
 * "Printed bilingually and pushed to the patient app. The SMS carries a
 * pointer only, never the content."
 */
export function issuedDetail(channels: InstructionChannel[], print: 'bilingual' | 'english' | 'english-only'): string {
  const done: string[] = []
  if (channels.includes('print')) done.push(print === 'bilingual' ? 'Printed bilingually' : print === 'english' ? 'Printed' : 'Printed in English only')
  if (channels.includes('app')) done.push(done.length ? 'pushed to the patient app' : 'Pushed to the patient app')
  const first = done.length ? `${done.join(' and ')}.` : ''
  const sms = channels.includes('sms') ? 'The SMS carries a pointer only, never the content.' : ''
  return [first, sms].filter(Boolean).join(' ')
}

/** The channels' names on the audit trail and the sent item. */
export const CHANNEL_WORD: Record<InstructionChannel, string> = { print: 'A5 print', app: 'patient app', sms: 'SMS' }
