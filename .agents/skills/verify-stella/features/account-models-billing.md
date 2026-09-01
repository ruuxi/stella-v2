# Account, models, and billing

The top-bar account and model controls expose authentication state, execution target, provider/model choice, usage, subscription, and billing entry points.

## Sub-features

- `account-menu` changes between signed-out and signed-in identity states.
- `execution-target` selects the available local or cloud execution environment.
- `model-picker` selects a provider/model compatible with the target.
- `usage-billing` opens usage, subscription, upgrade, and checkout surfaces.
- `connectors-feedback` reaches connected services and feedback destinations.

## How to get to it (user POV)

- Choose the signed-in account control or signed-out Settings/identity entry in the top bar.
- Choose the global execution-target or model control when visible.
- Open usage, plan, billing, Connectors, or feedback from account/settings destinations.

## Driving it with control-stella

Preconditions:

- The verifier is healthy. Signed-in, paid, and provider states require an isolated test account or explicit existing fixture.
- Never reuse or expose the developer's production credentials.

- **Discover state.** Run `inspect components` and `inspect state`; record whether account, target, and model controls are present.
- **Account menu.** Open the visible identity control with `drive click` and assert the menu items appropriate to signed-in or signed-out state.
- **Target/model.** Select a visible option, close the menu, and read the selected label back from the control.
- **Usage/billing.** Open the destination and require its route/dialog heading. Stop before paid checkout unless completing it is explicitly in scope.
- **Adjacent destinations.** Open Connectors or feedback from the visible menu and capture the resulting route/dialog.

## Gotchas

- Control visibility changes with right-side surfaces, Quick chat, account state, and platform capability.
- Model lists are scoped by provider and execution target. An absent model may be correctly filtered.
- Billing and checkout are external side effects. Do not purchase, subscribe, or submit payment without explicit authorization.
- A signed-out verifier can prove menus and blocked states but not authenticated account mutations.
