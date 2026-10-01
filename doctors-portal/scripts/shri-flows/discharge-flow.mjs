/**
 * The discharge workflow on the patient record (plan 4.6): a stable patient
 * goes home; a seriously ill one is transferred, leaves against advice, or has
 * a death recorded — never a routine discharge home. Loaded by
 * scripts/shri-flows.mjs.
 */

export default ({ page, expect, auditRows, sentItems, toastSays, pick, setInput }) => {
  const dialog = () => page.evaluate(`document.querySelector('[role="dialog"]')?.textContent ?? ''`)
  const primary = (label) => `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`
  const type = (sel, text) => page.type(sel, text)

  return [
    {
      name: 'Discharge (record): a stable patient goes home — the summary, medicines and instructions as they stand, a follow-up or its reason, then one discharge, on record, sent, and gone from the ward list',
      async run() {
        await page.open('/patient/ICH-0044275')
        await page.click('button', 'Discharge')
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Discharge Kumar Subramanian')`, 3000, 'the sheet')
        const text = await dialog()
        for (const t of ['Improving on the condition record · bed 4B-08 — a routine discharge home is available.', 'Discharge summary', 'Not started · unsigned — it goes to the sign queue', 'No medicine list on the record to reconcile', 'Patient instructions', 'Record a death — MCCD and body handover'])
          expect(text.includes(t), `the sheet says "${t}"`)
        expect(await page.evaluate(`[...document.querySelectorAll('[role="dialog"] [role="radio"][aria-checked="true"]')].some((r) => r.textContent.includes('Discharge home'))`), 'home is the way for a stable patient')
        await page.evaluate(`${primary('Discharge home')}.click()`)
        await page.until(`document.querySelector('[role="dialog"]').textContent.includes('book one, or record that none is needed')`, 2000, 'the follow-up is asked for')
        await page.click('[role="dialog"] [role="radio"]', 'No follow-up needed')
        await type('#dc-fu-none', 'Resolved; the GP follows up the blood pressure.')
        await type('#dc-careof', 'Anitha Subramanian, daughter')
        await page.evaluate(`${primary('Discharge home')}.click()`)
        await toastSays('Kumar Subramanian discharged', 'Bed released to the bed board. The summary is unsigned — it goes to the sign queue.')
        const row = (await auditRows()).find((r) => r.event === 'PATIENT.DISCHARGED' && r.subject === 'SD-P-12')
        expect(row && row.detail.includes('discharged home') && row.detail.includes('no follow-up: Resolved; the GP follows up the blood pressure.') && row.detail.includes('bed 4B-08 released'), `on record: ${JSON.stringify(row)}`)
        const sent = await sentItems()
        expect(sent.some((n) => n.recipient === 'front office' && n.title === 'Bed 4B-08 released' && n.detail.startsWith('Kumar Subramanian discharged home')), `the front office is told: ${JSON.stringify(sent[0])}`)
        await page.until(`!document.querySelector('[role="dialog"]')`, 3000, 'the sheet closes')
        expect((await page.text()).includes('Discharged 08:40') && !(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Discharge')`)), 'the header says so, and offers no second discharge')
        await page.open('/ip/patients', { fresh: false })
        expect(!(await page.evaluate(`[...document.querySelectorAll('ul[aria-label^="Inpatients"] li button')].map((b) => b.textContent).join('|')`)).includes('Kumar Subramanian'), 'gone from the inpatient list')
      },
    },
    {
      name: 'Discharge (record): a follow-up is booked from tomorrow, in a clinic, and goes to the front office; a financial hold stops a discharge home in the old words but not a transfer',
      async run() {
        await page.open('/patient/ICH-0041882')
        await page.click('button', 'Discharge')
        await page.until(`document.querySelector('[role="dialog"]')`, 3000, 'the sheet')
        const text = await dialog()
        expect(text.includes('Held by a hard rule') && text.includes('Financial clearance is outstanding: TPA approval pending. The bed cannot be released until it clears.'), 'the old board rule, word for word')
        await page.click('[role="dialog"] [role="radio"]', 'Book a follow-up')
        await setInput('#dc-fu-date', '2026-09-21')
        await page.evaluate(`${primary('Discharge home')}.click()`)
        const why = await dialog()
        expect(why.includes('a date from tomorrow') && why.includes('Hard rule'), `today is refused as a follow-up date, and the hard rule holds: ${why.slice(0, 200)}`)
        expect(!(await auditRows()).some((r) => r.event === 'PATIENT.DISCHARGED'), 'nothing recorded')
        await page.click('[role="dialog"] [role="radio"]', 'Transfer to another facility')
        expect((await dialog()).includes('It goes to the front office with this transfer; it does not hold the patient.'), 'a transfer is not held by the payer')
      },
    },
    {
      name: 'Discharge (record): a seriously ill patient is not offered a discharge home — it is shown refused with the reason; a transfer needs the receiving team, a reason, an escort, transport and a handover, and goes to the receiving team',
      async run() {
        await page.open('/patient/ICH-0044051')
        await page.click('button', 'Discharge')
        await page.until(`document.querySelector('[role="dialog"]')`, 3000, 'the sheet')
        const text = await dialog()
        expect(text.includes('Seriously ill — a routine discharge home is not offered') && text.includes('R. Lakshmanan is deteriorating. A patient on a rising deterioration score cannot be marked discharged.'), 'the reason, in the old words')
        expect(await page.evaluate(`[...document.querySelectorAll('[role="dialog"] [role="radio"]')].find((r) => r.textContent.includes('Discharge home')).getAttribute('aria-disabled') === 'true'`), 'home is refused')
        await page.click('[role="dialog"] [role="radio"]', 'Discharge home')
        expect(await page.evaluate(`[...document.querySelectorAll('[role="dialog"] [role="radio"][aria-checked="true"]')].some((r) => r.textContent.includes('Transfer to another facility'))`), 'pressing it does not choose it; the transfer stays chosen')
        await page.evaluate(`${primary('Transfer R. Lakshmanan')}.click()`)
        const why = await dialog()
        for (const t of ['Receiving facility', 'Accepting clinician', 'Reason for transfer', 'Escort', 'Transport', 'Clinical handover', 'Acceptance']) expect(why.includes(t), `the transfer asks for ${t}`)
        await pick('#tr-facility', 'ITP')
        await type('#tr-clinician', 'Dr. Logesh, pulmonology')
        await pick('#tr-escort', 'Doctor')
        await pick('#tr-transport', 'ALS ambulance')
        await type('#tr-reason', 'Needs non-invasive ventilation, which this ward cannot give.')
        await type('[id="tr-handover-SD-P-03"]', 'CAP day 4 on piperacillin-tazobactam, penicillin allergy documented; O2 4 L, NEWS2 7, AKI stage 2.')
        await page.click('[role="dialog"] [role="checkbox"]', 'The receiving team has accepted the patient')
        await page.evaluate(`${primary('Transfer R. Lakshmanan')}.click()`)
        await toastSays('R. Lakshmanan transferred to Indostates Tiruppur', 'The receiving team and the front office are told.')
        const row = (await auditRows()).find((r) => r.event === 'PATIENT.TRANSFERRED')
        expect(row && row.subject === 'SD-P-03' && row.detail.includes('accepted by Dr. Logesh, pulmonology · ALS ambulance, Doctor escort'), `on record: ${JSON.stringify(row)}`)
        const sent = await sentItems()
        expect(sent.some((n) => n.recipient === 'colleague' && n.title === 'Transfer — R. Lakshmanan') && sent.some((n) => n.recipient === 'front office' && n.severity === 'urgent'), `the receiving team and the front office: ${JSON.stringify(sent)}`)
        expect((await page.text()).includes('Transferred 08:40'), 'the header says what happened')
      },
    },
    {
      name: 'Discharge (record): leaving against medical advice needs the risks explained, the form signed and witnessed, and a reason; it is its own audit event',
      async run() {
        await page.open('/patient/ICH-0043910')
        await page.click('button', 'Discharge')
        await page.until(`document.querySelector('[role="dialog"]')`, 3000, 'the sheet')
        expect((await dialog()).includes('Joseph Mathew is critical on the condition record and in intensive care (ICU-1)'), 'serious, and why')
        await page.click('[role="dialog"] [role="radio"]', 'Leave against medical advice')
        await page.evaluate(`${primary('Record leaving against advice')}.click()`)
        expect((await dialog()).includes('tick once the risks are explained'), 'the risks come first')
        await page.click('[role="dialog"] [role="checkbox"]', 'I have explained the risks of leaving now')
        await type('#lama-signed', 'Mary Mathew')
        await pick('#lama-rel', 'Relative')
        await type('#lama-witness', 'Staff Nurse Deepa K')
        await type('#lama-reason', 'Family wish to take him to their home town hospital')
        await page.evaluate(`${primary('Record leaving against advice')}.click()`)
        await toastSays('Joseph Mathew left against medical advice', "Recorded with the form's signatory and witness.")
        const row = (await auditRows()).find((r) => r.event === 'PATIENT.LEFT_AMA')
        expect(row && row.detail.includes('form signed by Mary Mathew (Relative) · witness Staff Nurse Deepa K'), `on record: ${JSON.stringify(row)}`)
      },
    },
    {
      name: 'Discharge (record): offered only for an admitted patient, and only to those who may discharge; the draft is kept on stepping out to the summary',
      async run() {
        await page.open('/patient/ICH-0044120')
        expect(!(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Discharge')`)), 'an outpatient has no Discharge')
        await page.open('/patient/ICH-0044051', { persona: 'P-06' })
        expect(!(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Discharge')`)), 'no Discharge without discharge.write')
        await page.open('/patient/ICH-0044051')
        await page.click('button', 'Discharge')
        await page.until(`document.querySelector('[role="dialog"]')`, 3000, 'the sheet')
        await type('#tr-clinician', 'Dr. Logesh')
        await page.click('[role="dialog"] button', 'Open')
        await page.until(`location.pathname === '/encounter/E-118366/discharge-summary'`, 3000, 'out to the summary')
        await page.click('button[aria-label^="Back"]')
        await page.until(`location.pathname === '/patient/ICH-0044051'`, 3000, 'back to the record')
        await page.click('button', 'Discharge')
        await page.until(`document.querySelector('#tr-clinician')?.value === 'Dr. Logesh'`, 3000, 'the draft is kept')
      },
    },
  ]
}
