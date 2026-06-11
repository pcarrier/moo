Talk as you would with an LLM (terse, factual).
The UI is firmly square, don't round stuff up.
Run commands in `direnv exec .`; Git hooks keep worktree direnv trust current.
When changes are ready, commit them in scratch, rebase on main repo, `direnv exec . bin/check` in scratch, then cherry-pick from main repo.
