# Safari development

The Safari development build covers installation, site access, and the page bridge. Website requests that require approval open a Safari tab where you can review the request and choose a provider and model. The package uses the same page injection, relay, and background worker as Chrome.

The manifest floor is Safari 18 on macOS and iOS/iPadOS 18, based on support for static content scripts in the page's `MAIN` world. Safari 27.2 on macOS 27.2.1 is the first verified desktop combination. Start device testing on iOS/iPadOS 27.2, then test older versions before publishing a support minimum. [Content script compatibility data](https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/content_scripts.json)

## Build

```bash
npm ci
npm run package:safari
```

The unpacked extension is in `build/safari/`. The ZIP is `dist/inference-bridge-safari-<version>.zip` and contains the same resources at its root. `npm run package:all` builds Safari along with Chrome and Firefox.

## Install on an iPhone or iPad

Use full Xcode with an SDK and device support for the OS you are testing. After installing the npm dependencies, run this from the repository root. Set `DEVELOPER_DIR` to your Xcode developer directory to use a specific installation. [Apple’s packager reference](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)

```bash
npm run prepare:safari:ios
```

The command builds the Safari extension, creates the local Xcode project in `build/safari-xcode/` the first time, and refreshes the setup screen and app icon. Open the Xcode project at the path the command prints.

