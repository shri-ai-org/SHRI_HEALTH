import { beforeEach, describe, expect, it } from 'vitest'

import { cumulativeTranscript, mergeDraft, sameText, useDraftOffers, useVisitDictation } from './draftMerge'

const S = 'Chest tightness for two days, worse on stairs.'
const O = 'BP 150/95, pulse 88, lungs clear.'
const A = 'Uncontrolled essential hypertension.'
const P = 'Start lisinopril 10 mg daily; recheck in two weeks.'
const suggestion = (id: string, text: string) => ({ suggestionId: id, text })

describe('mergeDraft: a new draft never wipes or silently overwrites a section', () => {
  it('fills empty sections from the first draft (subjective and objective)', () => {
    const m = mergeDraft({
      text: {},
      provenance: {},
      suggestions: { subjective: suggestion('s1', S), objective: suggestion('o1', O) },
      serverText: { subjective: S, objective: O, assessment: '', plan: '' },
    })
    expect(m.drafted.sort()).toEqual(['objective', 'subjective'])
    expect(m.offers).toEqual({})
    // The ghost draft: the section stays empty until the clinician accepts it.
    expect(m.text.subjective).toBe('')
    expect(m.provenance.subjective).toBe('scribe')
  })

  it('draft 2 (assessment and plan) leaves subjective and objective intact and fills A and P', () => {
    const afterDraft1 = { subjective: S, objective: O, assessment: '', plan: '' }
    const m = mergeDraft({
      text: afterDraft1,
      provenance: { subjective: 'scribe', objective: 'scribe' },
      // The second draft's dictation was only A and P, so its S and O came back empty.
      suggestions: { assessment: suggestion('a2', A), plan: suggestion('p2', P) },
      serverText: { subjective: '', objective: '', assessment: A, plan: P },
    })
    expect(m.text.subjective).toBe(S)
    expect(m.text.objective).toBe(O)
    expect(m.drafted.sort()).toEqual(['assessment', 'plan'])
    expect(m.offers).toEqual({})
  })

  it('an accepted or edited section is not overwritten by a later draft: the new text is only offered', () => {
    const edited = `${S} No fever.`
    const m = mergeDraft({
      text: { subjective: edited, objective: O, assessment: '', plan: '' },
      provenance: { subjective: 'scribe', objective: 'typed' },
      suggestions: { subjective: suggestion('s2', 'Chest pain for two days.'), objective: suggestion('o2', O), assessment: suggestion('a2', A) },
      serverText: { subjective: 'Chest pain for two days.', objective: O, assessment: A, plan: '' },
    })
    expect(m.text.subjective).toBe(edited)
    expect(m.text.objective).toBe(O)
    expect(Object.keys(m.offers).sort()).toEqual(['objective', 'subjective'])
    expect(m.offers.subjective.suggestionId).toBe('s2')
    // The kept AI section is the clinician's while the new suggestion waits beside it.
    expect(m.provenance.subjective).toBe('typed')
    expect(m.drafted).toEqual(['assessment'])
    expect(m.text.plan).toBe('')
  })

  it('a typed or dictated section with no new suggestion keeps its text and provenance', () => {
    const m = mergeDraft({
      text: { plan: P },
      provenance: { plan: 'dictated' },
      suggestions: {},
      serverText: { plan: '' },
    })
    expect(m.text.plan).toBe(P)
    expect(m.provenance.plan).toBe('dictated')
  })

  it('compares text the way the server does, spacing ignored', () => {
    expect(sameText(' BP 150/95,\n pulse 88 ', 'BP 150/95, pulse 88')).toBe(true)
    expect(sameText('BP 150/95', 'BP 150/96')).toBe(false)
  })
})

describe('the visit dictation: cumulative, in order, until Clear dictation', () => {
  beforeEach(() => useVisitDictation.setState({ takes: {} }))

  it('sends every earlier take with the new one, in the order they were said', () => {
    const { add } = useVisitDictation.getState()
    add('enc-1', 'subjective words')
    add('enc-1', '  ')
    expect(cumulativeTranscript(useVisitDictation.getState().takes['enc-1'], 'assessment words')).toBe('subjective words\nassessment words')
    add('enc-1', 'assessment words')
    expect(useVisitDictation.getState().takes['enc-1']).toEqual(['subjective words', 'assessment words'])
    // Another visit has its own list.
    expect(useVisitDictation.getState().takes['enc-2']).toBeUndefined()
  })

  it('Clear dictation starts over for that visit only', () => {
    const { add, clear } = useVisitDictation.getState()
    add('enc-1', 'one')
    add('enc-2', 'two')
    clear('enc-1')
    expect(useVisitDictation.getState().takes).toEqual({ 'enc-2': ['two'] })
    expect(cumulativeTranscript(useVisitDictation.getState().takes['enc-1'], '')).toBe('')
  })

  it('offers belong to one visit: a new draft replaces only that visit’s', () => {
    useDraftOffers.setState({ offers: {} })
    useDraftOffers.getState().setFor('enc-1', { subjective: suggestion('s1', S) })
    useDraftOffers.getState().setFor('enc-2', { plan: suggestion('p1', P) })
    useDraftOffers.getState().setFor('enc-1', { objective: suggestion('o2', O) })
    expect(Object.keys(useDraftOffers.getState().offers).sort()).toEqual(['enc-1:objective', 'enc-2:plan'])
  })
})
