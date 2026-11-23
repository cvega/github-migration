# Migration Workbench

Migration Workbench is the visual system for the dashboard. It is built around
one product-specific idea: every migration is a directed path from a source to a
destination. The interface should make that path visible, keep operational data
easy to scan, and make consequential actions unmistakable.

Open `/styleguide` in the running application to compare the live path,
configuration, and review compositions at desktop and mobile sizes. The route
uses the application's actual Svelte, Primer, Octicon, and design-token stack.

This is a normative specification. It defines what the product should become;
it is not a catalog of the current UI.

## Visual Direction

**Character:** precise, infrastructural, focused, and quietly confident.

**Signature:** a continuous directional spine connects workflow progress,
source and destination, repository mappings, and launch state. Direction is
communicated through alignment and line work, not through stacks of cards.

**Reference:** GitHub supplies familiar typography, color semantics, icons, and
control behavior. Migration Workbench supplies its own composition and rhythm.
It should not look like a generic admin template or a mechanical GitHub clone.

### The Four Rules

1. **One workbench, not a card stack.** A workflow gets one primary task
   surface. Internal groups use spacing and quiet rules before additional
   containers.
2. **The path is the organizing geometry.** Source, transfer, and destination
   align on one axis. Progress and mappings repeat that direction.
3. **Controls are compact; compositions are spacious.** Interactive controls
   remain efficient while major sections have clear separation.
4. **State changes emphasis, not geometry.** Empty, selected, unavailable,
   loading, and error states keep the same frame dimensions.

## What Makes It Distinctive

- A six-position workflow rail is always visible during migration creation.
- Source and destination are presented as equal endpoint columns joined by a
  directional transfer lane.
- Provider and target choices use one shared endpoint-option anatomy.
- Repository paths are rendered as directional mappings, not generic table rows.
- The bottom action dock is stable throughout the workflow.
- Blue traces the configured path. Green appears only when work is executable or
  complete. Amber is reserved for production consequences.
- Major content sits on an open canvas. Borders are scarce enough to communicate
  real boundaries.

## Anti-Direction

Reject a design when it depends on any of the following:

- A stack of full-width bordered rectangles with equal emphasis.
- A card nested inside another card to manufacture hierarchy.
- Square icon badges in front of every heading.
- Pills used as decoration or as substitutes for plain metadata.
- Tiny uppercase labels repeated above every value.
- More whitespace around a control whose internal layout remains cramped.
- Different dimensions or icon scales for controls in the same decision.
- A success-colored stripe added only to make a page feel less plain.
- A side rail that contains information required to complete the main task.
- Generic dashboard composition that could represent billing, analytics, or CRM
  without changing its geometry.

## Foundations

### Color Roles

Use Primer functional values through the project aliases. Color is assigned by
role, not by page.

| Role | Project token | Primer source | Purpose |
|---|---|---|---|
| Inset | `--workbench-canvas-inset` | `bgColor-inset` | Recessed previews and code wells |
| Canvas | `--workbench-canvas` | `bgColor-default` | Application and workflow background |
| Workbench | `--workbench-surface` | `bgColor-muted` | The single primary task surface |
| Control | `--workbench-control-surface` | `control-bgColor-rest` | Inputs, choices, menus |
| Control hover | `--workbench-control-hover` | `control-bgColor-hover` | Pointer hover state |
| Control active | `--workbench-control-active` | `control-bgColor-active` | Pressed and selected neutral state |
| Rules | `--workbench-rule-muted`, `--workbench-rule`, `--workbench-rule-strong` | `borderColor-muted`, `default`, `emphasis` | Separators through control boundaries |
| Text | `--workbench-text`, `--workbench-text-muted`, `--workbench-text-disabled` | `fgColor-default`, `muted`, `disabled` | Content hierarchy |
| Path | `--workbench-path-*` | `accent` foreground, muted, border, emphasis | Current step, selection, focus, direction |
| Executable | `--workbench-ready-*` | `success` foreground, muted, border, emphasis | Ready state and primary actions |
| Production | `--workbench-production-*` | `attention` foreground, muted, border, emphasis | Production consequences and warnings |
| Failure | `--workbench-danger-*` | `danger` foreground, muted, border, emphasis | Validation, failed work, destructive action |

Each semantic family uses Primer's purpose-built foreground, muted background,
border, and emphasis tokens. Do not derive state surfaces from foreground colors
with opacity or `color-mix()`.

**Surface limit:** a normal page uses at most three simultaneous background
levels: canvas, workbench, and raised control. If a fourth shade is needed,
reconsider the grouping.

**Border budget:** a workflow viewport may show one workbench outline, one action
dock rule, and only the outlines required to identify interactive controls or
data boundaries. Internal section borders must not create independent cards.

### Typography

Use the GitHub system stack already defined in `src/app.css`. Letter spacing is
always `0`.

