/**
 * "About Third Wheel" pop-up: logo, name, version, copyright, licence, GitHub link,
 * credit, and the third-party licences (the shipped notices file) behind a button. Opened from
 * the app menu (macOS) / Help menu (Windows) via main. Texts live in `shared/about.ts`.
 */
import {
  APP_COPYRIGHT,
  APP_CREDIT,
  APP_LICENCE,
  APP_LICENCE_SHORT,
  APP_REPO_URL,
  shortVersion,
  versionLine,
} from '../../shared/about.js';
import { APP_DISPLAY_NAME } from '../../shared/app-name.js';

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} missing from index.html`);
  return found;
}

export interface About {
  open(): void;
}

export function setupAbout(): About {
  const api = window.thirdWheel;
  const dialog = el('about-dialog') as HTMLDialogElement;
  const notices = el('about-notices');
  const noticesText = el('about-notices-text');
  const licencesBtn = el('about-licences') as HTMLButtonElement;

  // Same logo as the toolbar brand (one copy of the SVG in index.html).
  const logo = document.querySelector('.brand-icon')?.cloneNode(true);
  if (logo instanceof SVGElement) {
    logo.setAttribute('class', 'about-logo');
    logo.setAttribute('width', '64');
    logo.setAttribute('height', '64');
    el('about-logo-slot').replaceChildren(logo);
  }
  el('about-title').textContent = APP_DISPLAY_NAME;
  el('about-copyright').textContent = APP_COPYRIGHT;
  el('about-licence').textContent = APP_LICENCE;
  const link = el('about-link') as HTMLAnchorElement;
  link.href = APP_REPO_URL;
  link.textContent = APP_REPO_URL.replace(/^https:\/\//, '');
  el('about-credit').textContent = APP_CREDIT;

  let loaded = false;
  let shown = false;
  const showNotices = (show: boolean): void => {
    shown = show;
    notices.hidden = !show;
    dialog.classList.toggle('about-wide', show);
    licencesBtn.textContent = show ? 'Hide licences' : 'Third-party licences';
    licencesBtn.setAttribute('aria-expanded', String(show));
    if (!show || loaded) return;
    noticesText.textContent = 'Loading…';
    if (!api) {
      noticesText.textContent = 'The licence list is only available in the app.';
      return;
    }
    api.getThirdPartyNotices().then(
      (text) => {
        loaded = true;
        noticesText.textContent = text;
      },
      (err: unknown) => {
        noticesText.textContent = `Couldn't read the licence list: ${err instanceof Error ? err.message : String(err)}`;
      },
    );
  };
  licencesBtn.addEventListener('click', () => {
    showNotices(!shown);
  });

  const open = (): void => {
    if (dialog.open) return;
    showNotices(false);
    el('about-version').textContent = '';
    void api?.getAppVersion().then((v) => {
      el('about-version').textContent = versionLine(v);
    });
    dialog.showModal();
  };
  api?.onShowAbout(open);

  // Start card: "v0.1.0 · Open source (Apache 2.0)"; the link opens in the browser.
  const startLink = el('empty-version-link') as HTMLAnchorElement;
  startLink.href = APP_REPO_URL;
  startLink.title = APP_REPO_URL;
  el('empty-version-licence').textContent = `(${APP_LICENCE_SHORT})`;
  void api?.getAppVersion().then((v) => {
    el('empty-version-number').textContent = shortVersion(v);
    el('empty-version').hidden = false; // shown once whole, never as " · Open source"
  });
  return { open };
}
