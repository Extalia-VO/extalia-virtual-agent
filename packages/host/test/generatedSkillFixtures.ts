/** Synthetic generated proposals meet the same metadata/completeness gate as production. */
export const generatedSkillMetadata = () => ({
  categories: ['quality'], intents: ['validate_records'],
  verificationCases: [{ id: 'invalid-input', input: 'A record has a missing required identifier. Describe the safe validation order before saving it.',
    expectedIncludes: ['validate'], forbiddenIncludes: ['save invalid input'] }],
});
export const completeSkillInstructions = (procedure: string, when = 'Use when validating input before a durable change.') =>
  `## When to Use\n${when}\n\n## Procedure\n${procedure}\n\n## Pitfalls\nDo not assume that unchecked input is valid.\n\n## Verification\nConfirm the actual result and report any validation failure.`;
