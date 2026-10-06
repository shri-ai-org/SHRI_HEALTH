/**
 * ICD-10 — the codes the portal can pick from, search and group by. One
 * dictionary for every place a diagnosis is coded (the problem list, the
 * note's code, admission, discharge, a prescription line's indication, the
 * death certificate) and for the cohort filters, so a code reads the same
 * everywhere it appears.
 *
 * A curated catalogue, not the full classification: every code already in the
 * sample record (`clinical.ts` problems, `kit.ts` DIAGNOSES, the AI-501
 * suggestions) and the diagnoses an Indian general hospital codes most often.
 * The record mixes WHO ICD-10 and ICD-10-CM codes (R65.21, I48.91, G43.009 are
 * CM; S06.5, D72.8 are WHO), as the sample data was written; grouping is by
 * the three-character category and the chapter, which both share.
 *
 * `leaf` is the rule AI-501 already enforces: a parent code (one with
 * sub-codes, like J18) cannot be the coded diagnosis — pick a leaf under it.
 */

export interface IcdCode {
  code: string
  label: string
}

export interface IcdEntry extends IcdCode {
  /** False for a parent code: it groups, it is never the coded diagnosis. */
  leaf: boolean
}

export interface IcdChapter {
  /** Roman numeral, as the classification numbers them. */
  id: string
  /** First and last three-character categories, inclusive. */
  from: string
  to: string
  title: string
}

export const ICD_CHAPTERS: IcdChapter[] = [
  { id: 'I', from: 'A00', to: 'B99', title: 'Certain infectious and parasitic diseases' },
  { id: 'II', from: 'C00', to: 'D48', title: 'Neoplasms' },
  { id: 'III', from: 'D50', to: 'D89', title: 'Diseases of the blood and immune mechanism' },
  { id: 'IV', from: 'E00', to: 'E90', title: 'Endocrine, nutritional and metabolic diseases' },
  { id: 'V', from: 'F00', to: 'F99', title: 'Mental and behavioural disorders' },
  { id: 'VI', from: 'G00', to: 'G99', title: 'Diseases of the nervous system' },
  { id: 'VII', from: 'H00', to: 'H59', title: 'Diseases of the eye and adnexa' },
  { id: 'VIII', from: 'H60', to: 'H95', title: 'Diseases of the ear and mastoid process' },
  { id: 'IX', from: 'I00', to: 'I99', title: 'Diseases of the circulatory system' },
  { id: 'X', from: 'J00', to: 'J99', title: 'Diseases of the respiratory system' },
  { id: 'XI', from: 'K00', to: 'K93', title: 'Diseases of the digestive system' },
  { id: 'XII', from: 'L00', to: 'L99', title: 'Diseases of the skin and subcutaneous tissue' },
  { id: 'XIII', from: 'M00', to: 'M99', title: 'Diseases of the musculoskeletal system' },
  { id: 'XIV', from: 'N00', to: 'N99', title: 'Diseases of the genitourinary system' },
  { id: 'XV', from: 'O00', to: 'O99', title: 'Pregnancy, childbirth and the puerperium' },
  { id: 'XVI', from: 'P00', to: 'P96', title: 'Conditions of the perinatal period' },
  { id: 'XVII', from: 'Q00', to: 'Q99', title: 'Congenital malformations and chromosomal abnormalities' },
  { id: 'XVIII', from: 'R00', to: 'R99', title: 'Symptoms, signs and abnormal findings' },
  { id: 'XIX', from: 'S00', to: 'T98', title: 'Injury, poisoning and other external causes' },
  { id: 'XX', from: 'V01', to: 'Y98', title: 'External causes of morbidity and mortality' },
  { id: 'XXI', from: 'Z00', to: 'Z99', title: 'Factors influencing health status' },
  { id: 'XXII', from: 'U00', to: 'U99', title: 'Codes for special purposes' },
]

const L = (code: string, label: string): IcdEntry => ({ code, label, leaf: true })
const P = (code: string, label: string): IcdEntry => ({ code, label, leaf: false })

