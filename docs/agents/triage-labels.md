# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Repo-specific labels

- `tracking` — sixth state, applied by `/to-tickets` to a parent spec after it is split into child tickets. Not grabbable by `/next`; closes when all children close.
- `in-progress` — seventh state, an agent is implementing this issue right now; applied by `/implement` when it starts. Not grabbable by `/next`, which prints it as a one-line status instead so a stalled one stays visible. The PR's `Closes #N` closes the issue on merge; the maintenance workflow then strips the label.
- `p0`–`p3` — priority, orthogonal to the state labels. `p0` = critical (rare), `p1` = high, `p2` = normal (the default; an unlabeled issue sorts as `p2`), `p3` = low. Assigned when a grill or `/triage` settles that an issue stays open. `/next` picks highest priority first, oldest within a priority.