| Role | Size / line height | Weight | Use |
|---|---|---|---|
| Page title | 24px / 32px | 600 | One per route |
| Stage title | 20px / 28px | 600 | Current workflow decision |
| Section title | 16px / 24px | 600 | Named content group |
| Body / control | 15px / 22px | 400–600 | Instructions, fields, buttons |
| Metadata | 13px / 18px | 500 | Counts, progress, helper text |
| Metric | 28px / 32px | 600 | One operational quantity at a time |
| Machine value | 14px / 20px | 400–600 mono | Repository paths and identifiers |

- Page and stage titles use sentence case.
- Uppercase is limited to column headers and short structural labels.
- Do not render text below 13px.
- Platform names, button labels, short headings, and step names do not wrap on
  supported desktop layouts.

### Spacing and Sizing

| Token | Value | Typical use |
|---|---:|---|
| `space-1` | 4px | Label to helper, icon optical adjustment |
| `space-2` | 8px | Icon to text, compact inline groups |
| `space-3` | 12px | Control padding, related control gap |
| `space-4` | 16px | Fields within a group |
| `space-6` | 24px | Workbench section padding |
| `space-8` | 32px | Major group separation |
| `space-12` | 48px | Page-section separation |

| Element | Dimension |
|---|---:|
| Standard control | 40px high |
| Primary / mobile control | 44px high |
| Endpoint option | 72px high |
| Icon button | 32px or 40px square |
| Endpoint icon well | 40px square |
| Workbench radius | 6px |
| Control radius | 6px |
| Page max width | 1280px |
| Reading / form measure | 720px maximum |
| Launch rail | 304px desktop |

## Component Specifications

### Page Masthead

The masthead is unframed and has three zones:

1. A 24px page title and one-line purpose statement.
2. Optional route-level action aligned to the title baseline.
3. Capacity or status metadata aligned to the far edge.

Do not place the page title inside a card or repeat it in the workbench. A stage
badge is unnecessary when the workflow rail already communicates position.

### Workflow Rail

The migration creation rail has six positions:

`Path → Repositories → Source access → Destination → Options → Review`

- Desktop: one horizontal rail above the workbench.
- Mobile: current position plus `n of 6`; the full list is available without
  hiding the current task.
- Complete steps use a check and muted text.
- Current step uses the blue path trace and strong text.
- Future steps use muted text without individual bordered containers.
- The rail does not move when validation appears.

### Workbench

The workbench is the single framed workflow surface.

- Header: stage title, one sentence of guidance, optional count.
- Body: open sections separated by 32px spacing or one quiet rule.
- Dock: persistent back/cancel and continue/launch actions.
- Desktop padding: 32px. Mobile padding: 20px.
- No internal section receives a card treatment unless it is an interactive
  choice, a field, or a bounded data list.

### Endpoint Option

Source providers and target profiles share one component anatomy:

```text
┌──────────────────────────────────────────────────────────────┐
│ [40 icon]  Platform or profile name                 [state] │ 72px
│            One-line operational description                │
└──────────────────────────────────────────────────────────────┘
```

- Height: 72px in every state.
- Padding: 12px horizontal and vertical.
- Icon well: 40px; platform mark: 24px.
- Name: 15px semibold. Description: 13px regular.
- Selected: blue-tinted surface, blue 2px inset leading edge, 16px check.
- Hover: raised-control surface.
- Focus: 2px blue focus ring.
- Disabled: preserve contrast and explain the blocker in the description.
- Empty target: same 72px frame and alignment; no dashed oversized placeholder.

Endpoint regions are equal-width columns on desktop. Each option is full width.
The transfer lane between them is 64px and never owns content. At widths where
either endpoint name would wrap, the complete columns stack.

### Field Group

- Label and required marker appear on one line above the field.
- Label to control: 8px. Field to helper or error: 4px.
- Input and select height: 40px desktop, 44px mobile.
- Related fields share one 12-column layout; they do not become separate cards.
- Errors reserve no space before validation, but appear directly below the
  owning field and receive focus through the existing workflow controller.

### Choice Group

- Two short mutually exclusive choices use a segmented control.
- Rich choices use endpoint-option anatomy or 72px selection rows.
- Every option in one group has equal height and selected-state geometry.
- A check is preferred to an additional status pill.

### Route Summary

A compact route summary repeats the source-to-target spine:

```text
[source mark] Source name ───────────────→ [target mark] Target name
```

It is a single band, not two cards. Use it as persistent context during
configuration and as the lead element during review.

### Repository Mapping

- Header labels: `Source repository` and `Target repository`.
- Row: source path, 32px directional lane, target path.
- Paths use 14px monospace and truncate only when the full value remains
  available by title or detail view.
- Rows use separators, not individual borders.
- Batch review shows three rows and a plain `Review all n` action.

