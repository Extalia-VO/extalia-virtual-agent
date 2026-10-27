# Night lighting coverage

Delivered in 0.4.85 on 2026-10-23.

The night coverage correction adds a ceiling row between the east room boundary and the existing circulation spine on F1–F3. F1 reuses its lounge ceiling; F2/F3 receive matching soffits. Three shielded downlights beneath each higher returning stair flight illuminate the current storey with an explicit floor bound. The upper-floor stair void remains a void, rather than being treated as a dark floor.

The F3 terrace retains its seating lights with wider finite pools and adds ten shielded path posts along the walking edges. The entrance lane remains clear. Light comes from physical fixtures with finite ranges; existing room fixtures and global ambient brightness are unchanged.

## Verification

- Regression probes bake the production fixture layouts and use the renderer's trilinear volume sampling at the finished-floor surface. They cover the apron/spine transition, the actual F1 floor beneath the returning flight, both terrace walking strips and the central passage. They also check fixture mounting, storey isolation and the interior/exterior control policy.
- Actual Office views on F1, F2 and F3 were inspected at simulated midnight. The previously unlit east apron samples reach at least 2.55 cached irradiance; the under-return samples improve from 0.018 to 3.52 or more. The sampled terrace approaches and walking paths improve from zero to at least 0.77. These are renderer-relative light values, not physical lux measurements.
- With zero live beams, the cached coverage remains present. Returning to the normal six-beam budget leaves the checked cached samples unchanged.
- At night, manual Off extinguishes interior circulation and under-stair fixtures while terrace lamps retain their exterior photocell control. In daylight, On restores full interior output and Auto uses the existing 0.3 daytime factor; exterior lights remain off. Auto at night restores interior and exterior output.
- Full `pnpm check` passed: 228 suites, 2,410 tests passed and one skipped; Rust checks and Web, CLI and Desktop builds passed. The focused lighting review passed 30 tests. Source review found no unresolved mounting or floor-bound issues.

Screenshots and probe logs are local review artifacts. No user profile, runtime configuration or persistent scene preference was modified for the review.
