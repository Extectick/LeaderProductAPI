'use strict';

const statusElement = document.getElementById('status');
const downloadElement = document.getElementById('download');
const retryElement = document.getElementById('retry');
let checking = false;

async function downloadLatestApk() {
  if (checking) return;
  checking = true;
  retryElement.disabled = true;
  retryElement.hidden = true;
  downloadElement.hidden = true;
  downloadElement.removeAttribute('href');
  statusElement.textContent = 'Проверяем последнюю версию приложения…';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/updates/check?platform=android&channel=prod&versionCode=0', {
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
    });
    if (!response.ok) throw new Error('Update check unavailable');
    const result = await response.json();
    const update = result.data;
    if (!result.ok || !update?.updateAvailable || typeof update.downloadUrl !== 'string') {
      throw new Error('No published APK');
    }
    // The authenticated release publisher controls the API response; never use
    // a destination from the page query string or retain a previous signed URL.
    const url = new URL(update.downloadUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid download URL');
    downloadElement.href = url.href;
    downloadElement.hidden = false;
    statusElement.textContent = `Версия ${update.latestVersionName}. Скачивание начинается. Если оно не началось, нажмите «Скачать APK».`;
    window.location.assign(url.href);
  } catch {
    statusElement.textContent = 'Не удалось получить последнюю версию. Проверьте соединение и повторите попытку.';
  } finally {
    clearTimeout(timer);
    retryElement.disabled = false;
    retryElement.hidden = false;
    checking = false;
  }
}

retryElement.addEventListener('click', downloadLatestApk);
downloadLatestApk();
