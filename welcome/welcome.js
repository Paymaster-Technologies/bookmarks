/**
 * Onboarding after the first account connection.
 *
 * The page lives inside the extension, not on the site: this way it opens after
 * any sign-in method — Google, WebMoney, Telegram, email on the site and email
 * right in the popup — and doesn't require a frontend deploy.
 */

import { send } from '../shared/send.js';

document.getElementById('open-memo').addEventListener('click', async () => {
  try {
    const { siteOrigin } = await send('GET_SITE_URL');
    await chrome.tabs.create({ url: `${siteOrigin}/ru/home` });
  } catch {
    // An unavailable worker must not leave the button dead: there's nowhere to
    // get the environment URL from, but the user can still close the page
  }
});

document.getElementById('close').addEventListener('click', () => {
  window.close();
});
