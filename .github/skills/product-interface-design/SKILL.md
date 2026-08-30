---
name: product-interface-design
description: 'Design and critique modern product interfaces for this migration dashboard. Use when redesigning pages, reviewing screenshots, improving visual hierarchy, layout, density, spacing, typography, interaction flow, responsive behavior, or when the UI feels dated, cramped, generic, or inconsistent.'
argument-hint: 'Describe the page, workflow, or visual problem to design'
---

# Product Interface Design

Create a clear visual and interaction direction before polishing individual components. This is an operational migration tool: it should feel focused, trustworthy, efficient, and contemporary rather than decorative or marketing-oriented.

## Workflow

1. Inspect the live page at the viewport where the problem occurs. Capture desktop and mobile screenshots when the page is responsive.
2. Identify the primary user task, the decision sequence, and the information that must be scanned or compared.
3. Diagnose the composition before changing details. Check hierarchy, grouping, alignment, width allocation, density, typography, contrast, states, and action placement.
4. Find the owning layout or shared component that controls the problem. Do not compensate for a narrow or rigid layout by adding padding around it.
5. State one visual direction and the concrete changes needed to achieve it. Prefer a coherent direction over a menu of interchangeable options.
6. Name one concrete reference model and three signature moves that make the direction visible in composition, not just copy or color.
7. Define responsive behavior explicitly, including when columns resize, rebalance, or stack.
8. Review the implemented page at the original problem viewport and at one narrower and one wider viewport.

## Design Standards

- Preserve the dashboard's GitHub-adjacent visual language without copying GitHub mechanically.
- Keep the interface quiet and work-focused. Use color to communicate action, status, and risk.
- Build hierarchy through composition, type weight, spacing, and contrast before adding borders, badges, or containers.
- Give each page one dominant visual idea. Supporting sections must reinforce it rather than introduce unrelated presentation modes.
- Use borders only when they describe a control, data boundary, or meaningful containment. Do not use repeated rulers as document scaffolding.
- Avoid nested cards, decorative panels, excessive pills, and repeated helper copy.
- Avoid equal-weight grids for unlike content. Allocate visual weight according to task importance and content complexity.
- Allocate width by content complexity. Controls with several choices need more room than a single empty or selected state.
- Do not allow important option names, button labels, navigation labels, or short headings to wrap at supported desktop widths.
- Use a consistent 4px/8px spacing rhythm. Increase whitespace only when it clarifies groups or workflow stages.
- Keep body and control text comfortably legible. Reserve tiny text for genuinely secondary metadata.
- Make the primary action obvious but proportionate. Keep secondary actions visually quieter.
- Prefer progressive disclosure for advanced settings and details that are not needed for the current decision.
- Design complete empty, loading, error, disabled, selected, success, and destructive states.
- On mobile, preserve the task order and full control labels; stack complete groups before compressing their contents.

## Art Direction Gate

Before implementation, state:

- **Reference model**: the product or document class this should feel like.
- **Signature geometry**: the repeated spatial idea that belongs to this domain.
- **Hierarchy**: the single dominant composition and its supporting content.
- **Restraint**: which colors, borders, surfaces, and decorative treatments are intentionally excluded.

Reject a direction if it could be transferred unchanged to billing, analytics, CRM, or generic documentation. For long reference pages, load the `design-system-reference` skill. Load `component-showcase` when shared components are being cataloged and `interface-typography` when hierarchy or type specimens are part of the complaint.

## Critique Format

Lead with the highest-impact design problems, grounded in the screenshot or rendered page. Explain why each issue harms scanning, comprehension, or task completion. Then provide:

1. The intended visual direction.
2. The revised page hierarchy and responsive composition.
3. Component-level changes.
4. Interaction and state behavior.
5. Observable acceptance criteria.

Avoid vague feedback such as "add breathing room" unless it names the exact relationship, dimension, and expected result.

## Acceptance Criteria

- The primary task and next action are understandable within a few seconds.
- Related controls read as groups without relying on excessive framing.
- Important labels remain on one line at supported desktop widths.
- No text, controls, or status content overlap, clip, or create page-level horizontal overflow.
- Desktop density supports repeated operational use; mobile remains complete and touch-friendly.
- Before and after screenshots demonstrate a structural improvement, not merely different spacing.
- The first two screenfuls communicate the page's domain and dominant composition without explanatory prose.
