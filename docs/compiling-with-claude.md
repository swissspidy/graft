# Compiling with Claude: a real run

The builds in [`examples/builds`](../examples/builds) are hand-written, so
the tests can run without a model. This page records what happened when
Claude compiled the same specs for real, with `graft compile` and the CLI's
default model, against WordPress 7.1 in Playground (October 2026).

## Results

Each of the seven WordPress example specs, compiled once:

| Spec | Checks | Code | Attempts (checks, tree) | Time |
| --- | --- | --- | --- | --- |
| [review-queue](../examples/specs/review-queue.md) | 6 | | 1, 1 | 71 s |
| [quick-approve](../examples/specs/quick-approve.md) | 6 | | 1, 1 | 77 s |
| [waiting-posts](../examples/specs/waiting-posts.md) | 6 | | 1, 1 | 68 s |
| [stale-drafts](../examples/specs/stale-drafts.md) | 8 | | 1, 1 | 96 s |
| [headline-check](../examples/specs/headline-check.md) | 6 | yes | 1, 1 | 91 s |
| [pending-by-author](../examples/specs/pending-by-author.md) | 7 | widget | 1, 1 | 113 s |
| [publish-checklist](../examples/specs/publish-checklist.md) | 15 | widget | 1, 1 | 168 s |

All seven verified on the first attempt. Each build then passed
`graft verify` again on its own: 54 checks.

These are single runs, and the model's output varies between runs. In
earlier runs (some before the fixes below), the compiler sometimes sent `stale-drafts`,
`headline-check` and `publish-checklist` back to their author instead
(see [Criteria it would not check](#criteria-it-would-not-check)).

## One compile, step by step

```sh
pnpm graft compile examples/specs/review-queue.md \
  --surface hosts/wordpress/plugin/surfaces/7.1.json --out review-queue.build.json
```

```
→ writing checks from the criteria (attempt 1)
→ building the tree (attempt 1)
✔ verification passed (attempt 1)
```

**Checks first.** Claude writes the checks from the
[spec](../examples/specs/review-queue.md)'s acceptance criteria before any
implementation exists. They're frozen from then on. In plain language, as an
administrator sees them at approval time:

- **pending-only:** Given an editor "eddie", a contributor "carol", a pending
  post "Pending One" by "carol", a draft post "Draft Two" by "carol", a
  published post "Published Three", a private post "Private Four", a
  scheduled post "Future Five" and a pending post "Pending Six", when
  "eddie" opens it, then the list shows exactly "Pending One" and "Pending
  Six".
- **columns:** Given an editor "eddie", a contributor "carol" and a pending
  post "Pending One" by "carol", when "eddie" opens it, then the columns are
  "Title", "Author" and "Submitted date", the "Author" cell on "Pending One"
  shows "Carol Writer" and the "Title" cell on "Pending One" shows "Pending
  One".
- **approve:** Given an editor "eddie", a contributor "carol", a pending post
  "Pending One" by "carol" and a pending post "Pending Two" by "carol", when
  "eddie" opens it, and uses "approve" on "Pending One", then the post
  "Pending One" is published, the post "Pending Two" is pending and the list
  shows exactly "Pending Two".
- **contributors-no-approve:** Given an editor "eddie", a contributor "carol"
  and a pending post "Carol Pending" by "carol", when "carol" opens it, then
  the list shows exactly "Carol Pending", "approve" on "Carol Pending" is not
  available and the post "Carol Pending" is pending. A second check opens the
  same page as "eddie" and expects "approve" to be available, so a build that
  hides the button from everyone fails.
- **empty-state:** Given an editor "eddie", a draft post "Draft Only" and a
  published post "Published Only", when "eddie" opens it, then the list is
  empty and the page says "Nothing to review".

These are stricter than the
[hand-written checks](../examples/builds/review-queue.json). They include
posts that must *not* show up (draft, published, private, scheduled), check
that approving one post leaves the others alone, and back the
"contributors can't approve" check with one showing that editors can.

**Then the tree.** Claude builds the tree against the frozen checks. Here,
the build is a table bound to `posts.list` with `status: ["pending"]`, an
"Approve" action calling `posts.update_status` and removing the row, and
"Nothing to review" as its empty state. The verifier runs every check in a
throwaway WordPress, through real ability calls, before the build is saved.

## When the host changes

The canary's `change-list-input` scenario changes `posts.list` to take
`statuses` instead of `status`, with no migration that describes the
change. Every build that lists posts has to be regenerated against its
frozen checks:

```sh
pnpm graft canary --corpus fixtures/canary/tenants \
  --from hosts/wordpress/plugin/surfaces/7.1.json --scenario change-list-input --regenerate
```

```
Canary: 7.1.2 → 7.1.3+change-list-input

agency / editorial-inbox      regenerated     capability posts.list changed
campus-blog / review-queue    regenerated     capability posts.list changed
daily-news / quick-approve    survived        nothing it uses changed
daily-news / review-queue     regenerated     capability posts.list changed  (shared)
newsdesk / headline-check     regenerated     capability posts.list changed
newsdesk / pending-by-author  regenerated     capability posts.list changed
newsdesk / publish-checklist  survived        nothing it uses changed
solo / quick-approve          survived        nothing it uses changed  (shared)

survived: 3, migrated: 0, re-anchored: 0, regenerated: 5, needs approval: 0, failed: 0
8 customizations, 6 distinct upgrade runs
```

The whole run took under four minutes, for five tenants. Identical
customizations share one upgrade run. All five regenerated builds pass
`statuses`, and the headline check's code was rewritten along with its
tree, against the same frozen checks.

## Criteria it would not check

When a criterion can't be checked objectively, the compiler stops and says
why instead of writing a weak check. In one run of
[headline-check](../examples/specs/headline-check.md):

```
✖ checks attempt 1 rejected:
    Criterion "warning" cannot be checked: The spec does not name the column
    that holds the verdict, so a check cannot target the cell whose warning
    tone it should read; name that column (e.g. "Headline") so the warning
    mark on problems can be checked.
```

Changing the criterion to "Every problem is listed in the "Headline" column,
marked as a warning" was enough for that spec to compile and verify on the
first attempt.

## What the first runs found

Before the run above, only one of the seven specs compiled. Most failures
were checks that no tree could satisfy. Since checks are frozen, retrying
the tree could never fix them:

- `{"text": ...}` promised "shown somewhere", but the verifier only saw row
  titles. It missed other cells (a post's author) and the labels of buttons
  and row actions.
- The guide never said that pages show users by display name, so checks
  expected aliases such as "alice".
- The prompt didn't say that `rows` reads the first table and `columns` is
  the whole list, or how to tell apart widget buttons outside a table.
- Widget code passed `children` to components that take none, and the
  error didn't say how to fix it.
- A check that views the page as a user missing from its fixtures was only
  caught at verification time, after every tree attempt had failed.

The verifier, prompt and guide now cover all five. The hand-written
builds, the agency and EmDash examples, and the scripted compile tests
pass unchanged.

## Reproduce it

Set `ANTHROPIC_API_KEY`, then:

```sh
pnpm install
for spec in examples/specs/*.md; do
  pnpm graft compile "$spec" --surface hosts/wordpress/plugin/surfaces/7.1.json \
    --out "$(basename "$spec" .md).build.json"
done
```

`--model` picks another Claude model and `--attempts` changes the retry
budget (3 by default). A passing compile also writes
`<name>.build.verification.json` with the result of every check.
