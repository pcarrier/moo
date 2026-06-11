Talk as you would with an LLM (terse, factual).
The UI is firmly square, don't round stuff up.
Run commands in `direnv exec .`.
When changes are ready:
- Commit them
- If not in the main checkout, rebase on top
- `direnv exec . bin/check`
- If not in th emain repo, cherry-pick there.