export const ICD10: IcdEntry[] = [
  // I · Infectious and parasitic
  L('A01.0', 'Typhoid fever'),
  L('A09', 'Infectious gastroenteritis and colitis, unspecified'),
  L('A15.0', 'Tuberculosis of lung'),
  L('A41.9', 'Sepsis, unspecified organism'),
  L('A75.3', 'Scrub typhus'),
  L('A90', 'Dengue fever'),
  L('A91', 'Dengue haemorrhagic fever'),
  L('B20', 'HIV disease'),
  L('B34.9', 'Viral infection, unspecified'),
  L('B50.9', 'Plasmodium falciparum malaria, unspecified'),
  L('B54', 'Malaria, unspecified'),
  // II · Neoplasms
  L('C16.9', 'Malignant neoplasm of stomach, unspecified'),
  L('C18.9', 'Malignant neoplasm of colon, unspecified'),
  L('C34.9', 'Malignant neoplasm of bronchus or lung, unspecified'),
  L('C50.9', 'Malignant neoplasm of breast, unspecified'),
  L('C53.9', 'Malignant neoplasm of cervix uteri, unspecified'),
  L('C61', 'Malignant neoplasm of prostate'),
  L('D25.9', 'Leiomyoma of uterus, unspecified'),
  // III · Blood and immune
  L('D50.9', 'Iron deficiency anaemia, unspecified'),
  L('D57.1', 'Sickle-cell disease without crisis'),
  L('D64.9', 'Anaemia, unspecified'),
  L('D68.32', 'Haemorrhagic disorder due to extrinsic anticoagulants'),
  L('D69.6', 'Thrombocytopenia, unspecified'),
  L('D72.8', 'Other disorders of white blood cells (leucopenia)'),
  // IV · Endocrine, nutritional, metabolic
  L('E03.9', 'Hypothyroidism, unspecified'),
  L('E05.9', 'Thyrotoxicosis, unspecified'),
  L('E10.9', 'Type 1 diabetes mellitus without complications'),
  L('E11.22', 'Type 2 diabetes mellitus with diabetic chronic kidney disease'),
  L('E11.65', 'Type 2 diabetes mellitus with hyperglycaemia'),
  L('E11.9', 'Type 2 diabetes mellitus without complications'),
  L('E55.9', 'Vitamin D deficiency, unspecified'),
  L('E66.9', 'Obesity, unspecified'),
  L('E78.5', 'Hyperlipidaemia, unspecified'),
  L('E86.0', 'Dehydration'),
  L('E87.1', 'Hyponatraemia'),
  L('E87.6', 'Hypokalaemia'),
  // V · Mental and behavioural
  L('F03', 'Unspecified dementia'),
  L('F10.2', 'Alcohol dependence syndrome'),
  L('F32.9', 'Depressive episode, unspecified'),
  L('F41.1', 'Generalised anxiety disorder'),
  // VI · Nervous system
  L('G03.9', 'Meningitis, unspecified'),
  L('G20', 'Parkinson disease'),
  L('G35', 'Multiple sclerosis'),
  L('G40.9', 'Epilepsy, unspecified'),
  L('G43.009', 'Migraine without aura'),
  L('G45.9', 'Transient cerebral ischaemic attack, unspecified'),
  L('G61.0', 'Guillain–Barré syndrome'),
  L('G93.6', 'Cerebral oedema'),
  // VII–VIII · Eye, ear
  L('H25.9', 'Senile cataract, unspecified'),
  L('H40.9', 'Glaucoma, unspecified'),
  L('H66.9', 'Otitis media, unspecified'),
  // IX · Circulatory
  L('I05.9', 'Rheumatic mitral valve disease, unspecified'),
  L('I10', 'Essential (primary) hypertension'),
  L('I11.9', 'Hypertensive heart disease without heart failure'),
  L('I20.9', 'Angina pectoris, unspecified'),
  L('I21.9', 'Acute myocardial infarction, unspecified'),
  L('I25.10', 'Coronary artery disease of native coronary artery'),
  L('I26.9', 'Pulmonary embolism without acute cor pulmonale'),
  L('I48.91', 'Atrial fibrillation, unspecified'),
  L('I50.9', 'Heart failure, unspecified'),
  L('I61.0', 'Intracerebral haemorrhage in hemisphere, subcortical'),
  L('I61.5', 'Intracerebral haemorrhage, intraventricular'),
  L('I61.9', 'Intracerebral haemorrhage, unspecified'),
  L('I62.0', 'Nontraumatic subdural haemorrhage'),
  L('I63.5', 'Cerebral infarction due to occlusion or stenosis of cerebral arteries'),
  L('I63.9', 'Cerebral infarction, unspecified'),
  L('I64', 'Stroke, not specified as haemorrhage or infarction'),
  L('I69.3', 'Sequelae of cerebral infarction'),
  L('I80.2', 'Deep vein thrombosis of lower limb'),
  L('I95.9', 'Hypotension, unspecified'),
  // X · Respiratory
  L('J06.9', 'Acute upper respiratory infection, unspecified'),
  L('J13', 'Pneumonia due to Streptococcus pneumoniae'),
  L('J15.9', 'Bacterial pneumonia, unspecified'),
  P('J18', 'Pneumonia, organism unspecified'),
  L('J18.9', 'Pneumonia, unspecified organism'),
  L('J20.9', 'Acute bronchitis, unspecified'),
  L('J44.1', 'COPD with acute exacerbation'),
  L('J44.9', 'Chronic obstructive pulmonary disease, unspecified'),
  L('J45.9', 'Asthma, unspecified'),
  L('J69.0', 'Aspiration pneumonia (food and vomit)'),
  L('J90', 'Pleural effusion'),
  L('J96.0', 'Acute respiratory failure'),
  // XI · Digestive
  L('K13.0', 'Diseases of lips (cheilitis)'),
  L('K21.9', 'Gastro-oesophageal reflux disease without oesophagitis'),
  L('K25.9', 'Gastric ulcer, unspecified'),
  L('K29.7', 'Gastritis, unspecified'),
  L('K35.8', 'Acute appendicitis'),
  L('K40.9', 'Inguinal hernia without obstruction or gangrene'),
  L('K59.0', 'Constipation'),
  L('K70.3', 'Alcoholic cirrhosis of liver'),
  L('K74.6', 'Cirrhosis of liver, other and unspecified'),
  L('K76.0', 'Fatty liver, not elsewhere classified'),
  L('K80.2', 'Calculus of gallbladder without cholecystitis'),
  L('K81.0', 'Acute cholecystitis'),
  L('K85.9', 'Acute pancreatitis, unspecified'),
  L('K92.2', 'Gastrointestinal haemorrhage, unspecified'),
  // XII · Skin
  L('L03.9', 'Cellulitis, unspecified'),
  L('L20.9', 'Atopic dermatitis, unspecified'),
  L('L40.0', 'Psoriasis vulgaris'),
  L('L70.0', 'Acne vulgaris'),
  L('L89.9', 'Pressure ulcer, unspecified'),
  // XIII · Musculoskeletal
  L('M06.9', 'Rheumatoid arthritis, unspecified'),
  L('M10.9', 'Gout, unspecified'),
  L('M17.9', 'Osteoarthritis of knee, unspecified'),
  L('M19.9', 'Osteoarthritis, unspecified'),
  L('M54.5', 'Low back pain'),
  L('M81.0', 'Postmenopausal osteoporosis'),
  // XIV · Genitourinary
  L('N10', 'Acute pyelonephritis'),
  L('N17.9', 'Acute kidney failure, unspecified'),
  L('N18.3', 'Chronic kidney disease, stage 3'),
  L('N18.4', 'Chronic kidney disease, stage 4'),
  L('N18.5', 'Chronic kidney disease, stage 5'),
  L('N18.6', 'End-stage renal disease'),
  L('N20.0', 'Calculus of kidney'),
  L('N39.0', 'Urinary tract infection, site not specified'),
  L('N40', 'Hyperplasia of prostate'),
  L('N92.0', 'Excessive and frequent menstruation with regular cycle'),
  // XV · Pregnancy, childbirth, puerperium
  L('O03.9', 'Spontaneous abortion, complete or unspecified'),
  L('O13', 'Gestational hypertension'),
  L('O14.9', 'Pre-eclampsia, unspecified'),
  L('O21.0', 'Mild hyperemesis gravidarum'),
  L('O24.41', 'Gestational diabetes mellitus in pregnancy'),
  L('O72.1', 'Immediate postpartum haemorrhage'),
  L('O80', 'Single spontaneous delivery'),
  L('O82', 'Single delivery by caesarean section'),
  L('O99.01', 'Anaemia complicating pregnancy'),
  // XVI–XVII · Perinatal, congenital
  L('P07.3', 'Preterm newborn'),
  L('P22.0', 'Respiratory distress syndrome of newborn'),
  L('P59.9', 'Neonatal jaundice, unspecified'),
  L('Q21.1', 'Atrial septal defect'),
  L('Q90.9', 'Down syndrome, unspecified'),
  // XVIII · Symptoms, signs, findings
  L('R05', 'Cough'),
  L('R07.4', 'Chest pain, unspecified'),
  L('R10.4', 'Abdominal pain, other and unspecified'),
  L('R40.2', 'Coma, unspecified'),
  L('R50.9', 'Fever, unspecified'),
  L('R51', 'Headache'),
  L('R55', 'Syncope and collapse'),
  L('R56.8', 'Convulsions, other and unspecified'),
  L('R57.9', 'Shock, unspecified'),
  L('R65.21', 'Severe sepsis with septic shock'),
  L('R73.9', 'Hyperglycaemia, unspecified'),
  // XIX · Injury and poisoning
  L('S06.0X0', 'Concussion without loss of consciousness'),
  L('S06.5', 'Traumatic subdural haemorrhage'),
  L('S06.9', 'Intracranial injury, unspecified'),
  L('S32.0', 'Fracture of lumbar vertebra'),
  L('S50.8', 'Other superficial injury of forearm'),
  L('S52.5', 'Fracture of lower end of radius'),
  L('S72.0', 'Fracture of neck of femur'),
  L('S82.2', 'Fracture of shaft of tibia'),
  L('T14.9', 'Injury, unspecified'),
  L('T45.5', 'Poisoning by anticoagulants'),
  L('T60.0', 'Toxic effect of organophosphate and carbamate insecticides'),
  L('T63.0', 'Toxic effect of snake venom'),
  L('T78.4', 'Allergy, unspecified'),
  L('T88.7', 'Adverse effect of drug or medicament, unspecified'),
  // XX · External causes
  L('V89.2', 'Person injured in motor-vehicle traffic accident'),
  L('W19', 'Unspecified fall'),
  // XXI · Factors influencing health status
  L('Z00.0', 'General medical examination'),
  L('Z23', 'Need for immunisation'),
  L('Z34.9', 'Supervision of normal pregnancy, unspecified'),
  L('Z49.1', 'Extracorporeal dialysis'),
  L('Z51.1', 'Chemotherapy session for neoplasm'),
  L('Z79.01', 'Long-term (current) use of anticoagulants'),
  L('Z86.73', 'Personal history of TIA or cerebral infarction without residual deficit'),
  L('Z95.1', 'Presence of aortocoronary bypass graft'),
  // XXII · Special purposes
  L('U07.1', 'COVID-19, virus identified'),
]

