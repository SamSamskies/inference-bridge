---
name: ship-safari-ios-release
description: >-
  Prepare, archive, and ship Inference Bridge for iOS and iPadOS through
  TestFlight or the App Store. Use for Safari beta uploads, public App Store
  submissions, and replacement builds. For local device or simulator installs,
  use docs/safari.md.
---

# Ship Inference Bridge for iOS Safari

Use the existing [Inference Bridge app in App Store Connect](https://appstoreconnect.apple.com/apps/6836825154/testflight). The Xcode archive workflow was used for TestFlight builds 1 and 2 and includes Bridge's custom setup screen and app icon. Refer to the [Safari development guide](../../../docs/safari.md) for local installation and device checks.

## Choose the build and destination

1. Record the clean source commit to ship. Use the intended release revision for App Review or the requested branch revision for a beta. For an App Review submission, use the existing tested build when it contains the intended changes and is eligible. If a reviewer asks for a binary fix, start from the submitted source revision and build a new candidate with the focused change.
2. Read the Apple marketing version and latest uploaded build number in App Store Connect. For a new archive, choose the intended `MARKETING_VERSION` and an unused, higher `CURRENT_PROJECT_VERSION` in that version train. Keep both values aligned across the app and extension targets. The Apple version started at `1.0` and is tracked independently of the shared browser extension version in `manifest.json` and `package.json`. A Safari-only upload can use the existing browser extension version.
3. Match the requested destination. An upload, assignment to an internal TestFlight group, external beta review, and public App Review are separate actions in App Store Connect. Use the destination and audience authorized by the user. An ordinary App Store Connect upload can be assigned to an internal group and later selected for App Review. [Apple's internal testing guide](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)

## Prepare and archive

1. Run `npm ci`, `npm test`, and `npm run prepare:safari:ios` from the selected source revision. The prepare command refreshes the extension resources, setup screen, and icon in the existing wrapper while retaining its project and signing settings.
2. Check Release signing on both targets in `build/safari-xcode/Inference Bridge/Inference Bridge.xcodeproj`. Use the Apple Developer Program team that owns the app record and automatic signing. The production IDs are `io.github.samsamskies.inferencebridge` for the app and `io.github.samsamskies.inferencebridge.Extension` for the embedded extension. A freshly generated wrapper starts with development IDs, so configure both before archiving. Use [Apple's current upload requirements](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/) to select a supported Xcode and SDK.
3. Archive the **Inference Bridge** scheme for a generic iOS device in Xcode, or use the command below. Replace both example version values using App Store Connect. If `codesign` is waiting on a Keychain prompt, let the account holder approve access on the Mac and verify the archive completed before proceeding.

   ```bash
   app_version='1.0'
   build_number='3'
   archive_dir='build/safari-xcode/testflight'
   archive_path="$archive_dir/InferenceBridge-$app_version-$build_number.xcarchive"
   mkdir -p "$archive_dir"
   xcodebuild -project 'build/safari-xcode/Inference Bridge/Inference Bridge.xcodeproj' \
     -scheme 'Inference Bridge' -destination 'generic/platform=iOS' \
     -archivePath "$archive_path" -allowProvisioningUpdates \
     MARKETING_VERSION="$app_version" CURRENT_PROJECT_VERSION="$build_number" archive
   ```

4. Inspect the archive before upload. Under `Products/Applications/Inference Bridge.app`, check the app's `Info.plist`, the setup screen and icon, and `PlugIns/Inference Bridge Extension.appex`. Verify both bundle IDs and both version fields (`CFBundleShortVersionString`, `CFBundleVersion`), the intended iPhone/iPad support, and the browser extension version in the embedded `manifest.json`. Record the source commit, extension version, Apple version/build, and archive path together.

## Upload and verify TestFlight

1. Upload the verified archive through Xcode Organizer using App Store Connect distribution. The CLI equivalent used for the prior uploads was `xcodebuild -exportArchive` with `-archivePath`, `-exportPath`, `-exportOptionsPlist`, and `-allowProvisioningUpdates`. Its local export plist used `method=app-store-connect`, `destination=upload`, `signingStyle=automatic`, the owning `teamID`, and `manageAppVersionAndBuildNumber=false` to preserve the inspected build number. Use `testFlightInternalTestingOnly=false` when the build may go to external testers or App Review. In Organizer, choose the corresponding distribution options.
2. Wait for Apple to process the exact version and build. If delivery status is unclear, check App Store Connect before retrying the upload. For **Missing Compliance**, the account holder can complete the export compliance declaration in App Store Connect based on the build's actual use of encryption. Build 2 used `ITSAppUsesNonExemptEncryption=false` in the app's `Info.plist` after the owner confirmed the prior declaration and the encryption use was unchanged. Recheck the declaration when that use changes. [Apple's export compliance guide](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-export-compliance-information-for-beta-builds/)
3. For internal smoke testing, add the processed build manually to the existing **iPhone Smoke Test** group and verify the exact build shows **Testing**. For an authorized external beta, use the requested group and follow [Apple's external testing instructions](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/).
4. Report the version and build number the tester should install. On device, enable Bridge and run the [page access smoke test](../../../docs/safari.md#smoke-test-page-access-and-the-worker) and [website approval smoke test](../../../docs/safari.md#smoke-test-a-website-approval), including Deny and a live streamed reply after Allow. Record the device, OS, and observed results. For a public candidate, use the [compatibility checklist](../../../docs/safari.md#compatibility-checks) to track physical iPad coverage, the supported OS range, and provider behavior.

## Submit for public review

1. Prepare the iOS version in the existing app record. Review App Privacy, export compliance, listing metadata, and review notes against the actual build. Explain how to enable the extension, set up a provider, and exercise a website request. Capture the setup screen, Safari approval with provider/model selection, and a streaming reply for the listing as applicable. Verify the iPhone and iPad assets against [Apple's current screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).
2. Select the verified build and use the release option that matches the user's intent. Choose manual release if the request ends at App Review. Submit for App Review when authorized and verify the actual dashboard status. [Apple's build selection guide](https://developer.apple.com/help/app-store-connect/manage-builds/choose-a-build-to-submit/) · [Apple's submission guide](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app/)
3. If publication is in scope, verify approval and complete any manual release step. Confirm public availability before adding the verified App Store URL to the installation docs.
