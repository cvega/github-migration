---
name: svelte-frontend-engineering
description: 'Implement polished frontend experiences in this Svelte 5 migration dashboard. Use for Svelte components, Tailwind and Primer styling, responsive layouts, forms, interactions, accessibility, visual regressions, screenshot verification, or translating a product design direction into production UI.'
argument-hint: 'Describe the frontend behavior or design to implement'
---

# Svelte Frontend Engineering

Translate an approved interaction and visual direction into maintainable Svelte 5 code that fits the existing application.

## Project Stack

- Svelte 5 and SvelteKit
- Tailwind CSS utilities
- Primer functional color tokens
- Generated Octicons through `Octicon.svelte`
- Bun for installs, scripts, tests, and builds
- Playwright for browser and responsive verification

Use the official Svelte MCP tools whenever Svelte development is involved. Run the Svelte autofixer on every changed component and again after correcting any reported issue.

## Implementation Workflow

1. Start from the screenshot, failing behavior, route, or component named by the user.
2. Inspect the nearest component that owns the layout or interaction and one relevant shared component or neighboring implementation.
3. Form a falsifiable hypothesis about the controlling cause and identify the cheapest browser or test check that can disprove it.
4. For composition-heavy or reference pages, load `design-system-reference`; also load `component-showcase` for shared component catalogs and `interface-typography` for font or text-hierarchy work.
5. Implement the smallest structural change that satisfies the design direction. Fix width allocation, hierarchy, or component behavior before adding local spacing overrides.
6. Immediately run a focused check after the first edit.
7. Render the exact reported viewport, then test one narrower and one wider viewport. Capture screenshots for visual work.
8. Exercise interactive, empty, disabled, selected, error, and success states affected by the change.
9. Run focused tests, `bun run check`, and `git diff --check`. Run `bun run build` for shared styling, routing, or production-sensitive changes.

## Engineering Standards

- Follow existing Svelte 5 runes and component patterns.
- Reuse established components and Primer tokens before introducing new abstractions or colors.
- Keep route components focused on composition; move reusable behavior into an existing shared boundary when appropriate.
- Import real production components into reference pages. Do not maintain route-local imitations beside the components they claim to document.
- Use semantic HTML and native controls. Preserve keyboard navigation, focus visibility, labels, and meaningful disabled states.
- Use Octicons for familiar actions and provide accessible names for icon-only controls.
- Keep fixed-format controls dimensionally stable so labels, icons, state changes, and loading content do not shift the layout.
- Define responsive constraints from content needs, not conventional breakpoint habit. Stack groups before their labels wrap or controls become cramped.
- Do not hide required workflow content on small screens.
- Do not patch a shared component globally when only one route needs a different composition; expose a clear variant only when reuse is real.
- Avoid broad mechanical class replacements unless the design system itself is intentionally changing.
- Preserve user changes and avoid unrelated formatting or refactors.
- Keep exhaustive registries subordinate to applied examples. Use disclosure or generated lookup views when inventory would dominate the page.

## Visual Verification

For every visual change, verify all of the following in the browser:

- Computed font sizes, dimensions, and grid tracks match the intended design.
- Important short labels and headings remain on one line at supported desktop widths.
- No page-level horizontal overflow occurs.
- Text does not clip or overlap at desktop and mobile widths.
- Responsive icons and controls render exactly once in the intended mode.
- Hover, focus, selected, disabled, loading, empty, and error states remain legible.
- The screenshot improves the original complaint directly; surrounding whitespace alone is not evidence of success.
- The first two screenfuls show the primary product workflow or task, not abstract tokens, principles, or component inventories.
- Borders and background levels encode actual component structure; count and remove decorative containers before finalizing.

Report the viewport sizes tested and the focused validation results when the work is complete.
