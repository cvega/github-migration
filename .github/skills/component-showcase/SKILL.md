---
name: component-showcase
description: 'Design, audit, and implement production component showcases for this Svelte migration dashboard. Use when building a component catalog, UI inventory, styleguide specimens, state gallery, pattern library, or when component documentation feels sparse, repetitive, fake, boxed, or disconnected from real product behavior.'
argument-hint: 'Describe the component catalog or showcase problem'
---

# Component Showcase

Present the shared component library as a working product system, not a list of filenames or a grid of decorative demos.

## Inventory Gate

Before designing the page:

1. Enumerate every shared Svelte component and group it by product responsibility.
2. Classify each component as deterministic, locally interactive, network-dependent, mutating, or shell-level.
3. Record required props, useful contrasting states, and side effects.
4. Identify the largest safe set that can render with local deterministic fixtures.
5. Explain why every omitted component cannot be shown safely or meaningfully.

A component count is not evidence of coverage. The rendered page must make the coverage visible.

## Showcase Architecture

Group components by the work they perform:

- Migration operations
- Source intelligence
- Identity and access
- Status and consequence
- Navigation and primitives

Use production context to determine composition. A migration card belongs in a queue, status components belong in a status matrix, inputs belong in a configuration surface, and icons belong in a semantic vocabulary. Do not force unlike components into identical specimen rows or equal cards.

## Production Binding

Every showcased component must:

- Import the production `.svelte` file.
- Use deterministic fixtures with no external network requirement.
- Expose a meaningful state, interaction, or contrast.
- Preserve production keyboard, focus, label, disabled, and loading behavior.
- Show its product role and source component name.
- Avoid a route-local imitation of the same UI.

Use at least two states for components whose purpose is state communication. Prefer running/failed, healthy/incident, managed/manual, selected/unavailable, empty/populated, and safe/destructive contrasts.

## Composition Rules

- Lead with the strongest operational components, not primitives.
- Vary module width and treatment according to complexity.
- Keep production components unframed when they already provide their own boundary.
- Add a containing surface only when the component requires context to read correctly.
- Avoid nested cards, repeated caption rails, and decorative borders.
- Keep exhaustive inventory behind native disclosure after live examples.
- Do not use a generic tab strip when a compact index already provides navigation.
- Treat the number of distinct live component types separately from the number of composed modules.

## Fixture Standards

- Use typed fixtures that satisfy exported application contracts.
- Use fixed timestamps and stable counts for screenshots.
- Never include real credentials, tokens, hosts, or user data.
- Do not trigger real mutations, polling, navigation, or API requests on page load.
- Mock network-dependent components only when the repository already has an established adapter or fixture boundary.

## Interaction Coverage

Exercise all applicable behavior:

- Bindable selection and input state
- Pagination boundaries
- Dialog open, validation, close, and submitting states
- Copy feedback
- Disabled and unavailable options
- Running, success, warning, failure, and destructive states
- Responsive layout at desktop and mobile widths

## Verification

1. Run the official Svelte autofixer on changed components.
2. Run strict Svelte and TypeScript checks.
3. Add a focused Playwright contract that asserts distinct live component coverage.
4. Exercise at least one interaction in each product group.
5. Capture 1440px, the reported viewport, and 390px screenshots.
6. Check for page-level overflow, clipped labels, nested framing, and repeated presentation modes.
7. Verify that the first two screenfuls visibly contain production components.

## Rejection Gates

Reject the showcase when:

- Fewer than half of safe shared components render live.
- Most examples use the same caption-plus-box layout.
- The inventory is more prominent than the components.
- State-bearing components show only their default state.
- Production components are replaced with local HTML facsimiles.
- Component names are visible but component behavior is not.
- Mobile hides examples or clips required control labels.
