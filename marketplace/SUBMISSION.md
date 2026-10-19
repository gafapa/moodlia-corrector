# Chrome Web Store submission kit — MoodlIA Corrector 0.1.65

Prepared 20 October 2026. This is a local submission candidate, not a published or store-approved release.

## Files to upload and copy

| Dashboard field | File |
| --- | --- |
| Extension package | `release/moodlia-corrector-0.1.65.zip` — upload this archive, not the entire submission-kit archive |
| Default name, summary, description | `marketplace/listings/en.json` |
| Localized listing text | `marketplace/listings/{es,fr,de,pt_BR,it,gl,ca}.json` |
| Store icon | `extension/icons/icon-128.png` (128 × 128 PNG) |
| Required promotional image | `marketplace/assets/promo-small-0.1.65.png` (440 × 280 RGB PNG) |
| Optional marquee | `marketplace/assets/promo-marquee-0.1.65.png` (1400 × 560 RGB PNG) |
| Default screenshots | `marketplace/screenshots/en-01-correction.png` and `en-02-settings.png` (1280 × 800 RGB PNG) |
| Spanish/German screenshots | Corresponding `es-*.png` / `de-*.png` files; other listing locales may use the English images |
| Privacy practices and permissions | `marketplace/dashboard-fields.md` |
| Public privacy-policy content | `marketplace/privacy-policy.md` or `privacy-policy.html` |
| Private review access and steps | `marketplace/reviewer-instructions.md` |
| Release notes | `CHANGELOG.md`, entry 0.1.65 |

The downloadable submission-kit ZIP groups these files under `upload`, `listings`, `images` and `documents`. Its `SHA256SUMS.txt` records every included file. Do not upload the kit itself as an extension.

## Publisher steps

1. Sign in at https://chrome.google.com/webstore/devconsole with the intended publisher account. Complete any registration, contact verification or account-security requirements shown there. This task does not access or change that account.
2. Create the item or update the existing item, and upload the extension ZIP from `upload`.
3. Copy the English listing fields, category Education, and verified homepage/support URLs from `dashboard-fields.md`. Add the seven optional localized listings. Product UI supports all eight locales independently of which store listings you add.
4. Upload the icon, small promotional image and two matching screenshots. The marquee is optional. The old unversioned promotional images in the repository depict an earlier concept and are deliberately excluded from this kit.
5. Use https://moodlia.com/privacy/corrector.html as the extension-specific privacy URL. Its public content was verified against the website project source on 20 October 2026. The general /privacy page remains available and links to both extension policies. Review the policy against the actual submitted behavior, and update its content without changing its permanent URL if behavior changes.
6. Complete Privacy practices using `dashboard-fields.md`. Declare handled content/personal data and the session API key; explain direct selected-provider transfer, broad required HTTPS access, optional HTTP host grants and HTTP encryption limits honestly. Confirm the dashboard certifications only after checking they match your publisher's practice.
7. Fill the private reviewer instructions with a dedicated, reachable non-production Moodle teacher account and a usable AI endpoint/model or restricted review key. Keep those services available through review. No hosted review environment or credentials are provisioned by this kit, and no secrets should be committed or placed in public descriptions.
8. Choose visibility, countries and any dashboard-specific settings, then submit for review. Review acceptance, timing and later publication remain controlled by Google and the publisher.

## Localization and evidence

The interface uses English, Spanish, French, German, Portuguese, Italian, Galician and Catalan. Browser language is the default; Advanced settings provide a saved override. Reload Moodle pages after changing it. Portuguese browser variants use the Brazilian catalog. Unsupported locales fall back to English. Provider-level technical errors without a catalog entry retain their original diagnostic text. User-authored criteria, Moodle content, filenames and generated feedback are not machine-translated by the interface.

Screenshots show the actual unpacked extension running on a clearly labeled fictional Moodle-compatible grading fixture. They are not synthetic drawings of extension controls, a production Moodle qualification or student data. The fixture and capture workflow are reproducible with `npm run test:locales`. Capture metadata and file sizes are validated before bundling. The brand-only promotional graphics are generated from the existing extension icon, with no invented UI or model claims.

## Verified public URLs

On 20 October 2026, direct requests returned HTTP 200 for:

- https://moodlia.com/products/corrector/
- https://moodlia.com/privacy/corrector.html
- https://github.com/gafapa/moodlia-corrector/issues

Both extension-specific policies returned HTTP 200 and matched the website source byte for byte on 20 October 2026. Privacy review and private test credentials remain publisher responsibilities.

## Official references

- [Store listing fields](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Required image dimensions and screenshots](https://developer.chrome.com/docs/webstore/images)
- [User data and secure handling](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Limited Use policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use)

## Rebuild

Run `npm ci`, `npm run check`, `npm run test:browser`, `npm run test:locales`, `node scripts/generate-store-assets.mjs`, `node scripts/generate-store-listings.mjs`, `npm run package`, then `node scripts/package-store-kit.mjs` and `node scripts/generate-submission-page.mjs`. The latter extracts a missing submission folder without overwriting existing publisher edits and creates the English `index.html` copy-and-download page. Install the pinned Playwright Chromium first if unavailable. Tests use isolated temporary profiles and fictional data, not the user's open Moodle session.
