---
name: design-system-reference
description: 'Design, audit, and implement live design-system documentation for this migration dashboard. Use when working on /styleguide, component catalogs, token references, pattern libraries, reference compositions, visual standards, or when documentation feels bare, generic, fragmented, overly bordered, or disconnected from production Svelte components.'
argument-hint: 'Describe the reference page, component library, or documentation problem'
---

# Design System Reference

Build reference pages that demonstrate Migration Workbench as a coherent operating system. A style guide is a product surface, not an inventory dump.

Load `component-showcase` before inventorying or rendering shared components. Load `interface-typography` before changing font assets, type roles, or typography specimens.

## Required Architecture

Order content by usefulness:

1. **System in use**: lead with the primary workflow or composition at natural size.
2. **Anatomy**: identify the few structural parts that make the composition reusable.
3. **Foundations in context**: connect color, type, spacing, and geometry to visible UI.
4. **Live components**: render actual Svelte components only when isolation teaches a reusable contract.
5. **Lookup details**: place exhaustive names, tokens, and dimensions after the applied reference or behind disclosure.

Do not lead with principles, token grids, or a component registry. Keep navigation to five entries or fewer.

## Visual Direction

The reference should feel like an internal infrastructure manual: precise, compact, directional, and calm.

- Use one dominant composition per viewport and let secondary references support it.
- Repeat the source-to-destination axis as the signature geometry.
- Use Primer canvas and one surface level in a section. Add inset surfaces only inside actual controls or previews.
- Use blue for path, focus, and selection; green for safe executable action; amber for production consequence; red for failure or destructive action.
- Use borders only for control boundaries, data tables, or meaningful containment. Never use repeated horizontal rules as section decoration.
- Use monospace for identifiers, tokens, dimensions, and component filenames, not general labels.
- Prefer captions, legends, and annotations over cards.
- Avoid equal-weight grids unless the content is genuinely comparative.

## Art Direction Gate

State these decisions before implementation:

- **Reference model**: the concrete document or product class the page should resemble.
- **Signature geometry**: the repeated spatial idea specific to repository migration.
- **Hierarchy**: the one dominant composition and the order of supporting material.
- **Restraint**: the surfaces, borders, colors, and decorative devices deliberately excluded.

Reject a direction if it could be transferred unchanged to billing, analytics, CRM, or generic developer documentation. A reference to GitHub styling is not sufficient; the composition must express source, destination, staged decisions, and operational consequence.

## Cover And Navigation

- Treat the masthead as a compact reference cover, not a landing-page hero or dashboard summary.
- Keep the title, edition metadata, and reference index on one shared editorial grid.
- Do not place the reference index in a generic floating card. Use alignment, a quiet rule, or tabular spacing to integrate it with the cover.
- Avoid empty vertical bands created by a short title beside a tall navigation panel.
- Keep section navigation visually attached to the canvas and subordinate to the applied composition.
- At mobile widths, show every short section label in full. Use equal-width tabs or intentional scrolling with an obvious continuation; never leave a label partially clipped.

## Content Test

For every section, answer:

- What task does this help a designer or engineer complete?
- What real production surface demonstrates the rule?
- Is this content for learning, comparison, or lookup?
- Could any item be removed without losing implementation guidance?

Remove sections that only narrate taste. Principles must be demonstrated by the page's composition or written as short captions beside an applied example.

## Production Binding

- Import actual Svelte components for live specimens; do not redraw them in route-local HTML.
- Label each specimen with where it is used and what contract it demonstrates.
- Do not show both a production component and a route-local imitation of the same concept.
- Keep exhaustive component inventories in generated documentation or disclosure, not as the main page composition.
- Derive displayed counts from the same data that renders the reference.
- Keep fixtures local, deterministic, and free of network or mutation side effects.

## Reference Treatments

Use a small, consistent grammar:

- **Composition**: full-width rendered workflow with compact controls above it.
- **Anatomy**: numbered callouts aligned to the rendered composition.
- **Token role**: color sample, semantic name, token, and one usage phrase on a single row.
- **Type role**: actual product text, role name, and metrics on a single row.
- **Live component**: context caption beside an unmodified production component.

Do not mix more than three treatments on one screenful.

## Responsive Contract

- Desktop compositions render at natural width without nested horizontal scrolling.
- Mobile uses the component's real mobile composition, not a scaled desktop screenshot.
- Reference navigation may scroll horizontally only when every label cannot fit intact; page content may not overflow.
- Stack captions above specimens before labels wrap or controls compress.
- Avoid sections taller than roughly 700px without a meaningful subsection heading or disclosure.

## Review Workflow

1. Capture the complete page at 1440px, the reported viewport, and 390px.
2. Review the first two screenfuls before inspecting details. The workflow and system character must be obvious there.
3. Count visible containers, border lines, and presentation modes. Reduce any that do not encode structure or state.
4. Verify one shared left edge for primary section headings and content.
5. Exercise every live specimen and selected state.
6. Compare before and after screenshots. Reject changes that only alter spacing, borders, or copy without improving hierarchy.
7. Run the official Svelte autofixer, focused Playwright tests, project checks, and build.

## Rejection Gates

Do not ship when any of these are true:

- The main workflow appears after foundations or inventory content.
- The first screenful could belong to a generic documentation site.
- A component registry occupies more space than an applied composition.
- Tokens are shown without a visible usage example.
- The page uses repeated cards or rulers to create hierarchy.
- More than two background levels compete in one section.
- The desktop reference requires horizontal scrolling.
- The mobile page hides required reference content.

## Acceptance Criteria

- The primary migration composition appears within the first two screenfuls.
- A reader can identify the workflow rail, route, workbench, and action dock without reading normative prose.
- Every live specimen is an imported production Svelte component with a clear usage context.
- Foundations are scannable as semantic roles and visibly map to the applied composition.
- The page has one coherent visual grammar across desktop and mobile.
- Screenshots demonstrate stronger hierarchy and character, not merely fewer defects.