/**
 * The words doctors search with that the classification's labels do not use —
 * by category, so every code under it is found ("stroke" finds I63 and I61).
 */
const SYNONYMS: Record<string, string> = {
  A01: 'enteric fever',
  A15: 'tb tuberculosis pulmonary',
  A41: 'septicaemia sepsis',
  A90: 'dengue',
  A91: 'dengue dhf',
  B50: 'malaria falciparum',
  B54: 'malaria',
  D50: 'anaemia anemia iron',
  D64: 'anaemia anemia',
  D68: 'coagulopathy warfarin bleeding',
  E03: 'thyroid hypothyroid',
  E05: 'thyroid hyperthyroid graves',
  E10: 'diabetes t1dm dm',
  E11: 'diabetes t2dm dm sugar',
  E78: 'cholesterol lipids dyslipidaemia',
  G40: 'seizures fits',
  G43: 'headache migraine',
  G45: 'tia mini-stroke stroke',
  I10: 'hypertension htn bp blood pressure',
  I20: 'chest pain angina ihd',
  I21: 'mi heart attack stemi nstemi',
  I25: 'cad ihd coronary heart disease',
  I48: 'af atrial fibrillation',
  I50: 'chf heart failure',
  I61: 'stroke haemorrhagic hemorrhagic brain bleed ich',
  I62: 'subdural bleed',
  I63: 'stroke ischaemic ischemic infarct cva',
  I64: 'stroke cva',
  I69: 'stroke sequelae old stroke',
  I80: 'dvt thrombosis',
  J18: 'chest infection cap pneumonia',
  J44: 'copd',
  J45: 'asthma wheeze',
  K76: 'nafld fatty liver',
  N17: 'aki acute kidney injury renal failure',
  N18: 'ckd kidney renal failure dialysis',
  N39: 'uti urine infection',
  O24: 'gdm gestational diabetes',
  O99: 'anaemia anemia pregnancy',
  R65: 'septic shock sepsis',
  S06: 'head injury tbi',
  S72: 'hip fracture nof',
  T60: 'op poisoning organophosphate',
  T63: 'snake bite',
  U07: 'covid coronavirus',
}

