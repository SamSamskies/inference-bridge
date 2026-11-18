# Safari development

The first Safari milestone covers installation, site access, and the page bridge. Mobile approval and provider requests are subsequent milestones. The package uses the same page injection, relay, and background worker as Chrome.

The manifest floor is Safari 18 on macOS and iOS/iPadOS 18, based on support for static content scripts in the page's `MAIN` world. Safari 27.2 on macOS 27.2.1 is the first verified desktop combination. Start device testing on iOS/iPadOS 27.2, then test older versions before publishing a support minimum. [Content script compatibility data](https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/content_scripts.json)

## Build

```bash
npm ci
npm run package:safari
```

The unpacked extension is in `build/safari/`. The ZIP is `dist/inference-bridge-safari-<version>.zip` and contains the same resources at its root. `npm run package:all` builds Safari along with Chrome and Firefox.

## Install on an iPhone or iPad

Use full Xcode with an SDK and device support for the OS you are testing. Select Xcode as the active developer directory if `xcrun` only sees the standalone Command Line Tools. From the repository root, generate a Swift wrapper with Apple’s packager. Replace the example bundle identifier with one you can sign. [Apple’s packager reference](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)

```bash
xcrun safari-web-extension-packager "$PWD/build/safari" \
  --ios-only --swift --app-name "Inference Bridge" \
  --bundle-identifier "com.example.inferencebridge.safaritest" \
  --project-location "$PWD/build/safari-xcode" --no-prompt
```

1. In the generated Xcode project, select your signing team for both the app and extension targets. Check that both deployment targets allow the device’s iOS/iPadOS version.
2. Select the iOS app scheme and the attached device. Enable Developer Mode if prompted, then run the app from Xcode. You can use an iOS simulator for an initial check.
3. On the device, open **Settings → Apps → Safari → Extensions → Inference Bridge** and enable it. Check the active Safari profile if you use profiles. [Apple’s run and install guide](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)

The generated project references `build/safari/`. For later slices, rerun `npm run package:safari`, then build and run the same Xcode project.

With an Apple Developer Program membership, App Store Connect’s Safari Web Extension Packager can build the ZIP for TestFlight without local Xcode. In **Users and Access → Xcode Cloud → Safari Web Extension Packager**, upload the ZIP to an app record with iOS enabled. This route still needs a signed build to be processed before it can be installed. [App Store Connect packager guide](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect)

## Install temporarily on macOS

1. In **Safari → Settings → Advanced**, enable **Show features for web developers** if needed.
2. In **Safari → Settings → Developer**, choose **Add Temporary Extension…**, authenticate if prompted, and select `build/safari/`.
3. In **Extensions**, confirm Inference Bridge is enabled. Safari’s **Settings** button in that pane opens the extension’s Options page. Use **Reload** after rebuilding and **Uninstall** when finished. [Apple’s temporary installation guide](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension#Temporarily-install-a-web-extension-folder-in-macOS-Safari)

## Smoke-test page access and the worker

1. Open `https://example.com/` in Safari. In the page’s Web Inspector console, `typeof window.inference` should be `"undefined"` before site access is granted. For iPhone or iPad, enable **Web Inspector** in Safari’s Advanced settings and open the device’s page from the Mac Safari **Develop** menu. [Apple’s Web Inspector guide](https://developer.apple.com/documentation/safariservices/troubleshooting-your-safari-web-extension)
2. Grant Inference Bridge access to example.com only using Safari’s extension menu and reload the page. Safari site access allows injection. Bridge approval for inference is a separate step.
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

## Compatibility checks

| Area | Result or device check |
| --- | --- |
| MV3, static injection, and runtime ports | Safari 27.2 on macOS loaded the temporary extension. The API appeared only after a site grant and reload. The invalid request made the full trip to the worker and back. Repeat on iPhone and iPad, including revocation. |
| Storage and Web Locks | On macOS Safari 27.2 the worker could acquire a Web Lock and read extension storage. Verify cross-context locking, settings persistence and quota behavior on device. |
| Mobile approvals | iOS lacks window creation, update and removal. Verify a Safari approval tab preserves exact-origin and operation scoping, denial, prompt closure, cancellation, timeout and revocation. [Apple’s extension compatibility guide](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility) |
| Streaming and lifecycle | Verify chunk delivery, cancellation, navigation, tab close, app switching, and worker suspension. Opening the worker inspector can affect its lifetime, so repeat with it closed. |
| Hosted providers | Test real requests with OpenAI, Anthropic, Gemini, OpenRouter, PayPerQ, Ollama Cloud and an HTTPS custom endpoint. Check Safari’s host grants, provider CORS behavior and revocation. |
| Local and browser-specific features | The Safari manifest omits the Ollama header-rule permission, localhost host grant, side panel and offscreen permission. Validate feature gating with the approval flow. On an iPhone, localhost points to the phone. |
| Settings and distribution | The shared Options page opened through macOS Safari Settings. Verify access from the toolbar, touch layouts, keyboard and dark mode on iPhone and iPad. Validate signing, TestFlight and App Store privacy disclosures before distribution. |
