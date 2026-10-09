/**
 * Stroke, the acute case (M-18, S-18-11 to S-18-20): the telestroke session,
 * the remote NIHSS, the spoke console, the imaging triage card, ASPECTS,
 * perfusion, thrombolysis, EVT selection, the transfer and the registry.
 * Loaded by scripts/shri-flows.mjs. The stroke personas: P-35 the hub
 * neurologist, P-36 the neuro-interventionist, P-38 the spoke physician.
 */

export default ({ page, expect, toastSays, auditRows, pick, setInput }) => {
  const drawn = (id) => page.evaluate(`!!document.querySelector('[data-screen-id="${id}"]')`)
  const disabled = (label) => page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.disabled`)
  /** Toasts stack over the foot of the page; a person dismisses them before reaching under. */
  const dismissToasts = async () => {
    await page.evaluate(`[...document.querySelectorAll('button[aria-label="Dismiss"]')].forEach((b) => b.click())`)
    await page.until(`!document.querySelector('button[aria-label="Dismiss"]')`, 3000, 'the toasts are gone')
  }
  const rail = (title) => page.click(`aside[aria-label="${title}"] button[title="Show ${title}"]`)
  const has = (label) => page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(label)})`)

  return [
    {
      name: 'Stroke acute (S-18-11): the telestroke session — in session on arrival, the index case’s transcript and AI-112 extraction, ended with a confirmation',
      async run() {
        await page.open('/stroke/case/0141/telestroke', { persona: 'P-35' })
        expect(await drawn('S-18-11'), 'S-18-11 is drawn')
        let text = await page.text()
        expect(text.includes('Dr. Rajsrinivas at the hub · Dr. Logesh at IPL') && text.includes('RECORDING · with consent') && text.includes('bandwidth 640 kbps'), 'the session header and the recording mark')
        expect(text.includes('ICH NO') || text.includes('ICH NO') || /ICH\s+NO/.test(text), `the one imaging line: ${text.slice(0, 200)}`)
        await page.until(`document.body.textContent.includes('Total is fourteen.')`, 25000, 'the transcript runs to the total')
        await page.until(`document.body.textContent.includes('NIHSS 14 extracted from the examination')`, 3000, 'AI-112 offers the extracted NIHSS')
        await page.click('button', 'Share the CT')
        await toastSays('CT shared to the call', 'Dr. Logesh now sees the same slice you do.')
        await page.click('button', 'End the session')
        await page.until(`!!document.querySelector('[role="alertdialog"]')?.textContent.includes('The call closes for everyone on it.')`, 3000, 'ending is confirmed')
        await page.click('[role="alertdialog"] button', 'End the session')
        await toastSays('Session ended', 'recording kept with case STROKE/26-27/0141.')
        // Another case: its own spoke, no borrowed transcript.
        await page.open('/stroke/case/0142/telestroke', { persona: 'P-35' })
        await page.until(`document.body.textContent.includes('Waiting for speech')`, 3000, 'the transcript is empty')
        text = await page.text()
        expect(text.includes('Dr. Rajsrinivas at the hub · Dr. Rajsrinivas at ITP') && !text.includes('Mr Malhotra'), 'case 0142 borrows nothing from 0141')
        await page.open('/stroke/case/NOPE/telestroke', { persona: 'P-35' })
        expect((await page.text()).includes('There is no stroke case with the id “NOPE” here.'), 'an unknown case says so')
      },
    },
    {
      name: 'Stroke acute (S-18-12): the NIHSS — untested is blank, never zero; eight items before it records; AI-112 only on the case it was spoken in',
      async run() {
        await page.open('/stroke/case/0141/nihss', { persona: 'P-38' })
        expect(await drawn('S-18-12'), 'S-18-12 is drawn')
        let text = await page.text()
        expect(text.includes('NIHSS 0 · 0 of 15 scored · 15 not tested') && text.includes('15 items not tested — excluded from the total, never counted as zero'), 'nothing scored, nothing counted')
        await rail('NIHSS')
        expect((await page.text()).includes('HPR IN-HPR-3342109'), 'the examiner is recorded, in the rail')
        expect(await disabled('Record the score'), 'the score waits for eight items')
        await page.click('button', 'Accept all 6 extracted items')
        await toastSays('Extracted items accepted', 'The untested items remain blank.')
        text = await page.text()
        expect(text.includes('NIHSS 9 · 6 of 15 scored · 9 not tested'), `the extracted six count: ${text.slice(0, 400)}`)
        expect(await disabled('Record the score'), 'six is not eight')
        await pick('select[aria-label="Score for LOC commands"]', '0')
        await pick('select[aria-label="Score for Visual fields"]', '1')
        text = await page.text()
        expect(text.includes('NIHSS 10 · 8 of 15 scored · 7 not tested'), 'a zero is scored, and counted as normal')
        expect(!(await disabled('Record the score')), 'eight items record')
        await page.click('button', 'Record the score')
        await toastSays('NIHSS 10 recorded', '8 of 15 items, examined by Dr. Logesh at')
        await page.until(`location.pathname === '/stroke/case/0141/thrombolysis'`, 3000, 'on to the decision')
        await page.open('/stroke/case/0142/nihss', { persona: 'P-38' })
        text = await page.text()
        expect(!text.includes('items were scored aloud during the examination'), 'no borrowed extraction on another case')
      },
    },
    {
      name: 'Stroke acute (S-18-13): the spoke console — one action always enabled (offline too), six questions none of which blocks, the phone path, the progressive CT',
      async run() {
        await page.open('/stroke/spoke?state=OFFLINE', { persona: 'P-38' })
        expect(await drawn('S-18-13'), 'S-18-13 is drawn')
        let text = await page.text()
        expect(text.includes('No connection — this is the expected state here') && text.includes('No case activated · one tap starts the clock and pages the hub') && text.includes('IPL · spoke'), 'offline is expected, not an error')
        await page.click('button', 'Call the hub')
        await page.until(`!!document.querySelector('[role="alertdialog"]')?.textContent.includes('Rings the on-call stroke neurologist, Dr. Rajsrinivas')`, 3000, 'the phone path, confirmed')
        await page.click('[role="alertdialog"] button', 'Call now')
        await toastSays('Calling Dr. Rajsrinivas', 'Hub stroke line · logged against the case at')
        await page.click('button', 'ACTIVATE & REQUEST HUB')
        await toastSays('Code stroke activated', 'Dr. Rajsrinivas is on call.')
        text = await page.text()
        expect(text.includes('STROKE/26-27/0141 · clock running · 0 of 6 answered') && text.includes('none of them blocks'), 'activated while offline, six questions')
        expect(!(await has('Connect to the video call')), 'the session is not offered to a persona who cannot open it')
        expect((await page.evaluate(`[...document.querySelectorAll('#six-anticoag option')].filter((o) => o.value === 'Unknown').length`)) === 1, 'Unknown is offered once')
        await pick('#six-anticoag', 'Unknown')
        await page.click('button', 'Unknown')
        text = await page.text()
        expect(text.includes('2 of 6 answered') && text.includes('It is not treated as a no.'), 'unknown is an answer, and says what it means')
        await dismissToasts()
        await page.click('button', 'Upload the NCCT')
        await page.until(`document.body.textContent.includes('The hub has the full study.')`, 8000, 'the full study arrives')
        await page.click('button', 'The AI has read it')
        await page.until(`location.pathname === '/stroke/case/0141/imaging'`, 3000, 'on to the triage card')
      },
    },
    {
      name: 'Stroke acute (S-18-14): the LVO triage card — break-glass asked, never refused, audited and drawn once; ICH an explicit NO; G3 confirmed by a named clinician',
      async run() {
        await page.open('/stroke/case/0141/imaging', { persona: 'P-35' })
        expect(await drawn('S-18-14'), 'S-18-14 is drawn')
        let text = await page.text()
        expect(text.includes('NCCT head + CT angiogram · delivered 02:40, 4 min after reconstruction') && text.includes('confirm required'), 'the study and its delivery')
        expect(text.includes('unlocks thrombolysis') && text.includes('lvo-det v4.2.1') && text.includes('It never diagnoses.'), 'ICH NO unlocks, the model is named, G3 is said')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-18-14"] img[alt^="Axial non-contrast CT"]')`), 'the real scan, not a drawing')
        await page.click('button', 'Break glass')
        await toastSays('Break-glass access granted', 'Logged and reviewed within 24 hours.')
        const row = (await auditRows()).find((r) => r.event === 'ACCESS.BREAK_GLASS')
        expect(row && row.subject === 'SD-P-05' && row.actor === 'Dr. Rajsrinivas' && row.detail.includes('STROKE/26-27/0141'), `the break-glass is audited: ${JSON.stringify(row)}`)
        text = await page.text()
        expect(text.split('Break-glass access — logged and reviewed within 24 hours').length === 2 && !text.includes('You have no care relationship with this patient'), 'one amber strip, the banner’s')
        await page.click('[role="checkbox"]', 'I have reviewed this content')
        await page.click('button', 'Accept')
        await page.until(`document.body.textContent.includes('Finding confirmed')`, 3000, 'the finding is confirmed')
        text = await page.text()
        expect(text.includes('Dr. Rajsrinivas confirmed the LVO at') && text.includes('Confirmed by Dr. Rajsrinivas'), 'by a named clinician')
        await page.click('button', 'Escalate to the neuro-interventionist')
        await page.click('[role="alertdialog"] button', 'Call now')
        await toastSays('Calling Dr. Rajsrinivas', 'Logged against case STROKE/26-27/0141.')
        // With the AI off: no automated finding, and the radiologist is the route.
        await page.open('/stroke/case/0141/imaging?ai=off', { fresh: false })
        text = await page.text()
        expect(text.includes('Awaiting a radiologist read') && !text.includes('lvo-det v4.2.1'), 'the documented fallback')
        await page.click('button', 'Call the radiologist on call')
        await page.click('[role="alertdialog"] button', 'Call now')
        await toastSays('Calling the radiologist on call', 'Logged against case STROKE/26-27/0141.')
        // A haemorrhage gets its own card and never "ICH NO".
        await page.open('/stroke/case/0142/imaging', { persona: 'P-35' })
        text = await page.text()
        expect(text.includes('STROKE/26-27/0142 · NCCT head') && !text.includes('unlocks thrombolysis') && !text.includes('LEFT M1'), 'case 0142 reads its own scan')
      },
    },
    {
      name: 'Stroke acute (S-18-15): ASPECTS — the model’s score and the human’s, both kept; the disagreement said; not applicable to a haemorrhage',
      async run() {
        await page.open('/stroke/case/0141/aspects', { persona: 'P-13' })
        expect(await drawn('S-18-15'), 'S-18-15 is drawn')
        let text = await page.text()
        expect(text.includes('ASPECTS 8 of 10 · 2 regions affected') && text.includes('model 8/10'), 'the model’s eight')
        await rail('Scoring')
        expect((await page.text()).includes('Both scores are kept') && (await page.text()).includes('Adjusted by you'), 'the rail keeps both')
        await page.click('button', 'Show normal regions')
        await page.click('[role="group"][aria-label="M1 — anterior MCA cortex"] button', 'Affected')
        text = await page.text()
        expect(text.includes('ASPECTS 7 of 10 · 3 regions affected · 1 changed from the model') && text.includes('You have changed 1 region') && text.includes('Neither replaces the other.'), `the human’s seven, beside it: ${text.slice(0, 300)}`)
        expect(text.includes('model 8/10') && text.includes('7/10'), 'both scores on the total row')
        await page.click('button', 'Record both scores')
        await toastSays('ASPECTS 7 recorded', 'Model scored 8. Both are kept, with 1 region changed by you.')
        expect(await disabled('Recorded'), 'recorded once')
        await page.open('/stroke/case/0142/aspects', { persona: 'P-13' })
        text = await page.text()
        expect(text.includes('ASPECTS does not apply to this case') && text.includes('STROKE/26-27/0142 is a haemorrhage.'), 'a haemorrhage is told why')
      },
    },
    {
      name: 'Stroke acute (S-18-16): perfusion — core and penumbra on one axis, each threshold on its tile; AI-406 off loses the numbers, not the images',
      async run() {
        await page.open('/stroke/case/0141/perfusion', { persona: 'P-36' })
        expect(await drawn('S-18-16'), 'S-18-16 is drawn')
        let text = await page.text()
        expect(text.includes('core 18 mL · penumbra 96 mL · ratio 5.3 · target mismatch') && text.includes('Ischaemic core — already lost') && text.includes('< 0.4 favours collaterals'), 'the volumes and their thresholds')
        expect(text.includes('Small core with a large penumbra.') && text.includes('Core — rCBF < 30%'), 'the interpretation, once, and the maps')
        await page.click('button', 'EVT decision')
        await page.until(`location.pathname === '/stroke/case/0141/evt'`, 3000, 'on to the EVT decision')
        await page.open('/stroke/case/0141/perfusion?ai=off', { persona: 'P-36' })
        text = await page.text()
        expect(text.includes('Quantification is unavailable') && !text.includes('Small core with a large penumbra.'), 'the documented fallback')
        await page.open('/stroke/case/0140/perfusion', { persona: 'P-36' })
        expect((await page.text()).includes('STROKE/26-27/0140 was stood down as a stroke mimic. There is no infarct to score.'), 'a mimic is told why')
      },
    },
    {
      name: 'Stroke acute (S-18-17): thrombolysis — unknown never lifts a block; BP unblocks only when documented below 185/110; an override needs a reason; the second check and consent before the needle',
      async run() {
        await page.open('/stroke/case/0141/thrombolysis', { persona: 'P-38' })
        expect(await drawn('S-18-17'), 'S-18-17 is drawn')
        let text = await page.text()
        expect(text.includes('5 of 7 criteria clear · 2 blocking') && text.includes('2 items blocking thrombolysis'), `two items block: ${text.slice(0, 500)}`)
        expect(await disabled('Administer & stamp the needle'), 'nothing to give yet')
        // The old screen let "Answer unknown" lift the BP block.
        await page.click('button', 'Answer unknown')
        text = await page.text()
        expect(text.includes('5 of 7 criteria clear · 2 blocking'), 'an unknown BP still blocks')
        await page.click('button', 'Start treat-to-target')
        await setInput('input[placeholder="172"]', '190')
        await setInput('input[placeholder="94"]', '100')
        await page.click('button', 'Document this reading')
        await toastSays('Still above threshold', '190/100 is recorded, and the item stays blocked.')
        expect((await page.text()).includes('Documenting a reading is not the same as reaching the target.'), 'documented is not treated')
        await setInput('input[placeholder="172"]', '172')
        await setInput('input[placeholder="94"]', '94')
        await page.click('button', 'Document this reading')
        await toastSays('BP documented below threshold', '172/94 at')
        expect((await page.text()).includes('6 of 7 criteria clear · 1 blocking'), 'the BP item is unblocked')
        await page.click('button', 'Override with reason')
        await page.until(`!!document.querySelector('[role="alertdialog"]')`, 3000, 'the override asks')
        expect(await page.evaluate(`[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === 'Override').disabled`), 'an override needs a reason')
        await page.type('[role="alertdialog"] textarea', 'Family reports last apixaban dose 60 hours ago; pharmacy record agrees.')
        await page.click('[role="alertdialog"] button', 'Override')
        await toastSays('Contraindication overridden', 'Dr. Logesh · recorded against case STROKE/26-27/0141.')
        text = await page.text()
        expect(text.includes('7 of 7 criteria clear · second check outstanding') && text.includes('The second dose check is outstanding'), 'nothing blocks; the second check is next')
        expect(await disabled('Administer & stamp the needle'), 'still nothing to give')
        const options = await page.evaluate(`[...document.querySelectorAll('select[aria-label="Second checker"] option')].map((o) => o.textContent)`)
        expect(!options.some((o) => o.includes('Dr. Logesh · Spoke physician')) && !options.some((o) => o.includes('Billing') || o.includes('TPA desk')) && options.some((o) => o.includes('Sr. Grace Fernandes')), `a qualified second person, not the prescriber: ${options}`)
        await pick('select[aria-label="Second checker"]', 'Sr. Grace Fernandes')
        await page.click('button', 'Record the second check')
        await toastSays('Second check recorded', 'Sr. Grace Fernandes · 19.5 mg')
        expect((await page.text()).includes('consent outstanding'), 'consent is next')
        await dismissToasts()
        await page.click('[role="checkbox"]', 'Consent discussed and taken')
        expect((await page.text()).includes('ready to give') && !(await disabled('Administer & stamp the needle')), 'ready to give')
        await page.click('button', 'Administer & stamp the needle')
        await page.until(`!!document.querySelector('[role="alertdialog"]')?.textContent.includes('Stamping the needle closes the door-to-needle interval')`, 3000, 'the needle is confirmed')
        await page.click('[role="alertdialog"] button', 'Administer and stamp')
        await toastSays('Needle stamped · DTN', '19.5 mg given by Dr. Logesh, checked by Sr. Grace Fernandes. Target was 60 minutes.')
        expect(await disabled('Needle stamped'), 'and not again')
        await rail('Alongside')
        await page.click('button', 'Authorise in parallel')
        await toastSays('Pre-authorisation raised in parallel', 'It is not on the critical path.')
        // The second check is a rule, not a model: required with the AI off too.
        await page.open('/stroke/case/0141/thrombolysis?ai=off', { persona: 'P-38' })
        text = await page.text()
        expect(text.includes('the AI is off and it is still required.') && (await disabled('Administer & stamp the needle')), 'the second check with the AI off')
        // Another case sees its own rule-based eligibility, and nothing to give.
        await page.open('/stroke/case/0142/thrombolysis', { persona: 'P-38' })
        text = await page.text()
        expect(text.includes('STROKE/26-27/0142 is not eligible on the rule-based criteria') && text.includes('PRESENT on NCCT — absolute contraindication') && !(await has('Administer & stamp the needle')), 'a haemorrhage is never offered the needle')
      },
    },
    {
      name: 'Stroke acute (S-18-18): EVT selection — the criteria, a disagreement recorded not resolved (ten characters, never blocking), and no predicted outcome',
      async run() {
        await page.open('/stroke/case/0141/evt', { persona: 'P-36' })
        expect(await drawn('S-18-18'), 'S-18-18 is drawn')
        let text = await page.text()
        expect(text.includes('6 of 6 criteria clear · ready to select') && text.includes('Unknown → assess on table.'), 'the criteria, the unknown with its consequence')
        expect(!/Predicted outcome|mRS 0–2 at 90 days|mrs90-pred|58%/.test(text), 'AI-221’s forecast is gone')
        await page.click('button', 'Record a disagreement')
        await page.until(`!!document.querySelector('[role="alertdialog"]')?.textContent.includes('travels with it into the registry')`, 3000, 'the dialog')
        expect(await page.evaluate(`[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === 'Record it').disabled`), 'ten characters first')
        await pick('select[aria-label="Who disagrees"]', 'Dr. Rajsrinivas')
        await page.type('[role="alertdialog"] textarea', 'Reads the core as larger on the CBV map; would still proceed.')
        await page.click('[role="alertdialog"] button', 'Record it')
        await toastSays('Disagreement recorded', 'Dr. Rajsrinivas ·')
        text = await page.text()
        expect(text.includes('Disagreement recorded by Dr. Rajsrinivas') && text.includes('disagreement recorded') && text.includes('It sits alongside the decision'), 'recorded, alongside the decision')
        expect(!(await disabled('Select for thrombectomy')), 'and it does not block')
        await page.click('button', 'Select for thrombectomy')
        await toastSays('Selected for thrombectomy', 'Dr. Rajsrinivas at')
        expect(await disabled('Selected'), 'selected once')
        await rail('Decision')
        expect((await page.text()).includes('never blocking') && (await page.text()).includes('TPA negotiated'), 'cost, never blocking')
        await page.open('/stroke/case/0137/evt', { persona: 'P-36' })
        text = await page.text()
        expect(text.includes('STROKE/26-27/0137 is not eligible on the rule-based criteria') && !(await has('Select for thrombectomy')), 'a haemorrhage is not selected')
      },
    },
    {
      name: 'Stroke acute (S-18-19): the transfer — all four resources held atomically or none, a lost one named, door-out stamped once; no ETA forecast',
      async run() {
        await page.open('/stroke/case/0141/transfer', { persona: 'P-35' })
        expect(await drawn('S-18-19'), 'S-18-19 is drawn')
        let text = await page.text()
        expect(text.includes('DIDO 38/60 min · nothing held yet') && text.includes('The needle has not been stamped') && text.includes('All four are available'), 'nothing held, the needle first')
        expect(!/AI-616|amb-eta|ETA|by air/.test(text), 'AI-616’s ETA and the air-transport contradiction are gone')
        await page.click('button', 'Simulate a lost resource')
        text = await page.text()
        expect(text.includes('Cath lab is no longer available') && text.includes('The whole reservation is refused rather than partially committed.') && (await disabled('Hold all four')), 'a partial failure names the resource and holds nothing')
        await page.click('button', 'Restore the cath lab')
        await page.click('button', 'Hold all four')
        await page.until(`!!document.querySelector('[role="alertdialog"]')?.textContent.includes('reserved in one atomic action')`, 3000, 'the hold is confirmed')
        await page.click('[role="alertdialog"] button', 'Hold all four')
        await toastSays('Four resources held', 'Atomic reservation by Dr. Rajsrinivas at')
        text = await page.text()
        expect(text.includes('four resources held') && text.includes('All four held atomically'), 'held, all four')
        await dismissToasts()
        await page.click('button', 'Load and stamp door-out')
        await toastSays('Door-out stamped', 'DIDO closed at 38 min.')
        expect(await disabled('Door-out stamped'), 'door-out is stamped once')
        await dismissToasts()
        await page.click('button', 'Show handover pack')
        expect((await page.text()).includes('Thrombolysis time, dose and second checker'), 'the handover pack')
        await rail('Transfer')
        expect((await page.text()).includes('Door-in to door-out at the spoke'), 'the DIDO clock in the rail')
        await page.open('/stroke/case/0142/transfer', { persona: 'P-35' })
        text = await page.text()
        expect(text.includes('Nothing is recorded on this screen for STROKE/26-27/0142') && !(await has('Hold all four')), 'another case borrows no reservation')
      },
    },
    {
      name: 'Stroke acute (S-18-20): the registry — calls due first, a call moves completeness, the scopes, the indicators, the export; AI-708’s reason only with the AI on',
      async run() {
        await page.open('/stroke/registry', { persona: 'P-35' })
        expect(await drawn('S-18-20'), 'S-18-20 is drawn')
        const rows = () => page.evaluate(`[...document.querySelectorAll('ul[aria-label="Stroke cases and their 90-day outcomes"] > li')].map((li) => li.textContent)`)
        let text = await page.text()
        expect(text.includes('40% follow-up complete against a 90% target · 2 calls due') && text.includes('2 follow-up calls outstanding') && text.includes('Day 88 of the 90-day window'), 'the calls due, and why now')
        let list = await rows()
        expect(list.length === 2 && list[0].includes('0126') && list[1].includes('Unreachable — 3 attempts'), `calls due: ${list}`)
        await page.click('button[aria-label="Call now, STROKE/26-27/0126"]')
        await toastSays('B.N. reached', 'mRS recorded. Completeness has moved.')
        text = await page.text()
        expect(text.includes('60% follow-up complete against a 90% target · 1 call due'), 'completeness has moved')
        await page.click('[role="tab"]', 'Window open')
        list = await rows()
        expect(list.length === 1 && list[0].includes('0137') && list[0].includes('Window open'), `window open: ${list}`)
        await page.click('[role="tab"]', 'Done')
        list = await rows()
        expect(list.length === 3 && list.some((r) => r.includes('mRS collected')) && list.some((r) => r.includes('mRS 1 · No significant disability')), `done: ${list}`)
        text = await page.text()
        expect(text.includes('90-day follow-up completeness') && text.includes('Missed') && text.includes('target ≤ 60 min'), 'the indicators against target')
        await page.click('button', 'Export')
        await toastSays('Registry export prepared', 'The recipient and the fields are recorded.')
        await page.open('/stroke/registry?ai=off', { persona: 'P-35' })
        text = await page.text()
        expect(text.includes('2 follow-up calls outstanding') && !text.includes('Day 88 of the 90-day window'), 'no AI-708 reason with the AI off')
      },
    },
  ]
}
