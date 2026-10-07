/**
 * The assistant (M-28): the clinician assistant screen (S-28-02), the stroke
 * command assistant (S-28-09) and the drawer — one answer surface, the old
 * build's `resolveAnswer`, guardrails and all. Loaded by scripts/shri-flows.mjs.
 */

export default ({ page, expect, auditRows, toastSays }) => {
  const composer = 'textarea[aria-label="Ask the assistant"]'
  const askOnPage = async (q) => {
    await page.type(composer, q)
    await page.click('button', 'Ask')
    await page.until(`[...document.querySelectorAll('[role="log"] article')].length > 0`, 3000, `an answer to "${q}"`)
  }
  const lastAnswer = () => page.evaluate(`[...document.querySelectorAll('[role="log"] article')].at(-1)?.textContent ?? ''`)

  return [
    {
      name: 'Assistant (S-28-02): the empty state is never a blank box; a cited answer names its sources and can be reported; the bubble is not on the screen that IS the assistant',
      async run() {
        await page.open('/assistant/clinician')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-28-02"]')`), 'S-28-02 is drawn')
        const text = await page.evaluate(`document.querySelector('[data-screen-id="S-28-02"]').textContent`)
        expect(text.includes('Clinician Assistant') && text.includes('Scoped to R. Lakshmanan, because you have them open.') && text.includes('Try one of these'), 'the scope and the prompts')
        expect(!(await page.evaluate(`!!document.querySelector('button[aria-label="Assistant"]')`)), 'no bubble on the assistant screen')
        await askOnPage('How do I add an addendum to a signed note?')
        const a = await lastAnswer()
        expect(a.includes('Sources') && a.includes('Report wrong answer'), `a cited answer with its sources: ${a.slice(0, 160)}`)
        await page.click('[role="log"] article button', 'Report wrong answer')
        expect((await lastAnswer()).includes('Reported — thank you'), 'reported')
      },
    },
    {
      name: 'Assistant (S-28-02): the refusals — clinical is routed to its owner, out of scope names what it covers, no evidence abstains, beyond access looks the same; off with the AI',
      async run() {
        await page.open('/assistant/clinician')
        await askOnPage('Is this dose safe for him?')
        expect((await lastAnswer()).includes('That is a clinical question'), 'routed')
        await askOnPage('What is the weather like?')
        expect((await lastAnswer()).includes('Outside what I cover'), 'out of scope')
        await askOnPage('What is the policy on ward pets?')
        const none = await lastAnswer()
        expect(none.includes('AI-ABSTAIN · grounded or silent.') && !none.includes('Sources'), 'no evidence: the abstain frame, nothing to cite')
        await page.open('/assistant/clinician?ai=off', { fresh: false })
        const off = await page.text()
        expect(off.includes('The assistant is switched off') && off.includes('extension 4400'), 'AI off: the static route')
        expect(await page.evaluate(`document.querySelector('${composer}').disabled`), 'and the composer is off')
      },
    },
    {
      name: 'Assistant (S-28-09): the stroke command assistant has its own scope',
      async run() {
        await page.open('/assistant/stroke', { persona: 'P-35' })
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-28-09"]')`), 'S-28-09 is drawn')
        const text = await page.evaluate(`document.querySelector('[data-screen-id="S-28-09"]').textContent`)
        expect(text.includes('Stroke Command Assistant') && text.includes('Scoped to Vikram Malhotra'), 'its own title and patient')
      },
    },
    {
      name: 'Assistant drawer: scoped to the patient and screen in view, suggestions for them, the same answers — and a reading ends in a signature, on record',
      async run() {
        await page.open('/patient/ISH-0043910')
        await page.click('button[aria-label="Assistant"]')
        await page.until(`!!document.querySelector('[role="dialog"][aria-label="Assistant · Joseph Mathew"]')`, 3000, 'the drawer, scoped to Joseph Mathew')
        const drawer = () => page.evaluate(`document.querySelector('[role="dialog"][aria-label^="Assistant"]').textContent`)
        expect((await drawer()).includes('Joseph Mathew · Patient record') && (await drawer()).includes('Suggested for Joseph'), 'the scope and its suggestions')
        // A reading is the owning screen's: on the record it is not offered, and the assistant says it has nothing, rather than reading anyway.
        await page.type('[role="dialog"] input[aria-label="Ask the assistant"]', 'What is your view on the potassium?')
        await page.click('[role="dialog"] button[aria-label="Ask"]')
        await page.until(`document.querySelector('[role="dialog"]').textContent.includes("I don't have documentation for that.")`, 3000, 'no reading off its own screen')
        await page.click('[role="dialog"] button[aria-label="Close assistant"]')
        await page.open('/results/R-88410', { fresh: false })
        await page.click('button[aria-label="Assistant"]')
        await page.until(`!!document.querySelector('[role="dialog"][aria-label="Assistant · Joseph Mathew"]')`, 3000, 'the drawer on the result, scoped to its patient')
        await page.type('[role="dialog"] input[aria-label="Ask the assistant"]', 'What is your view on the potassium?')
        await page.click('[role="dialog"] button[aria-label="Ask"]')
        await page.until(`document.querySelector('[role="dialog"]').textContent.includes('needs your signature, not just your click.')`, 3000, 'a reading, with its attest strip')
        expect((await drawer()).includes('Potassium 6.8 mmol/L is a critical value'), 'the reading is the old one')
        await page.click('[role="dialog"] button', 'Sign for this reading')
        await toastSays('Reading signed')
        const row = (await auditRows()).find((r) => r.event === 'AI.ATTESTED' && r.model === 'AI-212')
        expect(row && row.gate === 'G3', `the signature is on record: ${JSON.stringify(row)}`)
        expect((await drawer()).includes('Signed by'), 'and the strip says who signed')
        await page.click('[role="dialog"] button', 'New question')
        expect((await drawer()).includes('Suggested for Joseph'), 'back to the suggestions')
        await page.open('/stroke/wall', { persona: 'P-35', fresh: false })
        expect(!(await page.evaluate(`!!document.querySelector('button[aria-label="Assistant"]')`)), 'no bubble on a wall')
      },
    },
  ]
}
