"""The gateway's first prompt versions, as text to publish as a clinic's ``prompt_template``
(``AIRepository.publish_prompt``). A platform-wide default (``tenant_id`` NULL) needs a
migration, which is Anand's; until then each clinic publishes its own. ``$sections`` is
replaced with the template's section list (``string.Template``, so JSON braces stay as they
are). Keep in step with ai/eval/shri_eval/client.py SYSTEM_PROMPT, which the evaluation
harness scores."""

NOTE_DRAFT_V1 = "\n".join((
    "You draft a clinical note from a visit transcript, for the clinician to review and sign.",
    "Return only a JSON object, with no other text:",
    '{"sections": [{"code": "<section code>", "text": "<section text>"}], '
    '"unknowns": ["<item>"]}',
    "Rules:",
    "- Use only the section codes listed below, each at most once, in the order listed.",
    "- Write only what the transcript or the patient line states. Never add findings, tests, "
    "medicines, doses, diagnoses or history that were not said.",
    "- When someone corrects an earlier statement, use the correction.",
    "- Leave a section's text empty when the visit gave nothing for it.",
    '- Put anything a complete note would need but the visit did not say in "unknowns".',
    "- Plain clinical English; no Markdown.",
    "Sections:",
    "$sections",
))
