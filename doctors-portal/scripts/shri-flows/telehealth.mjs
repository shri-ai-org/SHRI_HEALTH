/**
 * Telehealth (M-27): the teleconsult queue (S-27-02), the session (S-27-03)
 * and the tele-prescription with its hard-coded category gate (S-27-04).
 * Loaded by scripts/shri-flows.mjs.
 */

export default ({ page, expect, toastSays }) => {
  const queue = () => page.evaluate(`[...document.querySelectorAll('ul[aria-label="Today\\'s teleconsults"] > li')].map((li) => li.textContent)`)
  const signDisabled = () => page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Sign the tele-prescription')).disabled`)

  return [
    {
      name: 'Telehealth (S-27-02): today’s teleconsults, video-ready first with the AI on and by appointment time with it off; a row opens the session',
      async run() {
        await page.open('/tele/queue')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-27-02"]')`), 'S-27-02 is drawn')
        expect((await page.text()).includes('3 today'), 'the count')
        let rows = await queue()
        expect(rows.length === 3 && rows[2].includes('Fatima Bi') && rows[2].includes('telephone fallback'), `the telephone fallback goes last by readiness: ${rows}`)
        await page.open('/tele/queue?ai=off', { fresh: false })
        rows = await queue()
        expect(rows[0].includes('09:05') && rows[1].includes('09:35') && rows[2].includes('10:05'), `appointment time with the AI off: ${rows}`)
        await page.click('ul[aria-label="Today\'s teleconsults"] > li > button', 'Arjun Nair')
        await page.until(`/^\\/tele\\/session\\/[^/]+$/.test(location.pathname) && !!document.querySelector('[data-screen-id="S-27-03"]')`, 3000, 'the session opens')
      },
    },
    {
      name: 'Telehealth (S-27-03): the call is joined on purpose, ended with a confirmation, and an unknown id says so',
      async run() {
        await page.open('/tele/session/ICH-0044240')
        let text = await page.text()
        expect(text.includes('Arjun Nair') && text.includes('Ready to join') && text.includes('Join the call to start the session'), 'not joined on arrival')
        await page.click('aside[aria-label="Session"] button[title="Show Session"]')
        text = await page.text()
        expect(text.includes('taken') && text.includes('declined') && text.includes('The patient declined recording'), 'the consent card, in the rail')
        await page.click('button', 'Join call')
        await page.until(`document.body.textContent.includes('in session')`, 3000, 'in session, with its clock')
        // Joined: In room on My Day, as a called-in clinic patient would be.
        const arjunOnMyDay = () => page.evaluate(`[...document.querySelectorAll('[aria-label="Today\\'s OPD patients"] li')].find((li) => li.textContent.includes('Arjun Nair'))?.textContent ?? ''`)
        await page.open('/', { fresh: false })
        expect((await arjunOnMyDay()).includes('In room') && (await page.evaluate(`document.querySelector('[data-kpi="inroom"]').textContent`)).includes('Nair'), 'joined: In room on My Day')
        await page.open('/tele/session/ICH-0044240', { fresh: false })
        await page.click('button', 'Join call')
        await page.until(`document.body.textContent.includes('in session')`, 3000, 'back in the session')
        await page.click('button', 'End the session')
        await page.until(`!!document.querySelector('[role="alertdialog"]')?.textContent.includes('The video call closes for the patient too.')`, 3000, 'ending is confirmed')
        await page.click('[role="alertdialog"] button', 'End the session')
        await toastSays('Teleconsult ended', 'with Arjun Nair.')
        await page.until(`location.pathname === '/tele/queue'`, 3000, 'back to the queue')
        expect((await page.evaluate(`[...document.querySelectorAll('ul[aria-label="Today\\'s teleconsults"] > li')].find((li) => li.textContent.includes('Arjun Nair')).textContent`)).includes('seen'), 'ended: seen on the queue')
        await page.open('/', { fresh: false })
        expect((await arjunOnMyDay()).includes('Seen'), 'and Seen on My Day')
        await page.open('/tele/queue', { fresh: false })
        await page.open('/tele/session/NOPE', { fresh: false })
        text = await page.text()
        expect(text.includes('There is no patient or teleconsult with the id “NOPE” here.') && text.includes('No patient at this address.'), 'an unknown id says so')
      },
    },
    {
      name: 'Telehealth (S-27-04): the category gate — prohibited never, List A only on video; a blocked item stops the signature',
      async run() {
        await page.open('/tele/session/ICH-0044240/rx')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-27-04"]')`), 'S-27-04 is drawn')
        let text = await page.text()
        expect(text.includes('On the prohibited list. This cannot be prescribed by telemedicine under any circumstances.'), 'Tenecteplase is blocked on video too')
        expect(await signDisabled(), 'nothing to sign yet')
        await page.click('button[aria-label="Add Co-amoxiclav 1.2g IV"]')
        expect(!(await signDisabled()), 'List A signs on video')
        await page.click('[role="tab"]', 'Telephone')
        text = await page.text()
        expect(text.includes('telephone consultation · 1 blocked by the category gate') && text.includes('List A requires a video teleconsult.') && text.includes('Blocked — cannot be signed'), 'telephone blocks List A')
        expect(await signDisabled(), 'and the signature waits')
        await page.click('button[aria-label="Remove Co-amoxiclav 1.2g IV"]')
        await page.click('button[aria-label="Add Paracetamol 1g IV"]')
        await page.click('button', 'Sign the tele-prescription')
        await toastSays('Tele-prescription signed', 'Printed bilingually with your HPR number, and published to ABDM.')
        await page.until(`location.pathname === '/tele/queue'`, 3000, 'back to the queue')
      },
    },
  ]
}
