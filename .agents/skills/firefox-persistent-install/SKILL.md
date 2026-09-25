---
name: firefox-persistent-install
description: Prepare, sign, install, and verify a persistent Firefox build of Inference Bridge for local testing. Use whenever the user wants a packaged Firefox add-on to survive Firefox restarts, needs a signed XPI, asks how to get or install the AMO-signed file, or wants to distinguish this from `npm run dev:firefox`.
---

# Persistent Firefox install for Inference Bridge

Use this workflow when a user needs to test a Firefox extension that stays installed after Firefox quits. `npm run dev:firefox` is for the fast development loop; it runs a temporary extension in a temporary Firefox profile and does not verify a persistent install.

## Build the Firefox package

1. Check the working tree and current branch. Do not include uncommitted changes in an archive silently; tell the user whether the build will use committed code or ask them to commit/stash if the submission needs another source snapshot.
2. Run `npm run package:firefox`. The unsigned add-on ZIP is `dist/inference-bridge-firefox-<version>.zip`; its staged source root is `build/firefox/`.
3. If the package or source code changed, keep their source snapshots aligned. The source ZIP must correspond to the exact code used for the add-on ZIP. For a tagged release, prefer the `inference-bridge-firefox-source-<tag>.zip` reviewer source asset produced by `.github/workflows/release.yml`. For an unmerged branch without a release asset, first ensure the working tree is clean and the package was built from `HEAD`, then create a local reviewer archive with build instructions and tool versions:

   ```sh
   node --version > dist/firefox-build-info.txt
   npm --version >> dist/firefox-build-info.txt
   zip -v | head -2 >> dist/firefox-build-info.txt
   uname -srm >> dist/firefox-build-info.txt
   commit=$(git rev-parse --short HEAD)
   git archive --format=zip --add-file=dist/firefox-build-info.txt \
     --output "dist/inference-bridge-firefox-source-${commit}.zip" HEAD
   ```

   This is a local branch archive, not a published release artifact. If there are uncommitted source changes, do not archive `HEAD` and claim it matches; first make the source snapshot reproducible.
4. The Firefox package is built by `scripts/package.mjs`, which creates the Firefox manifest and stages the included files. AMO source submission is required. Include the repository source, lockfile, packaging scripts, and build instructions; do not upload the add-on ZIP as the source archive.

## Request Mozilla signing for self-distribution

1. Direct the user to the [AMO Developer Hub](https://addons.mozilla.org/en-US/developers/) and have them choose **Submit a New Add-on**.
2. For a private/personal persistent test install, choose **On your own**. Do not choose the public listing path unless the user asks to publish the add-on.
3. Upload the Firefox ZIP from `dist/`. On the source-code question, choose **Yes** and upload the matching source archive.
4. Submission enters **Signature Pending**. This is the signing queue, not a requirement to wait for public review approval. The user can continue using `npm run dev:firefox` for temporary testing while signing is pending.
5. When signing completes, go to **My Submissions**, open the version, and download the signed `.xpi` shown on its version page. The blue XPI filename is the download link. Do not install the unsigned ZIP for a persistent test in standard Firefox.

## Install and verify persistence

1. In the target Firefox profile, open `about:addons`, open the gear menu, and choose **Install Add-on From File**. Select the signed `.xpi`.
2. Make a recognizable change in Options, such as selecting a different default provider. If checking saved origin grants too, create an **Always allow** grant on a test page.
3. Quit Firefox fully (`Firefox → Quit Firefox`, or `⌘Q` on macOS), then reopen that same profile normally. Do not launch `npm run dev:firefox` for this check; it creates a temporary profile.
4. Verify the add-on remains enabled, the selected setting and optional site grant are present, and a test page can still call `window.inference` successfully.
5. Do not uninstall and reinstall as part of the restart check, because uninstalling may remove extension data. Closing and reopening Firefox is the persistence test.

## Explain what each path proves

- `npm run dev:firefox`: fast temporary development install; it packages `build/firefox/`, launches `web-ext run`, and uses a temporary profile. It is not a persistence or install-prompt test.
- Signed `.xpi` from AMO: persistent install in a regular Firefox profile; use this to verify settings and grants after a full browser restart.
- A signed self-distribution install is not a public AMO listing. Public distribution follows the separate listed submission/review path.

## Project references

- [Firefox AMO checklist](../../../docs/firefox-amo.md)
- `package.json` scripts: `package:firefox` and `dev:firefox`
- `.github/workflows/release.yml`: tagged release artifacts, including reviewer source ZIP
- Mozilla's [temporary install guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/) and [restart testing guide](https://extensionworkshop.com/documentation/develop/testing-persistent-and-restart-features/)
