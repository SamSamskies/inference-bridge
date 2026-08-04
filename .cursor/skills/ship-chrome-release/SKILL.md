---
name: ship-chrome-release
description: >-
  Prep and ship an Inference Bridge Chrome Web Store release: bump version,
  test, package ZIP, tag, GitHub Release, and store submission checklist. Use
  when the user asks to release, ship, publish, bump version, package for the
  Chrome Web Store, create a store upload, or cut a new extension version.
---

# Ship Chrome Web Store release

Follow [`docs/chrome-web-store.md`](docs/chrome-web-store.md) (repo root) as the source of truth for listing copy, permission justifications, and store questionnaire details.

## Workflow

Copy and track:

```
Release progress:
- [ ] 1. Confirm main is clean and includes intended changes
- [ ] 2. Choose and bump version
- [ ] 3. npm ci && npm test && npm run package
- [ ] 4. Inspect ZIP contents
- [ ] 5. Commit version bump
- [ ] 6. Tag vX.Y.Z and push tag (triggers release workflow artifact)
- [ ] 7. Create GitHub Release with notes
- [ ] 8. Hand off store upload checklist to user
```

### 1. Confirm branch state

- On `main`, clean working tree, up to date with `origin/main`.
- Summarize commits since the previous `v*` tag (`git log vPREV..HEAD --oneline`).
- Do not include uncommitted WIP unless the user asks.

### 2. Version bump

Chrome Web Store requires a **strictly higher** `manifest.json` `"version"` than any previously uploaded package.

1. Bump `"version"` in `manifest.json`.
2. Keep `package.json` `"version"` aligned.
3. Choose semver for this repo:
   - **patch** (`0.1.1` → `0.1.2`): fixes, permission/doc tweaks, no user-facing feature
   - **minor** (`0.1.x` → `0.2.0`): new provider or user-facing capability
   - **major**: breaking behavior users must notice

Tag format: `vX.Y.Z` (must match manifest version).

### 3. Test and package

```bash
npm ci
npm test
npm run package
```

Output: `dist/inference-bridge-<version>.zip`

### 4. Inspect ZIP

```bash
unzip -l dist/inference-bridge-<version>.zip
```

Allowlist only: `manifest.json`, `background/`, `content/`, `src/`, `ui/`, `icons/`.

Reject the package if tests, docs, `node_modules`, `.git`, secrets, or unrelated files appear.

### 5. Commit

Commit the version bump (and any intentional release-doc updates) with a message like:

```
Bump version to X.Y.Z
```

Only commit when preparing the release (or when the user asked). Do not commit `dist/*.zip` (build artifact).

### 6. Tag and push

```bash
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

Pushing `v*` runs `.github/workflows/release.yml`, which uploads the ZIP as a CI artifact. It does **not** submit to the Chrome Web Store.

### 7. GitHub Release

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes "$(cat <<'EOF'
## What's new
- …

## Chrome Web Store
Upload `dist/inference-bridge-X.Y.Z.zip` (or the release workflow artifact).
EOF
)" \
  dist/inference-bridge-X.Y.Z.zip
```

Attach the local ZIP so the release is downloadable without digging through Actions.

### 8. Store handoff

Give the user:

1. Path to `dist/inference-bridge-<version>.zip`
2. Reminder to open [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
3. Pasteables from `docs/chrome-web-store.md`: permission justifications, privacy disclosures
4. Asset check: screenshots in `dist/store-screenshots/` — **re-capture Options/approval if UI changed** this release
5. After publish: update README Installation with the store URL

Do not store or request Chrome Web Store API credentials. Submission stays manual.

## Out of scope

- Auto-upload/publish to the store
- Generating promotional graphics in CI
- Fabricating screenshots
