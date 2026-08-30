# Interface Review Plan

This tracker applies the [Migration Workbench](../docs/design-system/migration-workbench.md)
to every user-facing page. Review only the route currently agreed with the user;
do not advance to another route without explicit approval.

**Current scope:** `/migrate/new`

## Review Method

For each page:

1. Capture populated desktop screenshots at 1024 × 768 and 1280 × 800.
2. Capture a mobile screenshot at 390 × 844.
3. Exercise relevant empty, loading, selected, disabled, error, success, and
   destructive states.
4. Record hierarchy, typography, spacing, alignment, control consistency,
   responsive behavior, accessibility, and overflow findings.
5. Fix the owning layout or shared component rather than compensating locally.
6. Run the focused workflow, Svelte autofixer, `bun run check`, and
   `git diff --check`.
7. Mark the route complete only after visual inspection of the final screenshots.

## Route Tracker

| Order | Route | Primary task | Status |
|---|---|---|---|
| 1 | `/login` | Authenticate | Not reviewed |
| 2 | `/account/password` | Replace a temporary or current password | Not reviewed |
| 3 | `/setup` | Configure source and target access | Not reviewed |
| 4 | `/` | Understand system state and choose the next workflow | Not reviewed |
| 5 | `/profile` | Start and browse profile runs | Not reviewed |
| 6 | `/profile/[id]` | Inspect findings and migration readiness | Not reviewed |
| 7 | `/migrate` | Browse and manage migrations | Not reviewed |
| 8 | `/migrate/stats` | Compare migration outcomes and throughput | Not reviewed |
| 9 | `/migrate/new` | Choose a path, configure, review, and launch | Partial; needs full guide audit |
| 10 | `/migrate/[id]` | Monitor and operate one migration | Not reviewed |
| 11 | `/migrate/batches/[id]` | Monitor and operate a migration batch | Not reviewed |
| 12 | `/admin/users` | Create and manage users | Partial; needs full guide audit |
| 13 | `/admin/users/[id]` | Change one user's access | Not reviewed |
| 14 | `/admin/audit` | Review operator activity | Not reviewed |

## Cross-Page Reviews

Complete these after the first three route reviews expose stable patterns:

- App header, navigation, account control, and mobile behavior.
- Page headers, titles, descriptions, status metadata, and primary actions.
- Buttons, icon buttons, focus treatment, and disabled states.
- Form labels, inputs, selects, validation, and help text.
- Status badges, alerts, empty states, and loading states.
- Panel framing, side rails, tables, dialogs, and pagination.

## Completion Criteria

- Every route is marked complete with desktop and mobile screenshots reviewed.
- Shared patterns conform to the style guide or document a justified exception.
- No supported page has document-level horizontal overflow, clipped controls, or
  wrapped short labels at desktop widths.
- Keyboard focus, dialog behavior, errors, and destructive actions are verified.
- Full `bun run verify` passes after the final route group.