const BY_CODE = new Map(ICD10.map((e) => [e.code.toUpperCase(), e]))

export const normaliseIcd = (code: string) => code.trim().toUpperCase()

/** The catalogue entry for a code, if it has one. */
export const icdEntry = (code: string): IcdEntry | undefined => BY_CODE.get(normaliseIcd(code))

/** A code's label from the catalogue, or the code itself when it is not in it. */
export const icdLabel = (code: string) => icdEntry(code)?.label ?? normaliseIcd(code)

/** The three-character category: I63.9 → I63, S06.0X0 → S06. */
export const icdCategory = (code: string) => normaliseIcd(code).replace('.', '').slice(0, 3)

/** The chapter a code belongs to, by its category's range. */
export function icdChapter(code: string): IcdChapter | undefined {
  const cat = icdCategory(code)
  return ICD_CHAPTERS.find((c) => cat >= c.from && cat <= c.to)
}

/** Whether `code` falls under `filter`: the same code, or a sub-code of a category or a parent (I63 covers I63.9). */
export function icdMatches(code: string, filter: string, includeSubcodes = true): boolean {
  const c = normaliseIcd(code)
  const f = normaliseIcd(filter)
  if (c === f) return true
  return includeSubcodes && c.replace('.', '').startsWith(f.replace('.', ''))
}

