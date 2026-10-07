/**
 * ICD-10 wherever a diagnosis is recorded — admission, discharge, a
 * prescription line, the death certificate — and the Cohorts tab of My
 * patients that segregates patients by those codes and by demographics, with a
 * de-identified, audited export. Loaded by scripts/shri-flows.mjs.
 */

export default ({ page, expect, sleep, auditRows, toastSays, pick, setInput, becomePersona, SIGN_RX }) => {
  const dialog = () => page.evaluate(`document.querySelector('[role="dialog"]')?.textContent ?? ''`)
  const names = () => page.evaluate(`[...document.querySelectorAll('[role="tabpanel"] ul[aria-label="Patients in this cohort"] li, [role="tabpanel"] table tbody tr')].map((r) => r.textContent)`)
  const cohortNames = async () => {
    const rows = await names()
    return ['Meera Krishnan', 'Abdul Rahman Sheikh', 'R. Lakshmanan', 'Sunita Devi', 'Vikram Malhotra', 'Kavya Reddy', 'Joseph Mathew', 'Fatima Bi', 'Arjun Nair', 'Selvi Murugan', 'Kumar Subramanian', 'Priya Raman', 'Santhosh Babu', 'Lakshmi Narayanan', 'Rahul Verma']
      .filter((n) => rows.some((r) => r.includes(n)))
      .sort()
  }

  return [
    {
      name: 'ICD-10 at admission: an optional provisional diagnosis — one tap from the open problems — goes on the admission, the audit row and the Cohorts filter',
      async run() {
        await page.open('/patient/ISH-0044120')
        await page.click('button', 'Admit')
        await page.until(`document.querySelector('[role="dialog"][aria-labelledby="admit-title"]')?.textContent.includes('Provisional diagnosis (ICD-10, optional)')`, 3000, 'the coded diagnosis field')
        await page.click('[role="dialog"] button', 'Hypothyroidism · E03.9')
        await page.until(`[...document.querySelectorAll('[role="dialog"] ul[aria-label^="Provisional diagnosis"] li')].some((l) => l.textContent.includes('E03.9'))`, 3000, 'the code is chosen')
        await page.click('[role="dialog"] [role="radio"]', 'Urgent')
        await page.click('[role="dialog"] button', 'Confirm')
        await toastSays('Admission in progress — Meera Krishnan', 'Ward · Urgent · E03.9')
        const row = (await auditRows()).find((r) => r.event === 'ADMISSION.REQUESTED' && r.subject === 'SD-P-01')
        expect(row && row.detail === 'Ward · Urgent · ICD-10 E03.9 Hypothyroidism', `ADMISSION.REQUESTED: ${JSON.stringify(row)}`)
        const adm = await page.evaluate(`JSON.parse(localStorage.getItem('indostates.admissions')).state.admissions['SD-P-01']`)
        expect(adm.diagnosis && adm.diagnosis.code === 'E03.9', `stored on the admission: ${JSON.stringify(adm)}`)
        await page.open('/patients/cohorts?dx=E03&src=admission', { fresh: false })
        expect((await cohortNames()).join('|') === 'Meera Krishnan', `coded at admission, found by it: ${await cohortNames()}`)
      },
    },
    {
      name: 'ICD-10 at discharge: the final diagnosis — principal first, by tap or by search — is on the discharge record and its audit row; optional, it never holds a discharge',
      async run() {
        await page.open('/patient/ISH-0044275')
        await page.click('button', 'Discharge')
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Final diagnosis')`, 3000, 'the sheet with its final diagnosis')
        await page.click('[role="dialog"] button', 'I61.0')
        await page.type('#dc-dx-SD-P-12', 'hyperlip')
        await page.until(`!!document.querySelector('[role="dialog"] [role="listbox"]')`, 2000, 'the search lists matches')
        await page.click('[role="dialog"] [role="listbox"] button', 'E78.5')
        const chosen = await page.evaluate(`[...document.querySelectorAll('[role="dialog"] ul[aria-label^="ICD-10 codes"] li')].map((l) => l.textContent)`)
        expect(chosen.length === 2 && chosen[0].includes('I61.0') && chosen[0].includes('principal') && chosen[1].includes('E78.5'), `principal then secondary: ${chosen}`)
        await page.click('[role="dialog"] [role="radio"]', 'No follow-up needed')
        await page.type('#dc-fu-none', 'Stroke clinic follows up from the community.')
        await page.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Discharge home').click()`)
        await toastSays('Kumar Subramanian discharged')
        const row = (await auditRows()).find((r) => r.event === 'PATIENT.DISCHARGED' && r.subject === 'SD-P-12')
        expect(row && row.detail.includes('final diagnosis ICD-10 I61.0') && row.detail.includes('E78.5 Hyperlipidaemia, unspecified'), `PATIENT.DISCHARGED: ${JSON.stringify(row)}`)
        await page.open('/patients/cohorts?dx=E78&src=discharge', { fresh: false })
        expect((await cohortNames()).join('|') === 'Kumar Subramanian', `coded at discharge, found by it: ${await cohortNames()}`)
      },
    },
    {
      name: "ICD-10 on a prescription line: a coded indication is read from the line, an uncoded one can be coded, and both are printed and on the RX.SIGNED row",
      async run() {
        await page.open('/encounter/E-118366/rx')
        // Co-amoxiclav's indication carried its code; paracetamol's did not.
        expect(await page.evaluate(`[...document.querySelectorAll('ul[aria-label^="Indication"] li')].some((l) => l.textContent.includes('J18.9'))`), 'the coded indication shows as a code')
        await page.type('[id="E-118366:RX-L-03:indication"]', 'fever')
        await page.until(`!!document.querySelector('[role="listbox"]')`, 2000, 'the search lists matches')
        await page.click('[role="listbox"] button', 'R50.9')
        await page.until(`[...document.querySelectorAll('ul[aria-label^="Indication"] li')].some((l) => l.textContent.includes('R50.9'))`, 2000, 'paracetamol is now coded')
        const edits = await page.evaluate(`JSON.parse(localStorage.getItem('indostates.clinical')).state.prescriptions['E-118366'].edits['RX-L-03']`)
        expect(edits.indication && edits.indication.code === 'R50.9', `kept on the prescription: ${JSON.stringify(edits)}`)
        // The rest of the signing, as the prescription flow does it.
        await page.click('button', 'Resolve')
        await page.click('[role="alertdialog"] button[aria-label="Use Levofloxacin"]')
        await toastSays('Levofloxacin substituted')
        await page.click('[aria-label="Accept 20 mg once daily"]')
        await page.type('[id="E-118366:RX-L-03:ceiling"]', '4 g')
        await page.until(`${SIGN_RX}.getAttribute('aria-disabled') !== 'true'`, 3000, 'Sign enables')
        await page.click('button', 'Sign prescription')
        await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Sign this prescription?')`, 3000, 'the irreversible step asks first')
        await page.click('[role="alertdialog"] button', 'Sign prescription')
        await toastSays('Prescription signed')
        const row = (await auditRows()).find((r) => r.event === 'RX.SIGNED')
        expect(row && row.detail.includes('indications ICD-10') && row.detail.includes('J18.9') && row.detail.includes('R50.9'), `RX.SIGNED: ${JSON.stringify(row)}`)
        await page.click('button', 'Print A5, bilingual')
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Print preview · A5')`, 3000, 'the A5 preview')
        const paper = await page.evaluate(`document.querySelector('[role="dialog"] article').textContent`)
        expect(paper.includes('For Fever, unspecified (R50.9)') && paper.includes('(J18.9)'), `the paper carries the indications: ${paper.slice(0, 400)}`)
        await page.key('Escape')
      },
    },
    {
      name: 'ICD-10 on the death certificate: a code beside a cause writes its words when the line is empty; the codes are on the certificate and the DEATH.CERTIFIED row',
      async run() {
        await page.open('/encounter/E-118201/death')
        await setInput('#dod-time', '2026-09-21T07:55')
        await pick('#dod-family', 'By telephone')
        await page.click('button', 'Continue')
        await page.until(`document.body.textContent.includes('MCCD Form 4 · Cause of death')`, 3000, 'the cause of death')
        await page.click('button', 'Septic shock · R65.21')
        expect((await page.evaluate(`document.getElementById('cod-a').value`)) === 'Septic shock', 'picking a code fills the empty line with its words')
        await page.type('#cod-b', 'Urinary tract infection, ESBL E. coli')
        await page.type('#cod-b-icd', 'urine')
        await page.until(`!!document.querySelector('[role="listbox"]')`, 2000, 'the search lists matches')
        await page.click('[role="listbox"] button', 'N39.0')
        expect((await page.evaluate(`document.getElementById('cod-b').value`)) === 'Urinary tract infection, ESBL E. coli', 'words already written stay as written')
        await page.click('button', 'Continue')
        await page.until(`document.body.textContent.includes('MCCD Form 4 · Medico-legal')`, 3000, 'medico-legal')
        await page.click('button', 'Continue')
        await page.until(`document.body.textContent.includes('MCCD Form 4 · Handover')`, 3000, 'handover')
        await page.type('#handover-to', 'Mary Mathew, wife')
        await pick('#handover-id', 'Passport')
        await page.click('button', 'Certify and release')
        await page.until(`!!document.querySelector('[role="alertdialog"]')`, 3000, 'the confirmation')
        await page.click('[role="alertdialog"] button', 'Certify and release')
        await toastSays('MCCD issued')
        const row = (await auditRows()).find((r) => r.event === 'DEATH.CERTIFIED')
        expect(row && row.detail.includes('ICD-10 (a) R65.21 · (b) N39.0'), `DEATH.CERTIFIED: ${JSON.stringify(row)}`)
        await page.open('/encounter/E-118201/death', { fresh: false })
        expect((await page.text()).includes('(a) R65.21 · (b) N39.0'), 'the certificate shows its codes')
      },
    },
    {
      name: 'Cohorts (S-05-10): every patient, segregated by ICD-10 and by demographics, kept in the address; saved by name; exported de-identified and audited — only by who may',
      async run() {
        await page.open('/patients/cohorts')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-05-10"]')`), 'S-05-10 is drawn')
        expect(await page.evaluate(`document.querySelector('[role="tab"][aria-selected="true"]').textContent.startsWith('Cohorts')`), 'the third tab of My patients')
        expect((await cohortNames()).length === 15, `every patient to begin with: ${(await cohortNames()).length}`)

        // A category, picked by search: every I63 code.
        await page.type('#cohort-dx', 'I63')
        await page.until(`!!document.querySelector('[role="listbox"]')`, 2000, 'the search lists matches')
        await page.click('[role="listbox"] button', 'every I63 code')
        await page.until(`location.search.includes('dx=I63')`, 2000, 'the filter is in the address')
        expect((await cohortNames()).join('|') === 'Priya Raman|Vikram Malhotra', `I63: ${await cohortNames()}`)

        await page.open('/patients/cohorts?dx=E11', { fresh: false })
        expect((await cohortNames()).join('|') === 'Abdul Rahman Sheikh|R. Lakshmanan', `E11: ${await cohortNames()}`)

        // Demographics only: men aged 60–74.
        await page.open('/patients/cohorts', { fresh: false })
        await page.click('[role="group"][aria-label="Age bands"] button', '60–74')
        await page.click('[role="group"][aria-label="Sex"] button', 'Male')
        await page.until(`location.search.includes('age=60-74') && location.search.includes('sex=M')`, 2000, 'both in the address')
        expect((await cohortNames()).join('|') === 'Joseph Mathew|R. Lakshmanan|Santhosh Babu', `men 60–74: ${await cohortNames()}`)
        await page.reload()
        expect((await cohortNames()).join('|') === 'Joseph Mathew|R. Lakshmanan|Santhosh Babu', 'a reload keeps the cohort')

        // Saved by name, reopened from the list.
        await page.type('#cohort-name', 'Men 60 to 74')
        await page.click('button', 'Save cohort')
        await toastSays('Cohort saved — Men 60 to 74')
        await page.open('/patients/cohorts', { fresh: false })
        await page.click('ul[aria-label="Saved cohorts"] button', 'Men 60 to 74')
        await page.until(`location.search.includes('age=60-74') && location.search.includes('sex=M')`, 2000, 'the saved filters come back')

        // Export: a file with no names, UHIDs or exact ages, and one audit row naming the filters, not the patients.
        await page.evaluate(`(() => { window.__csv = []; const make = URL.createObjectURL; URL.createObjectURL = (b) => { window.__csv.push(b); return make(b) }; return true })()`)
        await page.click('button', 'Export de-identified CSV')
        await toastSays('Cohort exported — 3 patients')
        const csv = await page.evaluate(`window.__csv[0].text()`)
        const lines = csv.trim().split('\n')
        expect(lines[0] === 'study_id,age_band,sex,facility,payer,seen_as,icd10_codes,icd10_categories,icd10_chapters,diagnosis_sources' && lines.length === 4, `header and three rows: ${csv}`)
        expect(!/Joseph|Lakshmanan|Santhosh|ISH-00|ITP-00|\b(62|69|71)\b/.test(csv), `nothing identifying: ${csv}`)
        expect(lines.slice(1).every((l) => /^P-00\d,60–74,M,/.test(l)), `study IDs and the band: ${csv}`)
        const row = (await auditRows()).find((r) => r.event === 'COHORT.EXPORTED')
        expect(row && row.detail.startsWith('3 patients · de-identified CSV · age 60–74 · male') && !row.subject, `COHORT.EXPORTED: ${JSON.stringify(row)}`)

        // The stroke neurologist reads cohorts but may not export; a resident has neither, so the tab is absent.
        await becomePersona('P-35')
        await page.open('/patients/cohorts', { fresh: false })
        expect(!(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Export de-identified CSV'))`)), 'no export without record.export')
        await becomePersona('P-05')
        await page.open('/op-queue', { fresh: false })
        await sleep(300)
        expect(!(await page.evaluate(`[...document.querySelectorAll('[role="tab"]')].some((t) => t.textContent.startsWith('Cohorts'))`)), 'the tab is absent, not greyed, without cohort.read')
        await becomePersona('P-04')
      },
    },
  ]
}
