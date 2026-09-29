/**
 * The longitudinal record behind S-06-11 … S-06-17 — what a doctor opens a
 * follow-up patient for: how they are now, what was found before, what they
 * take, what was written last time, and when they are next due.
 *
 * Each screen shows ONE of these, so none of them has to be dense. The live
 * store (signed notes, dictated notes, today's prescriptions) is merged in by
 * the screens; what is here is the record as it stood before today.
 *
 * Every entry is consistent with the rest of the kit — the results in
 * `clinical.ts`, the studies in `imaging.ts`, the stroke cases in `stroke.ts`
 * — so a date or a number read on one screen is the same on the next.
 */

import type { ConfidenceBand } from '@/atlas/confidence'

import { imagingFor } from './imaging'
import { NOW, minutesAgo } from './format'

function on(month: number, day: number, h = 10, m = 0, year = 2026): Date {
  return new Date(year, month - 1, day, h, m)
}

// ───────────────────────────────────────────────────────── Current condition

export type ConditionStatus = 'Critical' | 'Deteriorating' | 'Stable' | 'Improving' | 'Recovered'

export interface ConditionSummary {
  patientId: string
  status: ConditionStatus
  /** One line — the condition as a colleague would say it at handover. */
  headline: string
  summary: string
  /** What to keep an eye on, in the order it matters. */
  watch: string[]
  updatedAt: Date
  updatedBy: string
  /** AI-105's read of the record, with what drove it. */
  ai: { text: string; drivers: string[]; band: ConfidenceBand; model: string }
}