1. Select the project in Xcode’s navigator, then open **Signing & Capabilities** for each target. Set **Bundle Identifier** to `io.github.samsamskies.inferencebridge.safaritest` for **Inference Bridge** and `io.github.samsamskies.inferencebridge.safaritest.Extension` for **Inference Bridge Extension**. The packager can derive a different ID for the app, so check both fields.
2. If **Team** shows **Add Account…**, sign in to your Apple Account. Select the same development team for both targets and keep **Automatically manage signing** enabled. Check that both deployment targets allow the device’s iOS/iPadOS version. [Apple’s device signing guide](https://developer.apple.com/documentation/xcode/building-and-running-an-app)
3. Select the iOS app scheme and the attached device. Enable Developer Mode if prompted, then run the app from Xcode. You can use an iOS simulator for an initial check.
4. On the device, open **Settings → Apps → Safari → Extensions → Inference Bridge** and enable it. Check the active Safari profile if you use profiles. [Apple’s run and install guide](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)

To opt in to access across sites on iOS, choose **Permissions → Other Websites → Allow** on the same Settings screen. Safari applies this as the default for sites with no specific setting. Each new site still needs approval in Bridge before making inference requests. For the per-site smoke test below, leave **Other Websites** set to **Ask**. [Apple’s Safari permissions guide](https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions)

For later builds, rerun `npm run prepare:safari:ios`. That rebuilds `build/safari/`, syncs any **copied** extension `Resources` folders inside the existing Xcode wrapper (when the packager used `--copy-resources` or left a local manifest tree), and refreshes the setup screen and its `ViewController.swift` from `safari/ios-app/`. If the project only **references** `build/safari/` (packager default without `--copy-resources`), Xcode already picks up the rebuilt package with no extra copy. The command **does not** re-run `safari-web-extension-packager` when `build/safari-xcode/` already exists, so signing and project settings are preserved. To regenerate the Xcode wrapper from scratch (new packager defaults, broken project, or a clean tree), delete `build/safari-xcode/` and run `npm run prepare:safari:ios` again.

With an Apple Developer Program membership, App Store Connect’s Safari Web Extension Packager can build the extension ZIP for TestFlight without local Xcode. Use `io.github.samsamskies.inferencebridge` as the bundle ID for the TestFlight and App Store app record. In **Users and Access → Xcode Cloud → Safari Web Extension Packager**, upload the ZIP to that app record with iOS enabled. The custom setup screen is part of the generated app, so a build that includes it uses the Xcode project. [App Store Connect packager guide](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect)

For the Xcode archive workflow used to ship the custom setup screen through TestFlight and submit to the App Store, see [ship-safari-ios-release](../.agents/skills/ship-safari-ios-release/SKILL.md).

## Install temporarily on macOS

1. In **Safari → Settings → Advanced**, enable **Show features for web developers** if needed.
2. In **Safari → Settings → Developer**, choose **Add Temporary Extension…**, authenticate if prompted, and select `build/safari/`.
3. In **Extensions**, confirm Inference Bridge is enabled. Safari’s **Settings** button in that pane opens the extension’s Options page. Use **Reload** after rebuilding and **Uninstall** when finished. [Apple’s temporary installation guide](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension#Temporarily-install-a-web-extension-folder-in-macOS-Safari)

Use **Open Chat** in Bridge Options to open the extension’s chat in a Safari tab.

## Smoke-test page access and the worker

1. Open `https://example.com/` in Safari. In the page’s Web Inspector console, `typeof window.inference` should be `"undefined"` before site access is granted. For iPhone or iPad, enable **Web Inspector** in Safari’s Advanced settings and open the device’s page from the Mac Safari **Develop** menu. [Apple’s Web Inspector guide](https://developer.apple.com/documentation/safariservices/troubleshooting-your-safari-web-extension)
2. On iPhone or iPad, tap the **Page Menu** beside the address bar and choose **Inference Bridge**. If needed, turn it on under **Manage Extensions** first. Grant access to example.com only and reload the page. Safari site access allows injection. Bridge approval for inference is a separate step. On macOS, grant site access from the extension’s toolbar button. [Apple’s Safari permissions guide](https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions)
3. In the page’s Web Inspector console, run the probe. It exercises both content scripts and the background port without using a provider or API key.

```js
(async () => {
  console.log(typeof window.inference?.request, typeof window.inference?.getFeatures);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    for await (const chunk of window.inference.request({
      method: "chat",
      messages: [],
      signal: controller.signal,
    })) {
      console.log("Unexpected chunk", chunk);
    }
  } catch (error) {
    console.log(error.code, error.message);
  } finally {
    clearTimeout(timeout);
  }
})();
```

Expect `function function` followed by `invalid_request messages must be a non-empty array.` Report the device, OS version, and console output if either check differs. To verify revocation, deny website access in Safari and reload. The page API should disappear.

## Smoke-test a website approval

1. Configure a hosted provider in Bridge Options. Open a chat example from the [IPA examples gallery](https://samsamskies.github.io/inference-provider-api/) and grant it site access in Safari.
2. Send a short message. The approval tab should show the requesting site, the provider and model selectors, and the request preview within a few seconds (not a lasting “expired” state). Choose **Allow** with **Remember for this site** unchecked to approve only this request. Safari should close the approval tab and return to the chat with the response.
3. Send another message and choose **Deny**. The approval tab should close and the chat should report `permission_denied`. Closing the approval tab without a decision, navigating that tab away from the approval page, or letting the two-minute Safari timeout fire also denies with `permission_denied` and closes the approval tab. If instead the **requesting** site tab navigates or closes while approval is open, the page should see `aborted` (for example “Tab navigated” / “Tab closed”), not `permission_denied` — that path cancels the request, it is not a user Deny.
4. Try **Remember for this site** with **Allow**, then send another message from the same site. Confirm the saved route is used. Revoke the grant in **Options → Site access** and confirm the next request opens an approval tab again.

## Compatibility checks

| Area | Result or device check |
| --- | --- |
| MV3, static injection, and runtime ports | Safari 27.2 on macOS loaded the temporary extension. The API appeared only after a site grant and reload. The invalid request made the full trip to the worker and back. Repeat on iPhone and iPad, including revocation. |
| Storage and Web Locks | On macOS Safari 27.2 the worker could acquire a Web Lock and read extension storage. Verify cross-context locking, settings persistence and quota behavior on device. |
| Mobile approvals | Safari uses an approval tab because iOS lacks window creation, update and removal. On iOS 27.2 Simulator, the provider/model picker opened, and Deny closed the approval tab and returned `permission_denied`. Repeat on a **physical** iPhone and iPad: Allow/Deny must work. The approval page polls for the pending request for the full two-minute prompt window while `tabId` binds. If the tab opens but the UI stays on “expired” for the whole window, WebKit may be omitting `sender.tab` on extension-page messages (approval trust requires `tab.id`). That is a device/WebKit gate, not something to weaken in unit tests. Also verify remembered grants, revocation and operation-specific approvals. [Apple’s extension compatibility guide](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility) |
| Streaming and lifecycle | Verify chunk delivery, cancellation, navigation, tab close, app switching, and worker suspension. Opening the worker inspector can affect its lifetime, so repeat with it closed. Error-code split: dismissing or navigating the **approval** tab → `permission_denied`; navigating or closing the **requesting** tab during approval → `aborted`. A requesting-tab `status: "loading"` aborts the stream on purpose (content-script teardown); if an SPA soft navigation reports `loading` without destroying the relay, the stream can false-abort — confirm on device with in-page routing if that matters for a site under test. |
| Hosted providers | On iOS 27.2 Simulator, a one-time approval returned a live response from Gemini 3.1 Flash Lite. Repeat on a physical iPhone and test OpenAI, Anthropic, OpenRouter, PayPerQ, Ollama Cloud and an HTTPS custom endpoint. Check Safari’s host grants, provider CORS behavior and revocation. Revoking any optional host origin in Safari Settings aborts **all** in-flight Bridge streams (every tab), not only streams for that provider — intentional fail-closed behavior shared with Firefox. |
| Local and browser-specific features | The Safari manifest omits the Ollama header-rule permission, localhost host grant, side panel and offscreen permission. Optional host permissions are **HTTPS-only** (`https://*/*`); HTTP and loopback custom OpenAI-compatible endpoints cannot be granted and fail when you save the server or choose Allow. Validate feature gating with the approval flow. On an iPhone, localhost points to the phone. |
| Settings and distribution | The iOS app showed the setup screen on Simulator, and the shared Options page opened through macOS Safari Settings. Verify that first-time users can enable Bridge and grant site access, then check toolbar access, touch layouts, keyboard and dark mode on iPhone and iPad. Validate signing, TestFlight and App Store privacy disclosures before distribution. |