### Status Message

- Inline validation belongs to its field or section.
- Page-level failure uses one alert before the workbench body.
- Ready state uses icon plus text; it does not add a colored top border.
- Capacity is neutral operational metadata unless work will queue.

### Action Dock

- Height: at least 64px; border-top only.
- Back or cancel is left aligned. Continue or launch is right aligned.
- The primary button remains in the same position at every stage.
- Continue and launch with source locking disabled use Primer's green primary button.
  Blue is reserved for path, selection, links, and focus. Launch with source locking enabled is
  amber and destructive action is red.
- Mobile actions remain 44px high and may span the available width.

## Reference Composition: `/migrate/new`

### Frame Shared by All Stages

```text
PAGE MASTHEAD
New migration                                      0 of 10 active
Move repositories between configured platforms.

WORKFLOW RAIL
● Path ─── ○ Repositories ─── ○ Source access ─── ○ Destination ─── ○ Options ─── ○ Review

WORKBENCH
┌──────────────────────────────────────────────────────────────────┐
│ Stage header                                                     │
│                                                                  │
│ Stage-specific body                                              │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ Back / Cancel                                      Primary action │
└──────────────────────────────────────────────────────────────────┘
```

### Path Stage

Two equal endpoint columns make the migration route the primary composition.
Provider choices are vertical rows so names never compete for narrow thirds.

```text
Choose a migration path
Select the source platform and destination profile.

SOURCE                                 TARGET
┌────────────────────────────┐         ┌────────────────────────────┐
│ [GH] GitHub                │         │ [GH] GitHub Enterprise     │
│      Organizations         │ ──────→ │      Cloud                 │
├────────────────────────────┤         └────────────────────────────┘
│ [GL] GitLab                │
│      Namespaces            │
├────────────────────────────┤
│ [BB] Bitbucket Server      │
│      Projects              │
└────────────────────────────┘
```

The target column aligns to the source column's first option. Its region is not
made taller to fill the source list and its option is not styled differently.

### Configuration Stages

The stage rail remains horizontal. Configuration uses a main form and a compact
route context column, not a second navigation sidebar.

```text
Configure repositories
Choose one repository or upload a normalized batch list.

┌───────────────────────────────────────┬──────────────────────────┐
│ Main form, maximum 720px measure      │ ROUTE                    │
│                                       │ GitLab → GHEC            │
│ [Single repository | Batch]           │                          │
│                                       │ SOURCE ACCESS            │
│ Namespace                             │ Administrator managed    │
│ [________________________________]    │                          │
│                                       │ Repeated context only;   │
│ Repository                            │ never required fields.   │
│ [________________________________]    │                          │
└───────────────────────────────────────┴──────────────────────────┘
```

The context column disappears below desktop and becomes a compact route summary
above the form.

### Review Stage

Review is a launch decision, not a success dashboard. It leads with the route,
then mappings, then source handling and capacity immediately above the action dock.

```text
Review and launch                                      1 repository
Confirm the route, destination, and source repository handling.

[GH] GitHub ─────────────────────────────────────→ [GH] GitHub Enterprise Cloud

REPOSITORY MAPPINGS
Source repository                    Target repository
test-group/test                    → test-target-org/test

SOURCE REPOSITORY HANDLING                       CAPACITY
(●) Keep source unlocked  ( ) Lock and archive source   Available now
Both choices write repository data to the destination.

───────────────────────────────────────────────────────────────────
Back                                                 Start migration
```

Do not add a second readiness header, success stripe, or launch-settings card.
Readiness is communicated by the enabled action and concise status text.

## Responsive Contracts

| Width | Composition |
|---|---|
| `≥ 1120px` | Full rail, endpoint columns, main form plus 304px context |
| `768–1119px` | Full rail, stacked endpoint regions, context summary above form |
| `< 768px` | Compact current-step rail, single-column workbench, full-width actions |

- At 1024px, no short label or provider name wraps.
- At 390px, there is no document-level horizontal overflow.
- Route direction changes from horizontal to vertical only when endpoint columns
  stack.
- Geometry is measured on the complete regions users compare, not only nested
  buttons.

## Acceptance Test

A migration workflow implementation is acceptable only when all are true:

1. A screenshot is recognizable as a source-to-target migration workflow even
   with product copy blurred.
2. The page shows one primary workbench, not a stack of cards.
3. Source and target options share exact computed dimensions and state styling.
4. All six workflow positions remain understandable at desktop and mobile.
5. The primary action has one stable location throughout the flow.
6. Empty, selected, disabled, validation, unlocked, lock-and-archive, queued, and ready
   states preserve layout geometry.
7. Screenshots at 1280×800, 1024×768, and 390×844 pass visual review.
8. Browser measurements confirm no overflow, clipped text, or wrapped short
   labels.