export const CONDITIONS: ConditionSummary[] = [
  {
    patientId: 'SD-P-01',
    status: 'Stable',
    headline: 'Hypothyroidism, well controlled on levothyroxine 75 mcg',
    summary:
      'Thyroid function is in range on an unchanged dose. New since the last visit: a low ferritin with a borderline haemoglobin.',
    watch: ['Ferritin 14 ng/mL — discuss oral iron today', 'Repeat thyroid function in 6 months'],
    updatedAt: on(9, 18, 11, 30),
    updatedBy: 'Dr. Ananya Iyer',
    ai: {
      text: 'Replacement is adequate; the iron studies are the one new item for today.',
      drivers: ['TSH 2.4 mIU/L, in range on the same dose', 'Ferritin 14 ng/mL, down from 38 over a year'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-02',
    status: 'Improving',
    headline: 'Day 2 after triple-vessel CABG, on the standard pathway',
    summary: 'Extubated day 1, mobilising with physiotherapy. Drains serous and falling; haemoglobin as expected after surgery.',
    watch: ['Drain output — remove tomorrow if below threshold', 'Haemoglobin 9.8 g/dL', 'Physiotherapy sign-off before discharge'],
    updatedAt: minutesAgo(150),
    updatedBy: 'Dr. Ananya Iyer',
    ai: {
      text: 'On track for a day-5 discharge. Nothing in the last 24 hours departs from the pathway.',
      drivers: ['Troponin falling as expected', 'Sinus rhythm, no new arrhythmia', 'Drain output falling'],
      band: 'MED',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-03',
    status: 'Deteriorating',
    headline: 'Community-acquired pneumonia, not responding at 72 hours',
    summary:
      'More breathless overnight — oxygen up from 2 to 4 L. CRP and white count rising on current cover, with a new stage 2 kidney injury. Penicillin allergy on record.',
    watch: [
      'NEWS2 7, rising over 4 hours',
      'CRP 184 mg/L and WBC 16.8 — escalate antibiotic cover',
      'Creatinine 212 µmol/L — two prescriptions need renal dosing',
      'Penicillin allergy — co-amoxiclav is a hard stop',
    ],
    updatedAt: minutesAgo(48),
    updatedBy: 'AI-201 v2.4.1',
    ai: {
      text: 'A treatment-failure pattern: inflammatory markers and oxygen need are both rising on day 4.',
      drivers: ['CRP 96 → 184 mg/L in 48 h', 'SpO₂ 92% on 4 L', 'Respiratory rate 26', 'Creatinine 148 → 212'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-04',
    status: 'Stable',
    headline: '32 weeks, newly diagnosed gestational diabetes',
    summary: 'Growth scan normal at 32 weeks. The glucose tolerance test meets the gestational diabetes threshold; mild anaemia on iron.',
    watch: ['2-hour glucose 162 mg/dL — diet plan and home monitoring', 'Haemoglobin 10.6 g/dL', 'Obstetric review this week'],
    updatedAt: on(9, 19, 12, 45),
    updatedBy: 'Dr. Ananya Iyer',
    ai: {
      text: 'Gestational diabetes is the new diagnosis; nothing on the scan or the urine suggests pre-eclampsia.',
      drivers: ['OGTT 2 h 162 mg/dL (≥ 140)', 'Urine protein negative', 'Growth on the 50th centile'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-05',
    status: 'Critical',
    headline: 'Hyperacute left MCA stroke — thrombolysed, heading for thrombectomy',
    summary: 'Left M1 occlusion on CTA, ASPECTS 8, NIHSS 14. Tenecteplase given at the spoke; cath lab reserved at the hub.',
    watch: ['Door-in to door-out is breaching', 'BP under 180/105 after lysis', 'Neuro observations every 15 minutes'],
    updatedAt: new Date(2026, 8, 21, 2, 52),
    updatedBy: 'Dr. Priya Menon',
    ai: {
      text: 'Eligible for thrombectomy on every rule; the delay is logistics, not the patient.',
      drivers: ['ASPECTS 8', 'Core 18 mL, mismatch 3.4', 'NIHSS 14'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-06',
    status: 'Improving',
    headline: 'Acute viral fever, afebrile for 18 hours',
    summary: 'Dengue excluded, CRP falling, drinking and eating well. Ready for discharge once the summary is signed.',
    watch: ['Discharge summary unsigned', 'Return if fever recurs or she stops drinking'],
    updatedAt: minutesAgo(240),
    updatedBy: 'Dr. Ananya Iyer',
    ai: {
      text: 'Recovery is on the expected curve for a viral illness in a 6-year-old.',
      drivers: ['Afebrile 18 h', 'CRP 42 → 18 mg/L', 'NS1 negative'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-07',
    status: 'Critical',
    headline: 'Septic shock on noradrenaline, ventilated, with a critical potassium',
    summary: 'Day 6 in ICU. Potassium 6.8 this morning with a worsening kidney injury; the renal team is reviewing for filtration.',
    watch: ['Potassium 6.8 — treated, recheck in 2 hours', 'Creatinine 268 µmol/L, urine output falling', 'Platelets 84 — watch for DIC', 'Sulfa allergy'],
    updatedAt: minutesAgo(12),
    updatedBy: 'Dr. Ananya Iyer',
    ai: {
      text: 'The kidney injury, not the sepsis, is now what is moving fastest.',
      drivers: ['Potassium 5.4 → 6.8 in 9 h', 'Creatinine rising 12-hourly', 'Procalcitonin falling'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-09',
    status: 'Stable',
    headline: 'End-stage kidney disease on thrice-weekly haemodialysis',
    summary: 'Routine admission for dialysis. Pre-dialysis potassium as usual; phosphate above target.',
    watch: ['Dialysis at 14:00', 'Phosphate 1.9 — ask about binder adherence', 'Interdialytic weight gain 1.6 kg'],
    updatedAt: minutesAgo(200),
    updatedBy: 'Dr. Ananya Iyer',
    ai: {
      text: 'Stable on dialysis; nothing today needs more than the scheduled session.',
      drivers: ['Potassium 5.6 pre-dialysis', 'Haemoglobin 9.1, stable', 'BP 152/88'],
      band: 'MED',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-10',
    status: 'Improving',
    headline: 'Moderate acne, week 6 of isotretinoin',
    summary: 'Fewer new lesions; dry lips as expected. Baseline liver and lipid tests were normal.',
    watch: ['Mood — ask at every visit', 'Repeat liver tests and lipids at week 8'],
    updatedAt: on(9, 12, 10, 0),
    updatedBy: 'Dr. Ananya Iyer',
    ai: {
      text: 'Responding to treatment with only the expected side effects.',
      drivers: ['ALT 28 U/L', 'Triglycerides 138 mg/dL', 'Lesion count down about 40%'],
      band: 'MED',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-11',
    status: 'Improving',
    headline: 'Three weeks after a right subdural haematoma was drained',
    summary:
      'Burr-hole evacuation on 1 September after a fall. Headache gone, walking with a stick, no seizures on levetiracetam. Apixaban for atrial fibrillation is still on hold.',
    watch: [
      'Restarting apixaban — CHA₂DS₂-VASc 4 against a recent bleed',
      'Sodium 131 mmol/L, drifting down',
      'Falls risk — physiotherapy at home',
      'Levetiracetam until December',
    ],
    updatedAt: minutesAgo(60),
    updatedBy: 'Dr. Ananya Iyer',
    ai: {
      text: 'Recovery is on track. Today’s two decisions are the anticoagulant restart and the falling sodium.',
      drivers: ['CT at discharge: collection evacuated, shift resolved', 'Sodium 138 → 131 over 3 weeks', 'Haemoglobin recovering'],
      band: 'MED',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-12',
    status: 'Improving',
    headline: 'Small left thalamic haemorrhage, blood pressure now on target',
    summary: 'Day 3. Right arm weakness improving (power 4/5), speech clearer, swallow screen passed. Oral antihypertensives since yesterday.',
    watch: ['Systolic BP under 140', 'Repeat CT head today at 11:30', 'LDL 3.9 — statin decision with neurology'],
    updatedAt: minutesAgo(130),
    updatedBy: 'Dr. Ananya Iyer',
    ai: {
      text: 'Past the window where a small deep bleed usually expands; improving on examination.',
      drivers: ['Bleed about 6 mL, no ventricular extension', 'BP 212/118 → 148/88', 'ICH score 0'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-13',
    status: 'Deteriorating',
    headline: 'Large right MCA infarct with swelling — conscious level falling',
    summary:
      'Found with left-sided weakness about 30 hours after last seen well, too late for reperfusion. GCS 15 → 13 overnight with 6 mm midline shift. Neurosurgery asked about decompression.',
    watch: [
      'Decompression window closes at 12:00 today (48 h from last seen well)',
      'GCS every hour — 13 now',
      'Sodium 133 — keep at or above 140',
      'Glucose 188 — treat above 180',
    ],
    updatedAt: minutesAgo(70),
    updatedBy: 'AI-201 v2.4.1',
    ai: {
      text: 'A malignant oedema pattern at 44 years — the decision about decompression cannot wait past midday.',
      drivers: ['GCS 15 → 13', 'Midline shift 6 mm', 'ASPECTS 2', 'Age under 60'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-14',
    status: 'Critical',
    headline: 'Large right deep haemorrhage with ventricular extension, on warfarin',
    summary:
      'Code stroke at Tiruppur at 02:24. INR 3.8 — reversed with PCC and vitamin K at 02:48. GCS 10, BP 196/104. Transfer to the hub neuro-ICU being arranged.',
    watch: ['Repeat INR at 03:20', 'Systolic BP to 140', 'GCS every 15 minutes — neurosurgery if it falls', 'Warfarin stopped'],
    updatedAt: new Date(2026, 8, 21, 2, 50),
    updatedBy: 'Dr. Rohit Desai',
    ai: {
      text: 'ICH score 3. Reversal is done; the next hour is blood pressure and a neurosurgical decision.',
      drivers: ['Volume about 48 mL', 'Intraventricular extension', 'GCS 10', 'INR 3.8'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-15',
    status: 'Improving',
    headline: 'Migraine without aura — fewer attacks on propranolol',
    summary: 'Two attacks in the last month, down from six. The CT on 9 September was normal and she found that reassuring.',
    watch: ['Headache diary', 'Keep simple analgesia under 10 days a month'],
    updatedAt: on(9, 9, 12, 30),
    updatedBy: 'Dr. Ananya Iyer',
    ai: {
      text: 'Prophylaxis is working; no red-flag features on the record.',
      drivers: ['CT head normal', 'ESR normal', 'Attack frequency down'],
      band: 'MED',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-16',
    status: 'Recovered',
    headline: 'Minor head injury a week ago — symptoms settled',
    summary: 'Two-wheeler fall on 14 September, helmet on, CT normal. Headaches gone since Friday; back at college. Medico-legal case on file.',
    watch: ['Return if headache, vomiting or drowsiness come back', 'No contact sport for another week'],
    updatedAt: minutesAgo(70),
    updatedBy: 'Dr. Ananya Iyer',
    ai: {
      text: 'Recovered. Nothing on the record calls for further imaging.',
      drivers: ['GCS 15 throughout', 'CT head normal', 'Symptoms resolved'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
]

export function conditionFor(patientId: string): ConditionSummary | undefined {
  return CONDITIONS.find((c) => c.patientId === patientId)
}

// ─────────────────────────────────────────────────────────────── Appointments

export interface Appointment {
  id: string
  patientId: string
  at: Date
  kind: 'Follow-up' | 'Review' | 'Procedure' | 'Investigation' | 'Teleconsult' | 'Transfer'
  status: 'Booked' | 'Today' | 'Completed' | 'Missed'
  clinic: string
  with: string
  purpose: string
  /** What the patient should bring or do first. */
  prepare?: string[]
  location?: string
}

export const APPOINTMENTS: Appointment[] = [
  // SD-P-01
  { id: 'AP-0101', patientId: 'SD-P-01', at: on(3, 14, 10, 30), kind: 'Follow-up', status: 'Completed', clinic: 'General Medicine OPD', with: 'Dr. Ananya Iyer', purpose: 'Thyroid review' },
  { id: 'AP-0102', patientId: 'SD-P-01', at: on(9, 21, 8, 40), kind: 'Follow-up', status: 'Today', clinic: 'General Medicine OPD', with: 'Dr. Ananya Iyer', purpose: 'Thyroid review with results', location: 'Room 4, OPD block' },
  { id: 'AP-0103', patientId: 'SD-P-01', at: on(12, 21, 9, 0), kind: 'Investigation', status: 'Booked', clinic: 'Laboratory', with: 'Phlebotomy', purpose: 'Ferritin and haemoglobin recheck', prepare: ['No fasting needed'] },
  { id: 'AP-0104', patientId: 'SD-P-01', at: on(3, 22, 10, 0, 2027), kind: 'Follow-up', status: 'Booked', clinic: 'General Medicine OPD', with: 'Dr. Ananya Iyer', purpose: 'Six-monthly thyroid review', prepare: ['Thyroid function test a week before', 'Bring the levothyroxine strip'] },
  // SD-P-02
  { id: 'AP-0201', patientId: 'SD-P-02', at: on(9, 12, 9, 0), kind: 'Review', status: 'Completed', clinic: 'Pre-operative assessment', with: 'Cardiothoracic team', purpose: 'Fitness for CABG' },
  { id: 'AP-0202', patientId: 'SD-P-02', at: on(9, 28, 10, 0), kind: 'Review', status: 'Booked', clinic: 'Wound clinic', with: 'Sr. Lalitha Raman', purpose: 'Sternal and leg wound check', prepare: ['Keep the dressing dry until then'] },
  { id: 'AP-0203', patientId: 'SD-P-02', at: on(11, 2, 11, 0), kind: 'Follow-up', status: 'Booked', clinic: 'Cardiothoracic OPD', with: 'Cardiothoracic surgeon', purpose: 'Six-week review after CABG', prepare: ['ECG on arrival', 'Bring the medicine list'] },
  // SD-P-03
  { id: 'AP-0301', patientId: 'SD-P-03', at: on(6, 12, 11, 0), kind: 'Follow-up', status: 'Completed', clinic: 'Diabetes clinic', with: 'Dr. Ananya Iyer', purpose: 'Diabetes review' },
  { id: 'AP-0302', patientId: 'SD-P-03', at: on(9, 21, 11, 0), kind: 'Investigation', status: 'Today', clinic: 'Radiology', with: 'Portable X-ray', purpose: 'Repeat chest X-ray', location: 'At the bedside, 4B-12' },
  { id: 'AP-0303', patientId: 'SD-P-03', at: on(9, 21, 14, 0), kind: 'Review', status: 'Today', clinic: 'Ward 4B', with: 'Dr. Ananya Iyer', purpose: 'Review after antibiotic escalation' },
  // SD-P-04
  { id: 'AP-0401', patientId: 'SD-P-04', at: on(8, 24, 10, 0), kind: 'Follow-up', status: 'Completed', clinic: 'Antenatal clinic', with: 'Dr. Ananya Iyer', purpose: '28-week antenatal visit' },
  { id: 'AP-0402', patientId: 'SD-P-04', at: on(9, 23, 11, 0), kind: 'Review', status: 'Booked', clinic: 'Dietitian', with: 'Clinical dietitian', purpose: 'Diet plan for gestational diabetes', prepare: ['Bring a 3-day food diary'] },
  { id: 'AP-0403', patientId: 'SD-P-04', at: on(9, 28, 9, 30), kind: 'Follow-up', status: 'Booked', clinic: 'Obstetric OPD', with: 'Obstetrician', purpose: 'Review of glucose readings and growth', prepare: ['Home glucose readings, 4 a day'] },
  // SD-P-05
  { id: 'AP-0501', patientId: 'SD-P-05', at: new Date(2026, 8, 21, 3, 40), kind: 'Procedure', status: 'Today', clinic: 'Cath lab CATH-1', with: 'Dr. Samir Kulkarni', purpose: 'Mechanical thrombectomy', location: 'Hub, Coimbatore' },
  // SD-P-06
  { id: 'AP-0601', patientId: 'SD-P-06', at: on(9, 24, 10, 30), kind: 'Follow-up', status: 'Booked', clinic: 'Paediatric OPD', with: 'Paediatrician', purpose: 'Check after the fever', prepare: ['Bring the temperature chart'] },
  // SD-P-07
  { id: 'AP-0701', patientId: 'SD-P-07', at: on(9, 21, 9, 30), kind: 'Review', status: 'Today', clinic: 'ICU-1', with: 'Renal registrar', purpose: 'Decision on renal replacement therapy' },
  // SD-P-09
  { id: 'AP-0901', patientId: 'SD-P-09', at: on(9, 19, 14, 0), kind: 'Procedure', status: 'Completed', clinic: 'Dialysis unit', with: 'Dialysis team', purpose: 'Haemodialysis' },
  { id: 'AP-0902', patientId: 'SD-P-09', at: on(9, 21, 14, 0), kind: 'Procedure', status: 'Today', clinic: 'Dialysis unit', with: 'Dialysis team', purpose: 'Haemodialysis, 4 hours', location: 'Station 6' },
  { id: 'AP-0903', patientId: 'SD-P-09', at: on(10, 5, 10, 0), kind: 'Follow-up', status: 'Booked', clinic: 'Nephrology OPD', with: 'Nephrologist', purpose: 'Monthly dialysis review', prepare: ['Monthly bloods on the morning of dialysis'] },
  // SD-P-10
  { id: 'AP-1001', patientId: 'SD-P-10', at: on(8, 7, 16, 0), kind: 'Follow-up', status: 'Completed', clinic: 'Dermatology OPD', with: 'Dr. Ananya Iyer', purpose: 'Start isotretinoin' },
  { id: 'AP-1002', patientId: 'SD-P-10', at: on(9, 21, 9, 5), kind: 'Teleconsult', status: 'Today', clinic: 'Teleconsult', with: 'Dr. Ananya Iyer', purpose: 'Week-6 review', location: 'Video' },
  { id: 'AP-1003', patientId: 'SD-P-10', at: on(10, 19, 16, 0), kind: 'Teleconsult', status: 'Booked', clinic: 'Teleconsult', with: 'Dr. Ananya Iyer', purpose: 'Week-10 review', prepare: ['Liver tests and lipids the week before'] },
  // SD-P-11
  { id: 'AP-1101', patientId: 'SD-P-11', at: on(9, 7, 11, 0), kind: 'Review', status: 'Completed', clinic: 'Ward 4B', with: 'Dr. Ananya Iyer', purpose: 'Discharge after subdural evacuation' },
  { id: 'AP-1102', patientId: 'SD-P-11', at: on(9, 21, 9, 10), kind: 'Follow-up', status: 'Today', clinic: 'General Medicine OPD', with: 'Dr. Ananya Iyer', purpose: 'Three-week review — anticoagulation decision', location: 'Room 4, OPD block' },
  { id: 'AP-1103', patientId: 'SD-P-11', at: on(9, 28, 9, 0), kind: 'Investigation', status: 'Booked', clinic: 'Laboratory', with: 'Phlebotomy', purpose: 'Sodium recheck' },
  { id: 'AP-1104', patientId: 'SD-P-11', at: on(10, 12, 10, 30), kind: 'Follow-up', status: 'Booked', clinic: 'Neurosurgery OPD', with: 'Neurosurgeon', purpose: 'Review with a repeat CT head', prepare: ['CT head on arrival — no fasting needed', 'Bring a family member'] },
  // SD-P-12
  { id: 'AP-1201', patientId: 'SD-P-12', at: on(9, 21, 11, 30), kind: 'Investigation', status: 'Today', clinic: 'Radiology', with: 'CT', purpose: 'Repeat CT head, day 3', location: 'CT-2, ground floor' },
  { id: 'AP-1202', patientId: 'SD-P-12', at: on(10, 21, 10, 0), kind: 'Follow-up', status: 'Booked', clinic: 'Stroke clinic', with: 'Dr. Rohit Desai', purpose: 'One-month stroke review', prepare: ['Home BP readings, twice daily'] },
  // SD-P-13
  { id: 'AP-1301', patientId: 'SD-P-13', at: on(9, 21, 9, 30), kind: 'Review', status: 'Today', clinic: 'Ward 4B', with: 'Neurosurgery', purpose: 'Decompressive hemicraniectomy decision', location: '4B-15' },
  // SD-P-14
  { id: 'AP-1401', patientId: 'SD-P-14', at: on(9, 7, 10, 0), kind: 'Review', status: 'Completed', clinic: 'Anticoagulation clinic, Tiruppur', with: 'Pharmacist', purpose: 'INR check — 2.6' },
  { id: 'AP-1402', patientId: 'SD-P-14', at: new Date(2026, 8, 21, 3, 10), kind: 'Transfer', status: 'Today', clinic: 'Neuro-ICU, hub', with: 'AMB-ITP-02', purpose: 'Transfer to the hub for neurosurgery', location: 'Tiruppur → Coimbatore' },
  // SD-P-15
  { id: 'AP-1501', patientId: 'SD-P-15', at: on(9, 9, 10, 0), kind: 'Follow-up', status: 'Completed', clinic: 'General Medicine OPD', with: 'Dr. Ananya Iyer', purpose: 'Recurrent headache' },
  { id: 'AP-1502', patientId: 'SD-P-15', at: on(9, 21, 9, 20), kind: 'Follow-up', status: 'Today', clinic: 'General Medicine OPD', with: 'Dr. Ananya Iyer', purpose: 'Two-week review on propranolol', location: 'Room 4, OPD block' },
  { id: 'AP-1503', patientId: 'SD-P-15', at: on(12, 21, 10, 0), kind: 'Follow-up', status: 'Booked', clinic: 'General Medicine OPD', with: 'Dr. Ananya Iyer', purpose: 'Three-month migraine review', prepare: ['Bring the headache diary'] },
  // SD-P-16
  { id: 'AP-1601', patientId: 'SD-P-16', at: on(9, 14, 22, 50), kind: 'Review', status: 'Completed', clinic: 'Emergency', with: 'Emergency team', purpose: 'Head injury assessment' },
  { id: 'AP-1602', patientId: 'SD-P-16', at: on(9, 21, 7, 40), kind: 'Follow-up', status: 'Completed', clinic: 'General Medicine OPD', with: 'Dr. Ananya Iyer', purpose: 'One-week head-injury review' },
]

/** Oldest first — the order a history reads in. */
export function appointmentsFor(patientId: string): Appointment[] {
  return APPOINTMENTS.filter((a) => a.patientId === patientId).sort((a, b) => a.at.getTime() - b.at.getTime())
}

/** The next thing the patient is booked for — today's first, then the future. */
export function nextAppointment(patientId: string): Appointment | undefined {
  return appointmentsFor(patientId).find(
    (a) => (a.status === 'Today' || a.status === 'Booked') && a.at.getTime() >= startOfToday().getTime(),
  )
}

function startOfToday(): Date {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate())
}

// ─────────────────────────────────────────────────────────── Earlier notes

export interface PastNote {
  id: string
  patientId: string
  at: Date
  by: string
  kind: 'Consultation' | 'Progress note' | 'Admission assessment' | 'Discharge summary' | 'Procedure note' | 'Teleconsult' | 'Emergency note'
  /** Where it was written — "OPD · General Medicine". */
  setting: string
  subjective: string
  objective: string
  assessment: string
  plan: string
}

export const PAST_NOTES: PastNote[] = [
  {
    id: 'PN-0101',
    patientId: 'SD-P-01',
    at: on(3, 14, 10, 30),
    by: 'Dr. Ananya Iyer',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Well. No tiredness, weight stable, periods regular. Taking levothyroxine every morning before breakfast.',
    objective: 'Pulse 74, BP 116/72, weight 58 kg. No goitre.',
    assessment: 'Hypothyroidism, clinically and biochemically euthyroid on 75 mcg (TSH 3.1).',
    plan: 'Continue levothyroxine 75 mcg. Repeat thyroid function and a blood count in 6 months.',
  },
  {
    id: 'PN-0201',
    patientId: 'SD-P-02',
    at: on(9, 19, 13, 30),
    by: 'Cardiothoracic surgeon',
    kind: 'Procedure note',
    setting: 'OT-3 · Cardiothoracic Surgery',
    subjective: 'Elective CABG for triple-vessel disease under the PM-JAY package.',
    objective: 'LIMA to LAD, saphenous vein grafts to OM1 and RCA. Bypass 94 min, cross-clamp 62 min.',
    assessment: 'Uncomplicated triple-vessel CABG.',
    plan: 'ICU overnight, extubate when criteria met, aspirin from day 1, drains out when output falls below threshold.',
  },
  {
    id: 'PN-0202',
    patientId: 'SD-P-02',
    at: on(9, 20, 9, 0),
    by: 'Dr. Ananya Iyer',
    kind: 'Progress note',
    setting: 'Ward 2A · Cardiothoracic',
    subjective: 'Sore chest on coughing, otherwise comfortable. Slept well.',
    objective: 'Sinus rhythm 88, BP 122/70, SpO₂ 96% on 2 L. Drains 120 mL serous overnight. Chest clear.',
    assessment: 'Day 1 after CABG, progressing on the pathway.',
    plan: 'Step down to the ward. Chest physiotherapy. Restart metformin once eating.',
  },
  {
    id: 'PN-0301',
    patientId: 'SD-P-03',
    at: on(9, 17, 15, 30),
    by: 'Dr. Ananya Iyer',
    kind: 'Admission assessment',
    setting: 'Ward 4B · General Medicine',
    subjective: 'Three days of fever, productive cough and right-sided chest pain. Known type 2 diabetes. Penicillin allergy (rash).',
    objective: 'Temp 38.9, RR 24, SpO₂ 93% on air, pulse 104. Bronchial breathing right base. CURB-65 score 2.',
    assessment: 'Community-acquired pneumonia, right lower lobe, moderate severity.',
    plan: 'IV antibiotics per the CAP order set, blood cultures, oxygen to 94–98%, sliding-scale insulin, review at 48 hours.',
  },
  {
    id: 'PN-0302',
    patientId: 'SD-P-03',
    at: on(9, 20, 9, 30),
    by: 'Dr. Ananya Iyer',
    kind: 'Progress note',
    setting: 'Ward 4B · General Medicine',
    subjective: 'Cough less productive, still febrile in the evenings.',
    objective: 'Temp 38.1, RR 22, SpO₂ 94% on 2 L. CRP 138 (from 96).',
    assessment: 'Slow response at 72 hours.',
    plan: 'Continue current cover, repeat CRP and creatinine tomorrow, low threshold to escalate.',
  },
  {
    id: 'PN-0401',
    patientId: 'SD-P-04',
    at: on(8, 24, 10, 0),
    by: 'Dr. Ananya Iyer',
    kind: 'Consultation',
    setting: 'Antenatal clinic',
    subjective: '28 weeks. Good fetal movements. Mild tiredness.',
    objective: 'BP 112/70, fundal height 28 cm, fetal heart 144. Haemoglobin 10.4 last month.',
    assessment: 'Healthy pregnancy with mild anaemia.',
    plan: 'Continue iron and folic acid. Glucose tolerance test and growth scan at 32 weeks.',
  },
  {
    id: 'PN-0501',
    patientId: 'SD-P-05',
    at: new Date(2026, 8, 21, 2, 46),
    by: 'Dr. Rohit Desai',
    kind: 'Teleconsult',
    setting: 'Telestroke · Pollachi spoke',
    subjective: 'Sudden right weakness and aphasia, last known well 01:20.',
    objective: 'NIHSS 14. BP 168/94. NCCT: no haemorrhage, ASPECTS 8. CTA: left M1 occlusion.',
    assessment: 'Acute ischaemic stroke, left M1 occlusion, within the lysis window.',
    plan: 'Tenecteplase now at the spoke, then drip-and-ship to the hub for thrombectomy.',
  },
  {
    id: 'PN-0601',
    patientId: 'SD-P-06',
    at: on(9, 19, 11, 0),
    by: 'Dr. Ananya Iyer',
    kind: 'Admission assessment',
    setting: 'Day care · Paediatrics',
    subjective: 'Two days of fever to 39.4, reduced drinking, no rash or bleeding.',
    objective: 'Temp 39.1, pulse 128, capillary refill < 2 s, mildly dry mucosa.',
    assessment: 'Acute febrile illness, likely viral. Dengue to exclude.',
    plan: 'Oral fluids, paracetamol, NS1 and CBC, review in the morning.',
  },
  {
    id: 'PN-0701',
    patientId: 'SD-P-07',
    at: on(9, 20, 8, 30),
    by: 'Dr. Ananya Iyer',
    kind: 'Progress note',
    setting: 'ICU-1 · Critical Care',
    subjective: 'Ventilated and sedated. Family updated yesterday.',
    objective: 'Noradrenaline 0.12 mcg/kg/min, MAP 66. Urine 20 mL/h. Creatinine 214.',
    assessment: 'Septic shock from a urinary source with worsening AKI.',
    plan: 'Continue meropenem, fluid balance neutral, renal review if potassium or creatinine rise further.',
  },
  {
    id: 'PN-0901',
    patientId: 'SD-P-09',
    at: on(9, 5, 10, 0),
    by: 'Nephrologist',
    kind: 'Consultation',
    setting: 'Nephrology OPD',
    subjective: 'Tolerating dialysis. Occasional cramps near the end of a session.',
    objective: 'Dry weight 54 kg. BP 148/86. Fistula thrill good.',
    assessment: 'ESKD on haemodialysis, adequate clearance.',
    plan: 'Continue thrice-weekly sessions. Reinforce the phosphate binder with meals.',
  },
  {
    id: 'PN-1001',
    patientId: 'SD-P-10',
    at: on(9, 12, 16, 0),
    by: 'Dr. Ananya Iyer',
    kind: 'Teleconsult',
    setting: 'Teleconsult · Dermatology',
    subjective: 'Week 5. Dry lips, no mood change. Fewer new spots.',
    objective: 'On video: inflammatory lesions reduced on both cheeks, no nodules.',
    assessment: 'Moderate acne responding to isotretinoin.',
    plan: 'Continue 20 mg daily. Lip balm. Bloods at week 8.',
  },
  {
    id: 'PN-1101',
    patientId: 'SD-P-11',
    at: on(8, 31, 20, 0),
    by: 'Dr. Ananya Iyer',
    kind: 'Admission assessment',
    setting: 'Emergency → Ward 4B',
    subjective: 'Fell at home 10 days ago. Two days of headache, confusion and a weak left leg. On apixaban for atrial fibrillation.',
    objective: 'GCS 14, left pronator drift. CT head: right mixed-density subdural haematoma with midline shift.',
    assessment: 'Acute-on-chronic right subdural haematoma on an anticoagulant.',
    plan: 'Hold apixaban, neurosurgical referral for evacuation, levetiracetam, neuro observations hourly.',
  },
  {
    id: 'PN-1102',
    patientId: 'SD-P-11',
    at: on(9, 7, 11, 0),
    by: 'Dr. Ananya Iyer',
    kind: 'Discharge summary',
    setting: 'Ward 4B · General Medicine',
    subjective: 'Headache resolved after burr-hole evacuation on 1 September. Walking with a stick.',
    objective: 'GCS 15, power 5/5. Post-operative CT: collection evacuated, shift resolved. Sodium 134.',
    assessment: 'Right subdural haematoma, evacuated; recovering well.',
    plan: 'Apixaban on hold until the 3-week review. Levetiracetam 500 mg twice daily for 3 months. Sodium in 3 weeks.',
  },
  {
    id: 'PN-1201',
    patientId: 'SD-P-12',
    at: on(9, 18, 23, 50),
    by: 'Dr. Ananya Iyer',
    kind: 'Admission assessment',
    setting: 'Emergency → Stroke unit',
    subjective: 'Sudden right-sided weakness and slurred speech at 22:05. Known hypertension, stopped his tablets two months ago.',
    objective: 'BP 212/118, NIHSS 7, GCS 15. CT: left thalamic haemorrhage about 6 mL, no extension.',
    assessment: 'Hypertensive left thalamic intracerebral haemorrhage, ICH score 0.',
    plan: 'IV labetalol to systolic 140 within the hour, stroke-unit care, swallow screen, repeat CT at 72 hours.',
  },
  {
    id: 'PN-1202',
    patientId: 'SD-P-12',
    at: on(9, 20, 9, 15),
    by: 'Dr. Ananya Iyer',
    kind: 'Progress note',
    setting: 'Stroke unit · 4B-08',
    subjective: 'Speech better. Arm feels heavier in the evening.',
    objective: 'BP 152/90 on infusion, right arm power 4/5, swallow screen passed.',
    assessment: 'Stable deep ICH, day 2.',
    plan: 'Switch to oral amlodipine and telmisartan, stop the infusion, physiotherapy.',
  },
  {
    id: 'PN-1301',
    patientId: 'SD-P-13',
    at: on(9, 20, 18, 40),
    by: 'Dr. Ananya Iyer',
    kind: 'Admission assessment',
    setting: 'Emergency → Stroke unit',
    subjective: 'Found by her family with left-sided weakness; last seen well yesterday at noon. No anticoagulants.',
    objective: 'GCS 15, NIHSS 18, left hemiplegia and neglect. CT: large right MCA infarct, ASPECTS 2, 6 mm shift, no haemorrhage.',
    assessment: 'Large established right MCA infarct, outside every reperfusion window, at risk of malignant oedema.',
    plan: 'Aspirin after the swallow screen, head up 30°, sodium ≥ 140, hourly GCS, neurosurgery informed about decompression.',
  },
  {
    id: 'PN-1401',
    patientId: 'SD-P-14',
    at: new Date(2026, 8, 21, 2, 50),
    by: 'Dr. Rohit Desai',
    kind: 'Teleconsult',
    setting: 'Telestroke · Tiruppur',
    subjective: 'Collapsed at 01:50 with left-sided weakness. On warfarin for atrial fibrillation; last INR 2.6.',
    objective: 'GCS 10, NIHSS 21, BP 196/104. CT: right deep haemorrhage about 48 mL with ventricular and subarachnoid extension. INR 3.8.',
    assessment: 'Warfarin-associated intracerebral haemorrhage, ICH score 3.',
    plan: 'PCC 25 IU/kg and vitamin K 10 mg IV (given 02:48), labetalol to systolic 140, transfer to the hub neuro-ICU for neurosurgical review.',
  },
  {
    id: 'PN-1501',
    patientId: 'SD-P-15',
    at: on(9, 9, 10, 0),
    by: 'Dr. Ananya Iyer',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Throbbing one-sided headaches with nausea for 4 years, six a month lately, one worse than usual last week. No aura, no weakness.',
    objective: 'BP 116/72, neurological examination and fundi normal.',
    assessment: 'Migraine without aura, increased frequency. No red flags.',
    plan: 'CT head today to reassure. Start propranolol 40 mg twice daily. Headache diary. Review in 2 weeks.',
  },
  {
    id: 'PN-1601',
    patientId: 'SD-P-16',
    at: on(9, 14, 23, 45),
    by: 'Emergency team',
    kind: 'Emergency note',
    setting: 'Emergency · medico-legal case',
    subjective: 'Two-wheeler skid at low speed, helmet on. Dazed for a minute, no loss of consciousness, one episode of vomiting.',
    objective: 'GCS 15, no focal deficit, abrasion over the right forearm. CT head: no acute injury.',
    assessment: 'Minor head injury.',
    plan: 'Head-injury advice sheet, paracetamol, OPD review in one week. MLC registered.',
  },
  {
    id: 'PN-1602',
    patientId: 'SD-P-16',
    at: on(9, 21, 7, 55),
    by: 'Dr. Ananya Iyer',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Headaches gone since Friday. Sleeping and concentrating normally. Back at college.',
    objective: 'GCS 15, normal neurological examination. Forearm abrasion healing.',
    assessment: 'Minor head injury, recovered.',
    plan: 'No further follow-up needed. Return advice given. No contact sport for another week.',
  },
]

/** Newest first. */
export function pastNotesFor(patientId: string): PastNote[] {
  return PAST_NOTES.filter((n) => n.patientId === patientId).sort((a, b) => b.at.getTime() - a.at.getTime())
}

// ─────────────────────────────────────────────────────────── Prescriptions

export interface RxItem {
  drug: string
  dose: string
  route: string
  frequency: string
  duration: string
  status: 'Active' | 'Stopped' | 'Completed'
  /** Why it stopped, or what to watch. */
  note?: string
}

export interface PrescriptionRecord {
  id: string
  patientId: string
  at: Date
  by: string
  /** Where it was written — a discharge, an OPD visit, the inpatient chart. */
  context: string
  items: RxItem[]
}

export const PRESCRIPTION_HISTORY: PrescriptionRecord[] = [
  {
    id: 'RX-0101',
    patientId: 'SD-P-01',
    at: on(3, 14, 10, 45),
    by: 'Dr. Ananya Iyer',
    context: 'OPD visit',
    items: [{ drug: 'Levothyroxine', dose: '75 mcg', route: 'Oral', frequency: 'Once daily, before breakfast', duration: '6 months', status: 'Active' }],
  },
  {
    id: 'RX-0201',
    patientId: 'SD-P-02',
    at: on(9, 19, 18, 0),
    by: 'Dr. Ananya Iyer',
    context: 'Inpatient chart',
    items: [
      { drug: 'Aspirin', dose: '75 mg', route: 'Oral', frequency: 'Once daily', duration: 'Lifelong', status: 'Active' },
      { drug: 'Atorvastatin', dose: '40 mg', route: 'Oral', frequency: 'At night', duration: 'Lifelong', status: 'Active' },
      { drug: 'Metoprolol', dose: '25 mg', route: 'Oral', frequency: 'Twice daily', duration: 'Ongoing', status: 'Active' },
      { drug: 'Paracetamol', dose: '1 g', route: 'Oral', frequency: 'Four times daily', duration: '5 days', status: 'Active' },
      { drug: 'Metformin', dose: '500 mg', route: 'Oral', frequency: 'Twice daily', duration: '—', status: 'Stopped', note: 'Held around surgery; restart once eating normally' },
    ],
  },
  {
    id: 'RX-0301',
    patientId: 'SD-P-03',
    at: on(6, 12, 11, 20),
    by: 'Dr. Ananya Iyer',
    context: 'Diabetes clinic',
    items: [
      { drug: 'Metformin', dose: '500 mg', route: 'Oral', frequency: 'Twice daily', duration: '3 months', status: 'Stopped', note: 'Stopped on admission — kidney injury' },
      { drug: 'Glimepiride', dose: '1 mg', route: 'Oral', frequency: 'Once daily', duration: '3 months', status: 'Stopped', note: 'Replaced by insulin while unwell' },
    ],
  },
  {
    id: 'RX-0302',
    patientId: 'SD-P-03',
    at: on(9, 17, 16, 40),
    by: 'Dr. Ananya Iyer',
    context: 'Inpatient chart',
    items: [
      { drug: 'Piperacillin-tazobactam', dose: '4.5 g', route: 'IV', frequency: '8-hourly', duration: 'Day 4', status: 'Active', note: 'Tolerated previously despite the penicillin label; escalation under review' },
      { drug: 'Insulin (sliding scale)', dose: 'Per chart', route: 'SC', frequency: 'Before meals', duration: 'While inpatient', status: 'Active' },
      { drug: 'Paracetamol', dose: '1 g', route: 'Oral', frequency: 'Six-hourly as needed', duration: 'While febrile', status: 'Active' },
    ],
  },
  {
    id: 'RX-0401',
    patientId: 'SD-P-04',
    at: on(8, 24, 10, 20),
    by: 'Dr. Ananya Iyer',
    context: 'Antenatal visit',
    items: [
      { drug: 'Ferrous sulphate', dose: '200 mg', route: 'Oral', frequency: 'Twice daily', duration: 'Until delivery', status: 'Active' },
      { drug: 'Folic acid', dose: '5 mg', route: 'Oral', frequency: 'Once daily', duration: 'Until delivery', status: 'Active' },
      { drug: 'Calcium carbonate', dose: '500 mg', route: 'Oral', frequency: 'Twice daily', duration: 'Until delivery', status: 'Active' },
    ],
  },
  {
    id: 'RX-0501',
    patientId: 'SD-P-05',
    at: new Date(2026, 8, 21, 2, 55),
    by: 'Dr. Rohit Desai',
    context: 'Code stroke · Pollachi spoke',
    items: [{ drug: 'Tenecteplase', dose: '0.25 mg/kg (19.5 mg)', route: 'IV bolus', frequency: 'Once', duration: 'Single dose', status: 'Active', note: 'Being given now — stamp the needle time' }],
  },
  {
    id: 'RX-0601',
    patientId: 'SD-P-06',
    at: on(9, 19, 11, 15),
    by: 'Dr. Ananya Iyer',
    context: 'Day care',
    items: [
      { drug: 'Paracetamol syrup', dose: '250 mg (10 mL)', route: 'Oral', frequency: 'Six-hourly as needed', duration: '3 days', status: 'Active' },
      { drug: 'Oral rehydration solution', dose: '1 sachet in 1 L', route: 'Oral', frequency: 'Sips through the day', duration: '3 days', status: 'Active' },
    ],
  },
  {
    id: 'RX-0701',
    patientId: 'SD-P-07',
    at: on(9, 15, 4, 0),
    by: 'Dr. Ananya Iyer',
    context: 'ICU chart',
    items: [
      { drug: 'Meropenem', dose: '1 g', route: 'IV', frequency: '8-hourly (renally adjusted)', duration: 'Day 6', status: 'Active' },
      { drug: 'Noradrenaline', dose: '0.12 mcg/kg/min', route: 'IV infusion', frequency: 'Continuous', duration: 'Titrated to MAP ≥ 65', status: 'Active' },
      { drug: 'Insulin + dextrose', dose: '10 units + 50 mL 50%', route: 'IV', frequency: 'Once, repeat if K⁺ > 6', duration: 'Today', status: 'Active', note: 'For potassium 6.8' },
      { drug: 'Calcium gluconate 10%', dose: '10 mL', route: 'IV', frequency: 'Once', duration: 'Today', status: 'Completed', note: 'Cardiac protection for hyperkalaemia' },
      { drug: 'Co-trimoxazole', dose: '—', route: '—', frequency: '—', duration: '—', status: 'Stopped', note: 'Not given — sulfa allergy' },
    ],
  },
  {
    id: 'RX-0901',
    patientId: 'SD-P-09',
    at: on(9, 5, 10, 20),
    by: 'Nephrologist',
    context: 'Nephrology OPD',
    items: [
      { drug: 'Erythropoietin', dose: '4000 IU', route: 'SC', frequency: 'Twice weekly, on dialysis', duration: 'Ongoing', status: 'Active' },
      { drug: 'Sevelamer', dose: '800 mg', route: 'Oral', frequency: 'Three times daily with meals', duration: 'Ongoing', status: 'Active' },
      { drug: 'Amlodipine', dose: '5 mg', route: 'Oral', frequency: 'Once daily', duration: 'Ongoing', status: 'Active' },
    ],
  },
  {
    id: 'RX-1001',
    patientId: 'SD-P-10',
    at: on(8, 7, 16, 20),
    by: 'Dr. Ananya Iyer',
    context: 'Dermatology OPD',
    items: [
      { drug: 'Isotretinoin', dose: '20 mg', route: 'Oral', frequency: 'Once daily with food', duration: '6 months', status: 'Active', note: 'Ask about mood at every visit' },
      { drug: 'Doxycycline', dose: '100 mg', route: 'Oral', frequency: 'Once daily', duration: '—', status: 'Stopped', note: 'Stopped before isotretinoin' },
      { drug: 'Emollient lip balm', dose: 'Apply', route: 'Topical', frequency: 'As often as needed', duration: 'Ongoing', status: 'Active' },
    ],
  },
  {
    id: 'RX-1101',
    patientId: 'SD-P-11',
    at: on(9, 7, 11, 15),
    by: 'Dr. Ananya Iyer',
    context: 'Discharge',
    items: [
      { drug: 'Levetiracetam', dose: '500 mg', route: 'Oral', frequency: 'Twice daily', duration: '3 months (to December)', status: 'Active' },
      { drug: 'Bisoprolol', dose: '2.5 mg', route: 'Oral', frequency: 'Once daily', duration: 'Ongoing', status: 'Active', note: 'Rate control for atrial fibrillation' },
      { drug: 'Paracetamol', dose: '500 mg', route: 'Oral', frequency: 'Six-hourly as needed', duration: '2 weeks', status: 'Completed' },
      { drug: 'Apixaban', dose: '5 mg', route: 'Oral', frequency: 'Twice daily', duration: '—', status: 'Stopped', note: 'On hold after the subdural — restart is today’s decision' },
    ],
  },
  {
    id: 'RX-1201',
    patientId: 'SD-P-12',
    at: on(9, 18, 23, 0),
    by: 'Dr. Ananya Iyer',
    context: 'Stroke unit',
    items: [
      { drug: 'Labetalol', dose: '2 mg/min', route: 'IV infusion', frequency: 'Continuous', duration: '36 hours', status: 'Completed', note: 'Stopped once oral treatment took over' },
      { drug: 'Amlodipine', dose: '10 mg', route: 'Oral', frequency: 'Once daily', duration: 'Ongoing', status: 'Active' },
      { drug: 'Telmisartan', dose: '40 mg', route: 'Oral', frequency: 'Once daily', duration: 'Ongoing', status: 'Active' },
      { drug: 'Atorvastatin', dose: '—', route: '—', frequency: '—', duration: '—', status: 'Stopped', note: 'Not started — statin after an ICH is a specialist decision' },
    ],
  },
  {
    id: 'RX-1301',
    patientId: 'SD-P-13',
    at: on(9, 20, 19, 0),
    by: 'Dr. Ananya Iyer',
    context: 'Stroke unit',
    items: [
      { drug: 'Aspirin', dose: '300 mg', route: 'Oral / NG', frequency: 'Once daily', duration: '14 days', status: 'Active' },
      { drug: 'Sodium chloride 3%', dose: '30 mL/h', route: 'IV infusion', frequency: 'Continuous', duration: 'Sodium ≥ 140', status: 'Active' },
      { drug: 'Atorvastatin', dose: '80 mg', route: 'Oral', frequency: 'At night', duration: 'Ongoing', status: 'Active' },
      { drug: 'Insulin (sliding scale)', dose: 'Per chart', route: 'SC', frequency: 'Four-hourly checks', duration: 'While glucose > 180', status: 'Active' },
    ],
  },
  {
    id: 'RX-1401',
    patientId: 'SD-P-14',
    at: new Date(2026, 8, 21, 2, 46),
    by: 'Dr. Rohit Desai',
    context: 'Code stroke · Tiruppur',
    items: [
      { drug: 'Prothrombin complex concentrate', dose: '25 IU/kg (1750 IU)', route: 'IV', frequency: 'Once', duration: 'Single dose', status: 'Completed', note: 'Given 02:48 — repeat INR at 03:20' },
      { drug: 'Vitamin K (phytomenadione)', dose: '10 mg', route: 'IV', frequency: 'Once', duration: 'Single dose', status: 'Completed' },
      { drug: 'Labetalol', dose: '2 mg/min', route: 'IV infusion', frequency: 'Continuous', duration: 'To systolic 140', status: 'Active' },
      { drug: 'Warfarin', dose: '5 mg', route: 'Oral', frequency: 'Once daily', duration: '—', status: 'Stopped', note: 'Stopped — intracranial haemorrhage' },
    ],
  },
  {
    id: 'RX-1501',
    patientId: 'SD-P-15',
    at: on(9, 9, 10, 40),
    by: 'Dr. Ananya Iyer',
    context: 'OPD visit',
    items: [
      { drug: 'Propranolol', dose: '40 mg', route: 'Oral', frequency: 'Twice daily', duration: '3 months', status: 'Active' },
      { drug: 'Naproxen', dose: '500 mg', route: 'Oral', frequency: 'At onset, max twice a day', duration: 'As needed', status: 'Active', note: 'No more than 10 days a month' },
      { drug: 'Sumatriptan', dose: '50 mg', route: 'Oral', frequency: 'At onset, may repeat after 2 h', duration: 'As needed', status: 'Active' },
    ],
  },
  {
    id: 'RX-1601',
    patientId: 'SD-P-16',
    at: on(9, 14, 23, 50),
    by: 'Emergency team',
    context: 'Emergency',
    items: [{ drug: 'Paracetamol', dose: '650 mg', route: 'Oral', frequency: 'Six-hourly as needed', duration: '5 days', status: 'Completed' }],
  },
]

/** Newest first. */
export function prescriptionsFor(patientId: string): PrescriptionRecord[] {
  return PRESCRIPTION_HISTORY.filter((r) => r.patientId === patientId).sort((a, b) => b.at.getTime() - a.at.getTime())
}

/** Everything currently being taken, across every prescription on the record. */
export function activeMedicines(patientId: string): (RxItem & { since: Date; by: string })[] {
  return prescriptionsFor(patientId).flatMap((r) =>
    r.items.filter((i) => i.status === 'Active').map((i) => ({ ...i, since: r.at, by: r.by })),
  )
}

// ──────────────────────────────────────────────────────────────── Reports

export interface RecordReport {
  id: string
  patientId: string
  at: Date
  kind: 'Imaging' | 'Discharge summary' | 'Operative note' | 'ECG' | 'Echocardiogram' | 'Ultrasound' | 'Medico-legal'
  title: string
  by: string
  summary: string
  body?: string[]
  /** An imaging report links to its study. */
  studyId?: string
  /** Whether real images stand behind it in this demo. */
  viewable?: boolean
}

/** The documents that are not imaging studies — imaging is joined in from `imaging.ts`. */
const DOCUMENTS: RecordReport[] = [
  { id: 'DOC-0201', patientId: 'SD-P-02', at: on(9, 10, 12, 0), kind: 'Echocardiogram', title: 'Transthoracic echocardiogram', by: 'Cardiology', summary: 'LVEF 50%, mild inferior hypokinesia, no significant valve disease.' },
  { id: 'DOC-0202', patientId: 'SD-P-02', at: on(9, 19, 13, 30), kind: 'Operative note', title: 'CABG ×3 — operative note', by: 'Cardiothoracic surgeon', summary: 'LIMA–LAD, SVG–OM1, SVG–RCA. Uncomplicated.' },
  { id: 'DOC-0301', patientId: 'SD-P-03', at: new Date(2026, 8, 21, 0, 50), kind: 'ECG', title: '12-lead ECG', by: 'Dr. Ananya Iyer', summary: 'Sinus tachycardia 108. No acute ST change. Recorded during the overnight seizure alert.' },
  { id: 'DOC-0701', patientId: 'SD-P-07', at: on(9, 16, 10, 0), kind: 'Echocardiogram', title: 'Bedside echocardiogram', by: 'Critical Care', summary: 'Hyperdynamic left ventricle, IVC collapsing — fluid responsive at the time.' },
  { id: 'DOC-0901', patientId: 'SD-P-09', at: on(8, 20, 11, 0), kind: 'Ultrasound', title: 'AV fistula Doppler', by: 'Vascular lab', summary: 'Left radiocephalic fistula, flow 820 mL/min, no stenosis.' },
  { id: 'DOC-1101', patientId: 'SD-P-11', at: on(9, 1, 11, 30), kind: 'Operative note', title: 'Right burr-hole evacuation of subdural haematoma', by: 'Neurosurgery', summary: 'Two burr holes, dark and fresh blood evacuated, subdural drain placed. Uncomplicated.' },
  {
    id: 'DOC-1102',
    patientId: 'SD-P-11',
    at: on(9, 7, 11, 0),
    kind: 'Discharge summary',
    title: 'Discharge summary — ward 4B',
    by: 'Dr. Ananya Iyer',
    summary: 'Subdural evacuated, recovering. Apixaban held; levetiracetam for 3 months; review at 3 weeks.',
    body: [
      'Admitted 31 August after a fall on apixaban. CT: right mixed-density subdural with midline shift.',
      'Burr-hole evacuation 1 September; drain out day 2. Post-operative CT satisfactory.',
      'Discharged 7 September walking with a stick. Sodium 134 at discharge.',
    ],
  },
  { id: 'DOC-1201', patientId: 'SD-P-12', at: on(9, 18, 22, 35), kind: 'ECG', title: '12-lead ECG', by: 'Emergency', summary: 'Sinus rhythm 76. Left ventricular hypertrophy by voltage criteria.' },
  { id: 'DOC-1301', patientId: 'SD-P-13', at: on(9, 20, 18, 20), kind: 'ECG', title: '12-lead ECG', by: 'Emergency', summary: 'Sinus rhythm 64. No atrial fibrillation captured — Holter to follow.' },
  { id: 'DOC-1601', patientId: 'SD-P-16', at: on(9, 15, 9, 0), kind: 'Medico-legal', title: 'Medico-legal injury report', by: 'Emergency team', summary: 'Simple injuries — right forearm abrasion; minor head injury with normal CT. Copy issued to police.' },
]

/** Every report on the record, imaging included, newest first. */
export function reportsFor(patientId: string): RecordReport[] {
  const imaging: RecordReport[] = imagingFor(patientId).map((s) => ({
    id: s.id,
    patientId,
    at: s.acquiredAt,
    kind: 'Imaging',
    title: `${s.description}`,
    by: s.reportedBy ?? 'Awaiting radiologist',
    summary: s.impression,
    body: s.findings,
    studyId: s.id,
    viewable: s.ncctKey !== undefined,
  }))
  return [...imaging, ...DOCUMENTS.filter((d) => d.patientId === patientId)].sort((a, b) => b.at.getTime() - a.at.getTime())
}
