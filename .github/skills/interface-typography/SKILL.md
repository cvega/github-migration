---
name: interface-typography
description: 'Design and audit typography for this migration dashboard. Use when text hierarchy, type specimens, font loading, headings, labels, metadata, code values, density, readability, or a styleguide typography section feels generic, weak, flat, inconsistent, or visually unconvincing.'
argument-hint: 'Describe the typography or text-hierarchy problem'
---

# Interface Typography

Treat typography as interface structure. Type must distinguish decisions, instructions, status, and machine identity without relying on extra boxes or decoration.

## Font Audit

1. Inventory bundled font assets and existing `@font-face` declarations.
2. Verify the computed font family in the browser; a token declaration alone is not proof that the font loaded.
3. Use Mona Sans for interface language and Mona Sans Mono for repositories, tokens, dimensions, and machine values.
4. Keep robust local fallbacks and `font-display: swap`.
5. Confirm variable weight ranges match the bundled files.

Do not introduce a new font dependency while an appropriate bundled product font is unused.

## Product Roles

Use a small role system:

- **Page**: route or task title; 32/40/600 at reference scale.
- **Stage**: current decision or major subsection; 20/28/600.
- **Body**: instruction and operational context; 15/22/400.
- **Meta**: status, counts, labels, and timestamps; 13/18/500.
- **Machine**: repository paths, tokens, IDs, and dimensions; 14/20 mono.

Adjust size only when the surrounding production component establishes a stricter local scale. Do not use text below 13px for required information.

## Hierarchy Rules

- Establish hierarchy with size, weight, line height, width, and contrast before adding containers.
- Keep letter spacing at zero for normal interface copy.
- Use sentence case for headings and controls.
- Reserve uppercase for short structural labels and reference metadata.
- Keep muted text legible; do not stack multiple low-contrast levels in one sentence.
- Use tabular numerals for changing counts, durations, percentages, and rates.
- Use monospace only where character identity matters.
- Prevent short headings, navigation labels, and button labels from wrapping at supported desktop widths.

## Type Reference Design

A styleguide must show typography in use before listing metrics.

Build one applied composition containing:

- Route context
- A page or stage title
- Instructional body copy
- A source-to-destination repository identity
- Operational status

Place the compact role ledger beside or below that composition. Do not present five equal sample rows; that hides hierarchy while claiming to document it.

## Responsive Behavior

- Reduce page titles deliberately at narrow widths; do not scale type continuously with viewport width.
- Preserve role contrast after stacking.
- Keep repository paths truncatable without hiding their direction.
- Move the role ledger below the applied composition before either column becomes cramped.
- Verify zoom and 390px layouts for clipping and overlap.

## Verification

1. Inspect computed `font-family`, `font-size`, `line-height`, and `font-weight` for every role.
2. Assert that bundled fonts are loaded through `document.fonts`.
3. Capture desktop and mobile screenshots of the applied type composition.
4. Check long repository names, large counts, and status strings.
5. Run strict Svelte checks and the production build after global font changes.

## Rejection Gates

Reject the typography when:

- The browser falls back to the generic system stack unexpectedly.
- The type section is only a metrics table or equal-weight sample list.
- Heading and body roles differ only by weight.
- Monospace is used as decoration rather than for machine identity.
- Required text is below 13px, clipped, or illegible at mobile width.
- The styleguide type sample does not resemble a real product surface.
