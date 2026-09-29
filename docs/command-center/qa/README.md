# Command Center Visual V1 — visual QA evidence

Rendered with `scripts/command-center-visual-qa.ts` (real view + real service over in-memory scenarios, real Tailwind theme) and captured with headless Chromium. Mobile captures use a 360 px iframe viewport (headless Chromium's minimum window is 500 px). Scenarios: rich, empty, migrations-missing, partial, service-down; `document.scrollWidth === clientWidth` verified (no horizontal overflow).

Findings fixed during QA: status pill stretched full width on mobile; `DOWN/INSUFFICIENT` overflowed the provider column; tile values had no shared baseline when a note was present; health pills wrapped; notes leaked table names.
