---
name: ship-firefox-release
description: >-
  Prepare and ship an Inference Bridge Firefox release through Mozilla AMO:
  bump the shared version, build and inspect the Firefox package and reviewer
  source archive, submit a listed version, and update release docs. Use whenever
  the user asks to release, publish, submit, update, or hotfix the Firefox
  add-on, or asks to ship a browser release that includes Firefox. For a local
  persistent test install without a public listing, use firefox-persistent-install.
---

# Ship an Inference Bridge Firefox release

Follow [`docs/firefox-amo.md`](../../../docs/firefox-amo.md) for Firefox packaging, privacy disclosures, AMO listing copy, reviewer notes, and the manual acceptance checklist. For a release that includes Chrome too, coordinate the version and build with [ship-chrome-release](../ship-chrome-release/SKILL.md).

## Choose the Firefox distribution path

- **Public release:** submit on AMO as **On this site**. This is the normal release path and enables Firefox to distribute updates to listed users.
- **Local or limited beta install:** use **On your own** for Mozilla signing, without a public AMO listing. Follow [firefox-persistent-install](../firefox-persistent-install/SKILL.md); do not describe an unlisted signed XPI as a public release.
- **Existing add-on update:** open the existing AMO add-on and upload a new version there so its ID and history stay together. Do not create a second AMO add-on for an update. This also applies when the existing AMO record currently has only an **On your own** signed version; submit the public version under the same add-on record and choose **On this site** for the version's distribution channel when AMO offers that choice.

If the user's intended audience or distribution path is unclear, ask before submitting. Signing and public listing are separate outcomes.

## Shared version and branch

Inference Bridge has one version in `manifest.json` and `package.json`, shared by Chrome and Firefox.

1. For a normal release, work from a clean `main` that contains the intended Firefox code. Do not publish Firefox-only changes that are still on an unmerged branch unless the user explicitly wants a branch build.
2. Check the latest version already submitted to AMO. If Chrome is also a target, check the Chrome Web Store version too.
3. Choose one higher shared version that satisfies the version ordering for every store in this release. If the browser stores ship at different times, a package version can go to the second store later as long as it is newer than that store's latest version.
4. Bump `manifest.json` and `package.json` together. Use the repo's semver convention: patch for fixes; minor for user-facing capability; major for a breaking change. Tag it `vX.Y.Z` to match both files.

Do not select independent Firefox and Chrome versions. One tag produces version-aligned browser packages.

## Build and inspect

Run the project release checks and package both browser artifacts from the same source revision:

```bash
npm ci
npm test
npm run package:all
npm run lint:firefox
unzip -l dist/inference-bridge-firefox-<version>.zip
```

`npm run lint:firefox` stages the Firefox root and runs Mozilla `web-ext lint` with warnings treated as errors, except the documented Android warning. The Firefox ZIP is `dist/inference-bridge-firefox-<version>.zip`; `build/firefox/` is its staged root. Check the Firefox allowlist and manifest against `docs/firefox-amo.md`, and ensure the Chrome package is also present if this is a combined release. Never include `dist/*.zip` in a source commit.

Use the exact tagged source revision to provide the matching AMO reviewer archive. The `v*` workflow runs tests, packages both browsers, lints Firefox, and uploads three CI artifacts: Chrome ZIP, unsigned Firefox ZIP, and Firefox reviewer source ZIP. The source ZIP includes `git archive HEAD`, build instructions, lockfile, packaging scripts, and runner tool versions. Download the Firefox ZIP and source ZIP artifacts for AMO; do not substitute the Chrome ZIP or a source archive from another commit.

Before submission, compare the packaged manifest, Firefox install permission wording, privacy declaration, and listing claims with the actual Firefox build. Firefox targets desktop 140+; per project decision, pre-release QA covers the current Firefox release and skips installing an older Firefox 140 build. Address compatibility reports if users encounter them.

## Tag and GitHub Release

After preparing and committing the version bump and release notes:

```bash
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

The tag triggers `.github/workflows/release.yml`. It does not submit to AMO or the Chrome Web Store. Wait for CI to pass, then download the Firefox ZIP and reviewer source ZIP artifacts from that exact run. Create the GitHub Release from the tag and attach the browser ZIPs being released. Keep the Firefox source archive available for AMO's source-code upload; it may be attached to the GitHub Release as a reviewer artifact if useful.

## Submit a new public AMO version

Use the AMO Developer Hub: <https://addons.mozilla.org/en-US/developers/>.

1. If no AMO add-on record exists yet, choose **Submit a New Add-on** and select **On this site**. If there is already an AMO record, open it and submit a new version there. For a record created by an earlier self-distributed (**On your own**) version, use the same record and select **On this site** for the public version when AMO offers that choice.
2. Upload `inference-bridge-firefox-<version>.zip` from the matching tag workflow artifact.
3. For this project, answer **Yes** to the source-code question. The Firefox packaging script creates a Firefox-specific manifest and stages files. Upload the reviewer source ZIP from the same tag.
4. Complete metadata and review details from `docs/firefox-amo.md`: listing name, summary, description, MIT license, privacy policy URL, support site, categories, experimental status, pricing disclosure, screenshots, and reviewer notes. Provide test credentials only if a flow actually requires an account; never put real user keys in source or notes.
5. Compare the Firefox data-collection declaration in the manifest with the AMO privacy choices and the current Mozilla data taxonomy. The Firefox build does not expose speech or Chrome's On-device Prompt API; keep those out of the Firefox listing claims.
6. Submit the version. Monitor AMO for validation or reviewer feedback and fix only the issues requested. A signature-pending state means signing is in progress; a listed release may still be subject to manual review.

Mozilla requires reviewable source and build instructions when an add-on includes generated or transformed code. See [Source Code Submission](https://extensionworkshop.com/documentation/publish/source-code-submission/) and [Submitting an add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/).

## After AMO publishes

- Record the public AMO URL and add-on ID in `docs/firefox-amo.md`.
- Update README Installation with the AMO listing link.
- If Chrome shipped in the same release, complete the Chrome submission using [ship-chrome-release](../ship-chrome-release/SKILL.md) and update its store link separately.
- Keep signing credentials out of the repository. AMO submission remains a user-controlled dashboard step.

## Hotfixes

When AMO rejects a version or requests a code change, branch from the submitted/tagged version, apply the focused correction, and bump to a version higher than the submitted version. Keep Chrome and Firefox package versions aligned. Run the build checks above, create a new tag, and submit the new Firefox package through the existing AMO add-on entry. Do not reuse an uploaded version number.
