---
name: stella-design
description: Improve frontend UI quality in user-owned apps, sites, dashboards, and tools through intentional layout, typography, theming, interaction states, responsive behavior, and visual polish.
---

# Stella Design

Use this when designing or changing a frontend surface in a user-owned project.
It provides design guidance only; it does not modify the installed Stella app,
its runtime, or its bundled interface.

## First Move

Before editing UI:

1. Identify the surface:
   - **Product UI**: tools, dashboards, editors, forms, settings, and operational
     screens. Use [product-ui.md](reference/product-ui.md).
   - **Brand surface**: landing pages, portfolios, marketing, showcases, games,
     and image-led experiences. Use
     [brand-surface.md](reference/brand-surface.md).
2. Read the nearby project code before inventing a pattern. Reuse its tokens,
   shared components, icon family, button language, and route structure.
3. Write one sentence for the usage scene: who is using this, where, with what
   urgency, and in what state of mind. Let that choose density, contrast,
   motion, and theme.
4. Confirm which project files the user authorized before making changes.

## References

Pick the smallest set that fits the task:

- [visual-principles.md](reference/visual-principles.md) — color, typography,
  layout, motion, copy, and anti-slop checks.
- [typography-layout.md](reference/typography-layout.md) — type hierarchy,
  spacing rhythm, alignment, grids, density, and visual structure.
- [interaction-states.md](reference/interaction-states.md) — controls, forms,
  menus, dialogs, empty/error/loading states, and accessibility.
- [responsive-motion.md](reference/responsive-motion.md) — viewport behavior,
  touch targets, animation, transitions, reduced motion, and performance.
- [product-ui.md](reference/product-ui.md) — task-focused interfaces, controls,
  states, density, settings, and dashboards.
- [brand-surface.md](reference/brand-surface.md) — landing pages, portfolios,
  marketing, showcases, and visual-first apps.
- [quality-pass.md](reference/quality-pass.md) — audit and polish checklist
  before declaring UI work complete.

## Defaults

- Prefer quiet, useful UI. Let the task lead. Do not fill empty space with
  repeated cards, badges, dots, gradients, or decorative motion.
- Use the project's theme tokens and CSS variables instead of hard-coded
  colors when the interface supports multiple themes.
- Use the established icon set and component vocabulary. Do not mix icon
  families or invent a different button language for one screen.
- Use the available canvas. Avoid tiny centered, modal-like pages inside a
  large application surface.
- Use human copy. Avoid exposed implementation jargon, decorative wording that
  repeats the heading, and vague labels.

## Build Bar

A frontend change is not done until it works as an interface, not only as a
static screenshot:

- Cover default, hover, focus-visible, active, disabled, loading, empty, error,
  and long-content states when relevant.
- Provide keyboard paths and accessible names for controls.
- Make text fit on narrow and wide viewports without overlap.
- Use motion to communicate state and respect reduced motion.
- Keep the surface coherent with the project's existing design system.
- Run the project's own focused typecheck, tests, and build validation.
- Inspect the result at its normal size and at a narrow viewport when possible.

For games, studios, editors, dashboards, galleries, and creative tools, make
the working surface feel complete immediately. Do not ship a marketing page
that merely explains the intended app.

## Attribution

This skill adapts selected ideas from the Apache-2.0 Impeccable design skill by
Paul Bakaus.