/**
 * Codes for a search: by code prefix first, then by words in the label. `extra`
 * lets a caller search its own codes too (the patient's problems, the AI's
 * suggestions), which come first when they match.
 */
export function searchIcd(query: string, { extra = [], limit = 8 }: { extra?: IcdEntry[]; limit?: number } = {}): IcdEntry[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  const seen = new Set<string>()
  const pool = [...extra, ...ICD10].filter((e) => {
    const k = normaliseIcd(e.code)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const words = q.split(/\s+/).filter(Boolean)
  const byCode = pool.filter((e) => e.code.toLowerCase().replace('.', '').startsWith(q.replace('.', '')))
  const text = (e: IcdEntry) => `${e.label} ${SYNONYMS[icdCategory(e.code)] ?? ''}`.toLowerCase()
  // A short word (tb, af, mi) must be a whole word; a longer one matches the start of a word.
  const tests = words.map((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(w.length <= 3 ? `\\b${esc}\\b` : `\\b${esc}`)
  })
  const byLabel = pool.filter((e) => !byCode.includes(e) && tests.every((t) => t.test(text(e))))
  return [...byCode, ...byLabel].slice(0, limit)
}

/** "I63.9 Cerebral infarction, unspecified" — for audit details and exports. */
export const icdText = (c: IcdCode) => `${normaliseIcd(c.code)} ${c.label}`

/**
 * A three-character category's name, from the labels under it: what they all
 * begin with ("Cerebral infarction" for I63), or the first label's head.
 */
export function icdCategoryLabel(category: string): string {
  const cat = normaliseIcd(category)
  if (CATEGORY_NAMES[cat]) return CATEGORY_NAMES[cat]
  const labels = ICD10.filter((e) => icdCategory(e.code) === cat).map((e) => e.label)
  if (labels.length === 0) return cat
  const head = (l: string) => l.split(',')[0].trim()
  if (labels.length === 1) return head(labels[0])
  let prefix = labels[0]
  for (const l of labels) while (!l.startsWith(prefix)) prefix = prefix.slice(0, -1)
  // Keep whole words only: drop a word the prefix cut in half.
  const endsOnWord = labels.every((l) => !/[A-Za-z0-9]/.test(l.charAt(prefix.length)))
  if (!endsOnWord) prefix = prefix.replace(/\S*$/, '')
  prefix = prefix.replace(/[\s,(–-]+$/, '')
  return prefix.length >= 4 ? prefix : head(labels[0])
}

/** Categories whose codes share no common wording — named as the classification names them. */
const CATEGORY_NAMES: Record<string, string> = {
  D68: 'Other coagulation defects',
  E87: 'Fluid, electrolyte and acid-base disorders',
  I25: 'Chronic ischaemic heart disease',
  I61: 'Intracerebral haemorrhage',
  I63: 'Cerebral infarction',
  J44: 'Chronic obstructive pulmonary disease',
  N18: 'Chronic kidney disease',
  O99: 'Other maternal diseases complicating pregnancy',
  R65: 'Systemic inflammatory response syndrome',
  S06: 'Intracranial injury',
  Z79: 'Long-term (current) drug therapy',
  Z86: 'Personal history of certain other diseases',
}

/** The categories among some codes, as entries a cohort filter can pick ("I63 — every code"). */
export function icdCategoriesOf(codes: string[]): IcdEntry[] {
  return [...new Set(codes.map(icdCategory))].map((cat) => ({ code: cat, label: icdCategoryLabel(cat), leaf: false }))
}
