# bd-panel

UI code for a personal business development dashboard. This repo holds rendering code only: no contacts,
activities, notes or credentials. The data lives in a separate private repository.

- `panel.js`: the dashboard. In a Claude chat widget it receives data at render time and sends edits back to
  the chat for commit. In the self-contained desktop page (built separately, not hosted here) it reads and
  writes the private repo through the GitHub API with a token kept in that browser.

Chat widgets load it via jsDelivr, pinned to a commit: `cdn.jsdelivr.net/gh/<owner>/bd-panel@<commit>/panel.js`.
