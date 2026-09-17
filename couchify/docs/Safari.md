# Safari Web Extension conversion

Safari accepts the same WebExtension source, but conversion/packaging must run
on macOS with Xcode. There is nothing to automate from this Linux repo.

## On a Mac (one-time)

```bash
git clone <this repo> && cd video-sunc/couchify
npm install && npm run build   # produces dist/

cd /tmp
xcrun safari-web-extension-converter --project-location ~/couchify-safari \
  --bundle-identifier fr.dubujordan.couchify --app-name Couchify \
  --no-open <path-to>/video-sunc/couchify/dist
```

Notes:
- The bundled Chromium-style `background` service worker is not used by Safari;
  add `"scripts": ["lib/compat.js", "background/worker.js"]` under
  `background` in the converted manifest (matches what the Firefox manifest
  does here).
- `data_collection_permissions` under `gecko` is Firefox-specific — remove the
  whole `browser_specific_settings` block for Safari.
- Open the generated Xcode project, set signing, Product ▸ Archive, then
  upload to App Store Connect as a macOS app. Safari Web Extensions can also
  be distributed outside the store with a signed developer ID app.

Reference: https://developer.apple.com/documentation/safariservices/safari-web-extensions/converting-a-web-extension-for-safari