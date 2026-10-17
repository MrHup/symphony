// Lets the preview be installed as an app. It caches nothing, so every load shows the latest recipe.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
