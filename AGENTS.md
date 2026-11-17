# Notes for contributors and coding agents

## Issue-first development

Before changing product code, tests, configuration, or docs for a development task:

1. Create or identify a GitHub Issue in https://github.com/yang0/handraw-client describing the request or bug, intended behavior, and acceptance criteria. Split broad work into focused Issues and cross-link them.
2. Only after the Issue exists, implement the change.
3. Reference the Issue number in commit messages (`feat: ... (#12)`). Update the Issue with commits, tests actually run, and any manual verification still outstanding.
4. Do not close an Issue based only on a commit or a source-text assertion. Verify the real interaction and layout on Windows and macOS where applicable, and say what could not be verified.
5. Changes that need handraw-web or handraw-style get their own Issue in that repository, linked both ways.

## Security

- This repository is public. Never commit credentials, server passwords, API keys, user data, or private website code.
- `需求.md` and `.local/` are ignored for that reason.

## Design reference

- Product: `docs/product.md`. Architecture follows Magpie (Go + Wails v3 + system WebView + plugin runtime); see section 5.
- Visual: warm paper, ink typography, vermilion actions; images are the focus. Honor reduced motion.
