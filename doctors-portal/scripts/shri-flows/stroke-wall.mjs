/**
 * Stroke, part A (M-18): the network wall (S-18-01) and the case view that
 * expands over it (S-18-02), site readiness (S-18-03), code stroke (S-18-04),
 * intake (S-18-05), the case clock (S-18-06), the task board (S-18-07),
 * timestamps (S-18-08), team (S-18-09) and the telestroke queue (S-18-10).
 * Loaded by scripts/shri-flows.mjs.
 */

export default ({ page, expect, toastSays }) => {
  const drawn = (id) => page.evaluate(`!!document.querySelector('[data-screen-id="${id}"]')`)
  /** innerText reports CSS-uppercased headings in capitals, so the words are compared without case. */
  const has = (text, t) => text.toLowerCase().includes(t.toLowerCase())
  const auditOf = async (event) => (await page.evaluate(`JSON.parse(localStorage.getItem('indostates.audit') ?? '{"state":{"rows":[]}}').state.rows`)).filter((r) => r.event === event)
  /** The case clock's own store, from the dev server's module graph — the same instance the page runs. Sets the case time N minutes past 02:52. */
  const caseTimePlus = (min) => page.evaluate(`import('/src/store/stroke.ts').then((m) => { m.useStroke.setState({ elapsedSec: ${min} * 60 }); return true })`)
  const strokeState = () => page.evaluate(`import('/src/store/stroke.ts').then((m) => JSON.parse(JSON.stringify(m.useStroke.getState())))`)
  /** Moves a board card with its "Move to" choice — the keyboard and touch path, through the same hard rules as a drop. */
  const moveCard = (label, column) =>
    page.evaluate(`(() => {
      const el = [...document.querySelectorAll('label select')].find((s) => s.parentElement.textContent.includes('Move ${label} to'))
      if (!el) throw new Error('no move for ${label}')
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, '${column}')
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  const noForecast = (text, where) => expect(!/projected|predict|ETA \d|~\d+m\b/i.test(text), `no forecast on ${where}`)

  return [
    {
      name: 'Stroke A (S-18-01): the wall — the index case with its rings, another case with none borrowed, no ETA; STALE dims, OFFLINE declares the partition',
      async run() {
        await page.open('/stroke/wall', { persona: 'P-35' })
        expect(await drawn('S-18-01'), 'S-18-01 is drawn')
        let text = await page.text()
        for (const t of ['Stroke network', 'Active cases', 'STROKE/26-27/0141', 'STROKE/26-27/0142', 'No intervals recorded for STROKE/26-27/0142.', 'LVO LEFT M1 · HIGH', 'Network', 'Resources', 'CATH-1', 'Dr. R. Desai (phone)', 'AMB-IPL-03 · IPL → ICH', 'On site at IPL', '3 activations · DTN median 41 min · 1 transfer · 1 mimic'])
          expect(has(text, t), `the wall says "${t}"`)
        expect(await page.evaluate(`document.querySelectorAll('section[aria-label="Active cases"] svg[role="img"]').length === 4`), 'four rings, on the index case only')
        expect(has(text, 'Administer tenecteplase and stamp the needle') && has(text, '· Dr. Rohit Desai'), 'the next action and its owner')
        noForecast(text, 'the wall')
        await page.open('/stroke/wall?ai=off', { persona: 'P-35' })
        text = await page.text()
        expect(!text.includes('LVO LEFT M1') && text.includes('AI findings hidden · clocks and resources unaffected'), 'AI off: the finding hides, the clocks do not')
        await page.open('/stroke/wall?state=STALE', { persona: 'P-35' })
        expect((await page.text()).includes('LAST GOOD DATA'), 'STALE states its last-good time')
        await page.open('/stroke/wall?state=OFFLINE', { persona: 'P-35' })
        text = await page.text()
        expect(text.includes('Network partition') && text.includes('a case that disappears is a case nobody is watching'), 'OFFLINE declares the partition')
        await page.click('button', 'exit wall')
        await page.until(`location.pathname === '/'`, 3000, 'exit wall goes to My Day')
        await page.open('/stroke/wall', { persona: 'P-38' })
        await page.click('button', 'exit wall')
        await page.until(`location.pathname === '/stroke/spoke'`, 3000, 'a persona without My Day leaves the wall for their own landing')
      },
    },
    {
      name: 'Stroke A (S-18-02): a case expands in place over the wall, focus inside, Esc back to the wall; another case borrows nothing',
      async run() {
        await page.open('/stroke/wall', { persona: 'P-35' })
        await page.click('section[aria-label="Active cases"] button', 'STROKE/26-27/0141')
        await page.until(`!!document.querySelector('[role="dialog"][data-screen-id="S-18-02"]')`, 3000, 'S-18-02 expands')
        let text = await page.evaluate(`document.querySelector('[data-screen-id="S-18-02"]').innerText`)
        for (const t of ['Vikram Malhotra', 'IPL → ICH', 'TPA cashless', 'NIHSS 14', 'break-glass: Dr. Rohit Desai', 'Live intervals', 'LVO · M1', 'ICH no', 'G3 confirm required', '4 of 5 answered', '1 no answer', 'In progress', 'BP treated to target < 185/110', 'Load ambulance for transfer', 'Blocked · 19m', 'Open the case clock'])
          expect(has(text, t), `the case view says "${t}"`)
        noForecast(text, 'the case view')
        expect(await page.evaluate(`document.querySelector('[data-screen-id="S-18-02"]').contains(document.activeElement)`), 'focus moved into the case view')
        await page.key('Escape')
        await page.until(`!document.querySelector('[data-screen-id="S-18-02"]')`, 3000, 'Esc goes back to the wall')
        expect(await drawn('S-18-01'), 'still on the wall')
        await page.click('section[aria-label="Active cases"] button', 'STROKE/26-27/0142')
        text = await page.evaluate(`document.querySelector('[data-screen-id="S-18-02"]').innerText`)
        expect(text.includes('No intervals recorded for STROKE/26-27/0142.') && text.includes('No pages recorded for STROKE/26-27/0142.') && text.includes('ICH ~48 mL · anticoagulated · HIGH'), `0142 has its own finding and none of 0141's clocks: ${text}`)
        await page.click('[data-screen-id="S-18-02"] button', 'Back to the wall')
        await page.until(`!document.querySelector('[data-screen-id="S-18-02"]')`, 3000, 'Back to the wall')
        await page.click('section[aria-label="Active cases"] button', 'STROKE/26-27/0141')
        await page.click('[data-screen-id="S-18-02"] button', 'Open the case clock')
        await page.until(`location.pathname === '/stroke/case/0141/clock'`, 3000, 'the case clock opens')
      },
    },
    {
      name: 'Stroke A (S-18-03): site readiness — flagged first, ready one tap away; AI-622\'s failure prediction is not shown and the rail says so',
      async run() {
        await page.open('/stroke/network/sites', { persona: 'P-35' })
        expect(await drawn('S-18-03'), 'S-18-03 is drawn')
        await page.click('aside[aria-label="Readiness"] button[title="Show Readiness"]')
        let text = await page.text()
        for (const t of ['Site readiness', '4 sites · 2 fully ready · 2 flagged · 1 transfer-only', 'ITP', '2 of 6 ED staff overdue for stroke competency refresher', 'IUD', '⊘ No CT — transfer-only site. All activations route out.', 'Transfer-only', '1 · IUD, no CT', '1 equipment-failure prediction (AI-622) is not shown or counted'])
          expect(has(text, t), `the flagged slice says "${t}"`)
        expect(!text.includes('AI-622 predicts') && !text.includes('gantry'), 'the AI-622 forecast is not on the page')
        await page.click('[role="tab"]', 'Ready')
        await page.until(`location.search === '?scope=ready'`, 3000, 'the slice is in the URL')
        text = await page.text()
        expect(has(text, 'ICH') && has(text, 'IPL') && has(text, 'No readiness flags tonight') && !has(text, 'Udumalpet'), `the ready slice: ICH and IPL — ${text.slice(0, 400)}`)
      },
    },
    {
      name: 'Stroke A (S-18-04): code stroke — one tap, never gated, first on the page; activation is audited, the unanswered page surfaces, and the next steps open',
      async run() {
        await page.open('/stroke/activate', { persona: 'P-38' })
        expect(await drawn('S-18-04'), 'S-18-04 is drawn')
        let text = await page.text()
        for (const t of ['Code stroke', 'one tap, nothing required first', 'A possible stroke has been detected from the triage note', 'AI-209', 'Activate a code stroke', 'ACTIVATE CODE STROKE', 'Always enabled · works offline · works with the AI off', 'Optional context', 'none of it gates the activation', 'Unknown is acceptable'])
          expect(has(text, t), `before activation: "${t}"`)
        await page.click('button', 'ACTIVATE CODE STROKE')
        await toastSays('Code stroke activated', 'STROKE/26-27/0141 · clock started at 02:5')
        text = await page.text()
        for (const t of ['Activated · 4 of 5 answered', 'Activated · STROKE/26-27/0141', 'stamped from the server', 'Paging', 'Unanswered · 1', 'Neuro-interventionist', 'no answer yet', 'Open the case clock', 'Complete the intake', 'Telestroke queue'])
          expect(has(text, t), `after activation: "${t}"`)
        expect(!has(text, 'A possible stroke has been detected'), 'the prompt goes once the code is activated')
        const row = (await page.evaluate(`JSON.parse(localStorage.getItem('indostates.audit') ?? '{"state":{"rows":[]}}').state.rows`)).find((r) => r.event === 'STROKE.CODE_ACTIVATED')
        expect(row && row.subject === 'SD-P-05' && /STROKE\/26-27\/0141 · clock started 02:5\d · IPL · Walk-in to the emergency department · LKW unknown/.test(row.detail) && !row.queued, `the audit row: ${JSON.stringify(row)}`)
        await page.click('button', 'Complete the intake')
        await page.until(`location.pathname === '/stroke/case/0141/intake'`, 3000, 'the intake opens')
      },
    },
    {
      name: 'Stroke A (S-18-04): offline and with the AI off, the button still fires — the activation queues and says so',
      async run() {
        await page.open('/stroke/activate?ai=off&state=OFFLINE', { persona: 'P-06' })
        let text = await page.text()
        expect(has(text, 'No connection — activation still works') && !has(text, 'A possible stroke has been detected'), 'offline, no AI prompt')
        await page.click('button', 'ACTIVATE CODE STROKE')
        await toastSays('Code stroke activated')
        const row = (await page.evaluate(`JSON.parse(localStorage.getItem('indostates.audit') ?? '{"state":{"rows":[]}}').state.rows`)).find((r) => r.event === 'STROKE.CODE_ACTIVATED')
        expect(row && row.queued === true, `queued while offline: ${JSON.stringify(row)}`)
        text = await page.text()
        expect(!has(text, 'Complete the intake') && has(text, 'Open the case clock'), 'a P-06 cannot write the intake, so it is not offered')
      },
    },
    {
      name: 'Stroke A (S-18-05): intake — AI-112 fills a field on accept, only an accepted extraction counts as confirmed, the exclusions line says what is recorded, and Save is kept and audited',
      async run() {
        await page.open('/stroke/case/0141/intake', { persona: 'P-35' })
        expect(await drawn('S-18-05'), 'S-18-05 is drawn')
        let text = await page.text()
        for (const t of ['Intake', '0 of 5 extracted fields confirmed · 1 at low confidence', 'STROKE/26-27/0141', 'LKW 01:20', 'The six that change the decision', 'Weight, measured or estimated', 'Pre-stroke function', 'None recorded · a no is as useful as a yes', 'Next of kin and consent', 'Nothing here blocks the clock'])
          expect(has(text, t), `the intake says "${t}"`)
        await page.click('button[aria-label="Accept 196/104"]')
        expect(await page.evaluate(`document.getElementById('intake-bp').value`) === '196/104', 'accepting fills the field')
        await page.click('button[aria-label="Dismiss 01:20"]')
        text = await page.text()
        expect(has(text, '1 of 5 extracted fields confirmed'), `a dismissed extraction is not confirmed: ${text.slice(0, 300)}`)
        await page.click('button', 'Show exclusions')
        await page.evaluate(`(() => { const el = document.getElementById('intake-ex-1'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'Yes'); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
        expect(has(await page.text(), 'Prior intracranial haemorrhage: Yes'), 'the exclusions line says what is recorded')
        await page.click('button', 'Save')
        await toastSays('Intake saved', 'Saved as it stands. You can come back to it; the case clock is unaffected.')
        const row = (await page.evaluate(`JSON.parse(localStorage.getItem('indostates.audit') ?? '{"state":{"rows":[]}}').state.rows`)).find((r) => r.event === 'STROKE.INTAKE_SAVED')
        expect(row && row.subject === 'SD-P-05' && row.detail.includes('1 of 6 fields · 1 extracted and accepted') && row.detail.includes('Prior intracranial haemorrhage: Yes'), `the audit row: ${JSON.stringify(row)}`)
        await page.click('button', 'Save and return to the clock')
        await toastSays('Intake saved', 'The hub has the full picture.')
        await page.until(`location.pathname === '/stroke/case/0141/clock'`, 3000, 'back to the clock')
        await page.evaluate(`history.back()`)
        await page.until(`!!document.getElementById('intake-bp')`, 3000, 'the intake again')
        expect(await page.evaluate(`document.getElementById('intake-bp').value`) === '196/104', 'you can come back to it')
      },
    },
    {
      name: 'Stroke A (S-18-05): another case gets no one else\'s triage note, and an unknown case says so',
      async run() {
        await page.open('/stroke/case/0142/intake', { persona: 'P-35' })
        const text = await page.text()
        expect(has(text, 'Six fields, entered by hand · no triage note is on file for STROKE/26-27/0142') && !has(text, 'No warfarin') && !(await page.evaluate(`!!document.querySelector('button[aria-label^="Accept"]')`)), '0142 is typed by hand')
        await page.open('/stroke/case/NOPE/intake', { persona: 'P-35' })
        expect(has(await page.text(), 'There is no stroke case with the id “NOPE”. Open one from the network wall.'), 'an unknown case says so')
      },
    },
    {
      name: 'Stroke A (S-18-06): the case clock — `e` stamps only the focused event, append-only and audited; the needle closes DTN; no projected breach',
      async run() {
        await page.open('/stroke/case/0141/clock', { persona: 'P-35' })
        expect(await drawn('S-18-06'), 'S-18-06 is drawn')
        let text = await page.text()
        for (const t of ['Case clock', '3 running · 0 breached · 4 complete', 'Intervals', 'Running · 3', 'Door → needle', 'next: Administer tenecteplase and stamp the needle · Dr. Rohit Desai', 'next: Load the ambulance · Sr. Grace Fernandes', 'Stamp an event', 'one tap or one keystroke · append-only', 'stamped 02:41', 'to stamp the focused event', 'De-activate the case'])
          expect(has(text, t), `the clock says "${t}"`)
        noForecast(text, 'the case clock')
        // A stray e with nothing focused stamps nothing.
        await page.evaluate(`document.activeElement?.blur(); true`)
        await page.key('e')
        expect((await auditOf('STROKE.EVENT_STAMPED')).length === 0, 'a stray e stamps nothing')
        await page.evaluate(`document.querySelector('button[aria-label="Stamp Needle"]').focus(); true`)
        expect(has(await page.text(), 'press e, or tap'), 'the focused event says so')
        await page.key('e')
        await toastSays('Needle stamped', '· append-only')
        text = await page.text()
        expect(has(text, '2 running · 0 breached · 5 complete'), `the needle closes DTN: ${text.slice(0, 600)}`)
        let rows = await auditOf('STROKE.EVENT_STAMPED')
        expect(rows.length === 1 && rows[0].subject === 'SD-P-05' && rows[0].detail.startsWith('STROKE/26-27/0141 · Needle stamped 02:5') && !rows[0].queued, `the audit row: ${JSON.stringify(rows)}`)
        await page.evaluate(`document.querySelector('button[aria-label^="Needle, stamped"]').focus(); true`)
        await page.key('e')
        expect((await auditOf('STROKE.EVENT_STAMPED')).length === 1 && (await strokeState()).stamps.length === 1, 'append-only: the needle is not stamped twice')
      },
    },
    {
      name: 'Stroke A (S-18-06): a real breach — over target, unstamped — offers the reason capture with the AI off too; it is recorded and audited',
      async run() {
        await page.open('/stroke/case/0141/clock?ai=off', { persona: 'P-35' })
        expect(!has(await page.text(), 'has breached'), 'nothing has breached at 02:52')
        await caseTimePlus(23)
        await page.until(`document.body.innerText.includes('Door-in → door-out has breached its 60-minute target')`, 3000, 'DIDO breaches at 03:15')
        let text = await page.text()
        for (const t of ['Door → needle has breached its 60-minute target', 'Blocking: Ambulance not loaded — AMB-IPL-03 is on site but the trolley has not moved', '3 running · 2 breached · 4 complete']) expect(has(text, t), `the breach says "${t}"`)
        noForecast(text, 'the breached clock')
        await page.click('[role="alert"] button', 'Capture the reason')
        await page.until(`!!document.querySelector('[role="alertdialog"]')?.textContent.includes('A reason written three weeks later at audit is not the same evidence')`, 3000, 'the capture dialog')
        await page.evaluate(`(() => { const el = document.getElementById('breach-reason'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'Awaiting family consent'); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
        await page.type('[role="alertdialog"] textarea', 'Wife on the phone, on her way in')
        await page.click('[role="alertdialog"] button', 'Record the reason')
        await toastSays('Breach reason recorded', 'Awaiting family consent · 03:15')
        text = await page.text()
        expect(has(text, 'Breach reasons captured') && has(text, 'Wife on the phone, on her way in') && has(text, 'reason captured 03:15'), 'the reason is on the clock')
        const rows = await auditOf('STROKE.BREACH_REASON_CAPTURED')
        expect(rows.length === 1 && rows[0].detail.includes('Awaiting family consent — “Wife on the phone, on her way in”') && rows[0].at.includes('T'), `the audit row: ${JSON.stringify(rows)}`)
      },
    },
    {
      name: 'Stroke A (S-18-06): offline, a stamp is pending and its row queued; back online both are written. De-activation keeps its reason and moves the case off the active wall',
      async run() {
        await page.open('/stroke/case/0141/clock?state=OFFLINE', { persona: 'P-35' })
        expect(has(await page.text(), 'Stamping is queueing locally'), 'the offline note')
        await page.click('button[aria-label="Stamp Door-out"]')
        await toastSays('Door-out stamped')
        expect((await strokeState()).stamps[0].pending === true && (await auditOf('STROKE.EVENT_STAMPED'))[0].queued === true, 'pending and queued')
        await page.evaluate(`window.__forceState(null)`)
        await page.until(`true`, 500)
        const st = await strokeState()
        expect(st.stamps[0].pending === false && !(await auditOf('STROKE.EVENT_STAMPED'))[0].queued, `written once back online: ${JSON.stringify(st.stamps)}`)
        await page.click('button', 'De-activate the case')
        await page.until(`!!document.querySelector('[role="alertdialog"]')?.textContent.includes('this is how a stroke mimic is recorded honestly rather than deleted')`, 3000, 'the de-activation dialog')
        await page.evaluate(`(() => { const el = document.querySelector('[role="alertdialog"] select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'Stroke mimic — migraine'); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
        await page.click('[role="alertdialog"] button', 'De-activate with a reason')
        await toastSays('Case de-activated', 'The clock is closed. The record remains.')
        await page.until(`location.pathname === '/stroke/wall'`, 3000, 'back to the wall')
        const rows = await auditOf('STROKE.CASE_DEACTIVATED')
        expect(rows.length === 1 && rows[0].detail.startsWith('STROKE/26-27/0141 · Stroke mimic — migraine · de-activated 02:5'), `the audit row: ${JSON.stringify(rows)}`)
        await page.click('button', 'Show de-activated')
        const text = await page.text()
        expect(await page.evaluate(`[...document.querySelectorAll('section[aria-label="Active cases"] > div > button')].length === 1`) && has(text, 'IPL · Stroke mimic — migraine. De-activated 02:5'), `0141 leaves the active rail with its reason: ${text.slice(0, 900)}`)
      },
    },
    {
      name: 'Stroke A (S-18-06): another case borrows none of the index case\'s clock, and an unknown case says so',
      async run() {
        await page.open('/stroke/case/0142/clock', { persona: 'P-35' })
        const text = await page.text()
        expect(has(text, 'No intervals recorded for STROKE/26-27/0142.') && has(text, 'No events recorded for STROKE/26-27/0142.') && has(text, '0 running · 0 breached · 0 complete') && !(await page.evaluate(`!!document.querySelector('button[aria-label^="Stamp "]')`)), '0142 has nothing of 0141 to stamp')
        await page.open('/stroke/case/NOPE/clock', { persona: 'P-35' })
        expect(has(await page.text(), 'There is no stroke case with the id “NOPE”.'), 'an unknown case says so')
      },
    },
    {
      name: 'Stroke A (S-18-07): the task board — a clinically wrong move is refused with the reason on the column; a move is audited; the ambulance task unblocks itself once the needle is stamped',
      async run() {
        await page.open('/stroke/case/0141/tasks', { persona: 'P-35' })
        expect(await drawn('S-18-07'), 'S-18-07 is drawn')
        let text = await page.text()
        for (const t of ['Task board', '1 to do · 3 in progress · 1 blocked · 3 done', '1 task blocked', 'Load ambulance for transfer cannot move until the needle is stamped — the card says why.', 'Cannot load before the needle is given — drip-and-ship requires the bolus first', 'Blocks thrombolysis — highest-value next action', 'Drag a card · a refused drop names the clinical reason on the column', 'server 02:5'])
          expect(has(text, t), `the board says "${t}"`)
        expect(!has(text, 'DIDO projected breach'), 'T-07\'s AI-209 projection is not shown')
        await moveCard('Load ambulance for transfer', 'In progress')
        text = await page.text()
        expect(has(text, 'The needle has not been stamped. Drip-and-ship requires the bolus before the patient is loaded'), 'the refusal lands on the column')
        expect((await auditOf('STROKE.TASK_MOVED')).length === 0, 'a refused move writes nothing')
        await moveCard('Tenecteplase second dose check', 'Done')
        expect(has(await page.text(), 'The second dose check cannot go straight to done.'), 'the dose check cannot be ticked off from here')
        await moveCard('BP treated to target < 185/110', 'Done')
        await toastSays('BP treated to target < 185/110 → Done', 'owner Dr. Priya Menon')
        const rows = await auditOf('STROKE.TASK_MOVED')
        expect(rows.length === 1 && rows[0].detail === 'STROKE/26-27/0141 · BP treated to target < 185/110 → Done · owner Dr. Priya Menon', `the audit row: ${JSON.stringify(rows)}`)
        await page.evaluate(`import('/src/store/stroke.ts').then((m) => { m.useStroke.getState().stamp('needle', 'Needle', 'Dr. Rohit Desai'); return true })`)
        await page.until(`document.body.innerText.includes('0 blocked')`, 3000, 'the ambulance task unblocks itself once the needle is stamped')
        expect(!has(await page.text(), 'task blocked'), 'and the blocked alert goes')
        await page.open('/stroke/case/0141/tasks?ai=off', { persona: 'P-35' })
        text = await page.text()
        expect(!has(text, 'Blocks thrombolysis — highest-value next action') && !has(text, 'AI-619 orders the cards'), 'AI off: no prioritisation lines')
        await page.open('/stroke/case/0142/tasks', { persona: 'P-35' })
        expect(has(await page.text(), 'No tasks recorded for STROKE/26-27/0142.'), 'another case borrows none')
      },
    },
    {
      name: 'Stroke A (S-18-08): timestamps — the resolved conflicts beside their sources; an amendment waits for ten characters, is appended beside the conflict and audited; the stream shows this session\'s stamps',
      async run() {
        await page.open('/stroke/case/0141/events', { persona: 'P-35' })
        expect(await drawn('S-18-08'), 'S-18-08 is drawn')
        let text = await page.text()
        for (const t of ['Timestamps', '0 unresolved · 2 resolved · 0 stamped this session', 'Both timestamp conflicts are resolved.', 'Event stream', 'Nothing stamped yet in this session. Stamping happens on the case clock, one keystroke each.'])
          expect(has(text, t), `the unresolved slice says "${t}"`)
        await page.click('[role="tab"]', 'Resolved')
        text = await page.text()
        for (const t of ['Door time', '3 sources · 5 min apart', 'ED triage entry (IPL)', 'Ambulance handover form', 'CCTV entry log', 'Server-authoritative', 'A disputed door time is a disputed door-to-needle. The 5-minute spread changes DTN from 41 to 46.', 'CT start', 'DICOM header preferred over manual entry'])
          expect(has(text, t), `the resolved slice says "${t}"`)
        await page.click('button', 'Amend with a reason')
        await page.until(`!!document.querySelector('[role="alertdialog"]')?.textContent.includes('Amend the door time?')`, 3000, 'the amendment dialog')
        expect(await page.evaluate(`[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.includes('Append the amendment')).disabled`), 'Append waits for a reason')
        await page.type('#amend-rationale', 'CCTV shows 02:12')
        await page.click('[role="alertdialog"] button', 'Append the amendment')
        await toastSays('Amendment appended', 'Dr. Rohit Desai · 02:5')
        text = await page.text()
        expect(has(text, 'CCTV shows 02:12') && has(text, 'Amendment appended by Dr. Rohit Desai'), 'the amendment sits beside the conflict')
        const rows = await auditOf('STROKE.TIMESTAMP_AMENDED')
        expect(rows.length === 1 && rows[0].detail === 'STROKE/26-27/0141 · Door time · “CCTV shows 02:12”', `the audit row: ${JSON.stringify(rows)}`)
        await page.evaluate(`import('/src/store/stroke.ts').then((m) => { m.useStroke.getState().stamp('needle', 'Needle', 'Dr. Rohit Desai'); return true })`)
        await page.until(`document.body.innerText.includes('1 stamps this session')`, 3000, 'the stream shows the stamp')
        expect(has(await page.text(), 'committed'), 'committed')
        await page.open('/stroke/case/0142/events', { persona: 'P-35' })
        expect(has(await page.text(), 'No timestamp conflicts recorded for STROKE/26-27/0142.'), 'another case borrows none')
      },
    },
    {
      name: 'Stroke A (S-18-09): team — the unanswered page first with its alert; Escalate re-pages, is audited and holds; the answered are one tap away',
      async run() {
        await page.open('/stroke/case/0141/team', { persona: 'P-35' })
        expect(await drawn('S-18-09'), 'S-18-09 is drawn')
        let text = await page.text()
        for (const t of ['Team', '4 of 5 answered · 1 no answer · median 4 min', 'Neuro-interventionist has not answered', 'Dr. Samir Kulkarni was paged at 02:38 on push + call — the ladder escalates on its own, or you can push it now.', '14 min, no answer', '1 page'])
          expect(has(text, t), `the unanswered slice says "${t}"`)
        await page.click('button', 'Escalate')
        await toastSays('Neuro-interventionist re-paged', 'Escalated to step 3 — the second contact on the rota is being called.')
        expect(has(await page.text(), 'escalated') && !(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Escalate')`)), 'escalated, and not twice')
        const rows = await auditOf('STROKE.PAGE_ESCALATED')
        expect(rows.length === 1 && rows[0].detail.startsWith('STROKE/26-27/0141 · Neuro-interventionist (Dr. Samir Kulkarni) re-paged at 02:5'), `the audit row: ${JSON.stringify(rows)}`)
        await page.click('[role="tab"]', 'Answered')
        text = await page.text()
        for (const t of ['Stroke neurologist', 'answered in 2 min', 'answered 02:18', 'Anaesthetist on call', '4 pages'])
          expect(has(text, t), `the answered slice says "${t}"`)
        await page.open('/stroke/case/0142/team', { persona: 'P-35' })
        text = await page.text()
        expect(has(text, 'No pages recorded for STROKE/26-27/0142.') && has(text, '0 of 0 answered'), 'another case borrows none')
      },
    },
    {
      name: 'Stroke A (S-18-10): the telestroke queue — inside the window first, outside one tap away and still answered; the window runs with the clock; arrival order with the AI off',
      async run() {
        const rows = () => page.evaluate(`[...document.querySelectorAll('ul[aria-label="Telestroke requests from the network"] > li')].map((li) => li.textContent)`)
        await page.open('/stroke/telestroke/queue', { persona: 'P-35' })
        expect(await drawn('S-18-10'), 'S-18-10 is drawn')
        await page.click('button', 'How the queue is ranked')
        let text = await page.text()
        for (const t of ['Telestroke queue', '2 requests · 1 inside the window · 1 in session · ranked by clock, not arrival', 'STROKE/26-27/0141', '2h 58m', 'LVO left M1 · HIGH', 'LKW 1h 32m ago', 'In session', 'Rejoin', 'Time value', 'Decision to the spoke', 'recomputed every second against the server clock (02:5'])
          expect(has(text, t), `the queue says "${t}"`)
        expect((await rows()).length === 1, 'one request inside the window')
        await page.click('[role="tab"]', 'Outside window')
        text = await page.text()
        expect(has(text, 'closed') && has(text, 'STROKE/26-27/0139') && has(text, 'No LVO detected') && has(text, 'LKW 5h 10m ago') && has(text, 'Start'), `outside the window, still in the queue — ${text.slice(0, 900)}`)
        await page.click('[role="tab"]', 'In window')
        await caseTimePlus(60)
        await page.until(`document.body.innerText.includes('1h 58m')`, 3000, 'the window runs with the clock')
        expect(has(await page.text(), 'LKW 2h 32m ago'), 'and so does LKW')
        await page.open('/stroke/telestroke/queue?ai=off', { persona: 'P-35' })
        text = await page.text()
        expect(has(text, 'in arrival order') && has(text, 'awaiting a read') && !has(text, 'LVO left M1'), 'AI off: arrival order, no finding')
        await page.open('/stroke/telestroke/queue', { persona: 'P-35' })
        await page.click('button', 'Rejoin')
        await page.until(`location.pathname === '/stroke/case/0141/telestroke'`, 3000, 'Rejoin opens the session')
      },
    },
  ]
}
